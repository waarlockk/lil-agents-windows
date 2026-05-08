import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const characterBtn = document.getElementById('character');
const canvas = document.getElementById('canvas');
const bubble = document.getElementById('bubble');

characterBtn.style.setProperty('--character-color', window.lilAgents.color || '#ff6600');

// Renderer — transparent background so the window chrome shows through.
// premultipliedAlpha is left at the default (true) so the WebGL surface
// composites correctly with Electron's transparent window on Windows.
// Using false here confuses Chromium's GPU compositor and causes the
// transparent areas to render as solid black instead of see-through.
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000, 0);
renderer.setSize(window.innerWidth, window.innerHeight);
// ACESFilmic tone mapping makes textures look vibrant like Mixamo's viewer
// instead of the default flat/linear output which looks dull and washed out
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.8;  // Three.js r155+ uses physical light units — needs higher exposure
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 2000);
camera.position.set(0, 90, 300);
camera.lookAt(0, 90, 0);

// Three.js r155+ uses physical light units — intensities must be much higher
// than the old legacy system to achieve the same perceived brightness.
scene.add(new THREE.HemisphereLight(0xffeeff, 0x553322, 4));
const sun = new THREE.DirectionalLight(0xfff4e0, 6);
sun.position.set(2, 4, 3);
scene.add(sun);
// Soft fill from the front-left so the face/chest aren't in shadow
const fill = new THREE.DirectionalLight(0xffffff, 2);
fill.position.set(-1, 1, 2);
scene.add(fill);

// Animation state machine
const loader = new FBXLoader();
let model = null;
let modelBaseY = 0;   // world-space Y of the foot floor, calibrated once in init
let mixer = null;
const actions = {};
let currentAction = null;
let currentState = 'idle';
let currentDirection = 1; // 1 = right, -1 = left
// Extra Y offset applied after sit animation finishes (snaps feet to ground).
// Reset to 0 whenever the character leaves the sitting state.
let sitYSnap = 0;
let sitYSnapStart = 0;
let sitYSnapTarget = 0;
let sitYSnapTimer = 0;
let sitYSnapDuration = 0;
let globalCharH = 150;

const ANIM_FILES = {
  idle:   'idle.fbx',
  idle2:  'idle2.fbx',
  walk:   'walk.fbx',
  sit:    'sit.fbx',
  stand:  'stand.fbx',
  think:  'think.fbx',
  wave:   'wave.fbx',
  listen: 'listen.fbx',
  talk:   'talk.fbx',
};

function toUrl(winPath) {
  return `file:///${winPath.replace(/\\/g, '/')}`;
}

function loadFbx(url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

function transitionTo(state, fadeDur = 0.3) {
  const next = actions[state] ?? actions.idle;
  if (!next || next === currentAction) return;
  currentAction?.fadeOut(fadeDur);
  next.reset().fadeIn(fadeDur).play();
  currentAction = next;
  currentState = state;

  if (model) {
    if (state === 'walk') {
      // Side-facing while walking, direction sets which way
      model.rotation.y = currentDirection < 0 ? -Math.PI / 2 : Math.PI / 2;
    } else {
      // Front-facing for all other states
      model.rotation.y = 0;
    }

    // For locomotion states, we want to restore the calibrated foot-floor baseline.
    // For sitting and standing sequences, we KEEP the offset computed by snapSitToGround
    // to prevent sudden jumps if those specific animations have different root origins.
    if (state === 'walk' || state === 'idle' || state === 'idle2') {
      sitYSnapStart = sitYSnap;
      sitYSnapTarget = 0;
      sitYSnapTimer = 0;
      sitYSnapDuration = fadeDur || 0.01;
    } else {
      sitYSnapStart = sitYSnap;
      sitYSnapTarget = sitYSnap; // Hold the correction!
      sitYSnapTimer = 0;
      sitYSnapDuration = fadeDur || 0.01;
    }
  }
}

// After the sit animation clamps to its final frame, measure the actual
// minimum world-space Y of every skinned-mesh vertex (SkinnedMesh.getVertexPosition
// applies the full bone-weight deformation on CPU so we get the real pose
// geometry, not the bind-pose geometry).  Shift model.position.y down by that
// amount so the lowest point of the posed mesh sits exactly at Y = 0 — the
// ground plane the camera was calibrated against.
//
// Must be called one render frame after the 'finished' event so the mixer has
// already committed the final frame's bone matrices to the skeleton.
function snapSitToGround() {
  if (!model) return;
  model.updateMatrixWorld(true);

  let targetBone = null;
  model.traverse((child) => {
    if (child.isBone && !targetBone) {
      const name = child.name.toLowerCase();
      if (name.includes('hips') || name.includes('pelvis') || name.includes('spine') || name.includes('root')) {
        targetBone = child;
      }
    }
  });
  if (!targetBone) {
    model.traverse((child) => {
      if (child.isBone && !targetBone) targetBone = child;
    });
  }

  let hipsX = 0, hipsY = 0, hipsZ = 0;
  if (targetBone) {
    const hw = new THREE.Vector3();
    targetBone.getWorldPosition(hw);
    hipsX = hw.x;
    hipsY = hw.y;
    hipsZ = hw.z;
  }

  // The "seat" (buttocks/thighs) is directly under and around the hips.
  // We use a tight horizontal radius (15% of height) and a strict vertical
  // lower limit (10% of height below the hips).
  // This aggressively filters out dangling feet, cloth, and invisible meshes
  // so we ONLY snap the actual body mass that should be resting on the taskbar.
  const radiusSq = targetBone ? (globalCharH * 0.15) ** 2 : Infinity;
  const lowerLimit = targetBone ? hipsY - (globalCharH * 0.10) : -Infinity;

  let minY = Infinity;
  const v = new THREE.Vector3();

  model.traverse((child) => {
    if (!child.isSkinnedMesh || !child.visible) return;
    const pos = child.geometry?.attributes?.position;
    if (!pos) return;
    
    // Check materials to ignore invisible collision meshes
    if (child.material) {
      if (Array.isArray(child.material)) {
        if (child.material.every(m => m.opacity === 0 || m.visible === false)) return;
      } else {
        if (child.material.opacity === 0 || child.material.visible === false) return;
      }
    }

    const step = Math.max(1, Math.floor(pos.count / 500));
    for (let i = 0; i < pos.count; i += step) {
      child.getVertexPosition(i, v);   // applies skinning → local space
      v.applyMatrix4(child.matrixWorld); // local → world space
      
      if (targetBone) {
        const dx = v.x - hipsX;
        const dz = v.z - hipsZ;
        if (dx * dx + dz * dz > radiusSq) continue;
        if (v.y < lowerLimit) continue;
      }

      if (v.y < minY) minY = v.y;
    }
  });

  if (!isFinite(minY)) {
    console.log('[lil-agents] sit ground-snap: no valid vertices found');
    return;
  }

  // minY is the lowest mesh point in world space (filtered).
  // Shift the model group so that lowest point lands at exactly Y = 0.
  sitYSnap = -minY;
  sitYSnapStart = sitYSnap;
  sitYSnapTarget = sitYSnap;
  model.position.y = modelBaseY + sitYSnap;
  console.log(`[lil-agents] sit ground-snap: hipsY=${hipsY.toFixed(1)}, lowestVert=${minY.toFixed(1)}, shifted by ${sitYSnap.toFixed(1)}`);
}

async function init() {
  const dir = window.lilAgents.characterAssetsDir;
  if (!dir) return;
  const base = toUrl(dir);

  try {
    model = await loadFbx(`${base}/model.fbx`);
  } catch {
    console.warn('[lil-agents] No model found at', base, '— drop Mixamo FBX files into assets/characters/');
    return;
  }

  scene.add(model);
  model.updateMatrixWorld(true);

  // Compute bounding box from visible mesh geometry only.
  // Box3.setFromObject() includes bone/skeleton-helper positions which can
  // massively inflate the box and make the camera look at empty space.
  const meshBox = new THREE.Box3();
  const _v = new THREE.Vector3();
  model.traverse((child) => {
    if ((child.isMesh || child.isSkinnedMesh) && child.geometry?.attributes?.position) {
      const pos = child.geometry.attributes.position;
      const mat = child.matrixWorld;
      for (let i = 0; i < pos.count; i++) {
        meshBox.expandByPoint(_v.fromBufferAttribute(pos, i).applyMatrix4(mat));
      }
    }
  });
  if (meshBox.isEmpty()) meshBox.setFromObject(model); // fallback

  const size = meshBox.getSize(new THREE.Vector3());
  model.position.y -= meshBox.min.y;
  modelBaseY = model.position.y;   // record foot-floor so we can lock it each frame

  const charH = size.y;
  globalCharH = charH;
  const aspect = window.innerWidth / window.innerHeight;

  // ── Camera geometry ──────────────────────────────────────────────────────
  // main.js positions the window so the bottom 13 % of the canvas sits behind
  // the taskbar (verticalTaskbarOverlap).  For the feet to rest on the taskbar
  // edge they must appear at the right fraction down the canvas.
  //
  // Camera geometry (perspective, vertical FOV):
  //   feetFrac = 0.5 + eyeH / (2 · halfH)   where halfH = dist · tan(halfFovV)
  //
  // The 13 % base overlap is height-relative, so the target fraction is the
  // same for every window size: 1 − 0.13 ≈ 0.87.  (0.85 was calibrated for
  // the old 155 px window; at 600 px it left the feet 9 px above the taskbar.)
  const TARGET_FEET_FRAC = 0.87;
  const eyeRatio = 2 * (TARGET_FEET_FRAC - 0.5);          // 0.70

  const halfFovV = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfFovH = Math.atan(Math.tan(halfFovV) * aspect);

  const minHalfH     = (charH * 1.35) / (1 + eyeRatio);   // charH * 0.721
  const distForHeight = minHalfH / Math.tan(halfFovV);

  // Walking: model rotated 90°.  Use the larger horizontal dim + 50 % margin
  // so arm swings that exceed the T-pose bounds don't clip the sides.
  const maxSideDim   = Math.max(size.x, size.z);
  const distForDepth  = (maxSideDim * 1.5) / Math.tan(halfFovH);

  const dist  = Math.max(distForHeight, distForDepth);
  const halfH = dist * Math.tan(halfFovV);

  // eyeH derived from the ratio so feet always land at TARGET_FEET_FRAC.
  // Cap at 88 % of charH so the camera never drifts above the shoulders.
  const eyeH = Math.min(eyeRatio * halfH, charH * 0.88);

  camera.near = dist * 0.001;
  camera.far  = dist * 4;
  camera.position.set(0, eyeH, dist);
  camera.lookAt(0, eyeH, 0);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();

  mixer = new THREE.AnimationMixer(model);
  mixer.addEventListener('finished', (e) => {
    const done = Object.entries(actions).find(([, a]) => a === e.action)?.[0];
    if (!done) return;

    if (done === 'sit') {
      // Defer by one render frame so the mixer has committed the final-frame
      // bone matrices before we sample vertex positions for ground-snapping.
      requestAnimationFrame(() => {
        snapSitToGround();
        window.lilAgents.animationDone('sit');
      });
      return;
    }

    // For all other one-shots (wave, stand) notify main.js immediately.
    window.lilAgents.animationDone(done);
  });

  // Load all animation FBX files in parallel
  const loads = Object.entries(ANIM_FILES).map(async ([state, file]) => {
    try {
      const fbx = await loadFbx(`${base}/${file}`);
      return [state, fbx.animations[0] ?? null];
    } catch {
      return [state, null];
    }
  });

  for (const [state, clip] of await Promise.all(loads)) {
    if (!clip) continue;

    // Strip the Hips bone Y-position track from looping animations.
    // Mixamo looping clips (walk, idle, think …) include a subtle Y drift on
    // the root bone that accumulates across state transitions, causing the
    // character to float upward permanently.  Rotations alone drive all the
    // visible motion for these clips.
    //
    // sit and stand MUST keep their Hips Y track: that is what physically
    // lowers/raises the body into the seated pose.  Stripping it would leave
    // the legs bending in mid-air while the torso stays at standing height.
    const isTransition = state === 'sit' || state === 'stand';

    // Diagnostic: log all track names for sit/stand to verify the Hips
    // position track is present and correctly named.
    if (isTransition) {
      console.log(`[lil-agents] ${state} clip tracks (${clip.tracks.length}):`);
      for (const t of clip.tracks) {
        const isHipsPos = t.name.toLowerCase().includes('hips') && t.name.endsWith('.position');
        console.log(`  ${isHipsPos ? '✓HIPS-Y' : '       '} ${t.name}`);
      }
    }

    if (!isTransition) {
      clip.tracks = clip.tracks.filter(
        (t) => !(t.name.toLowerCase().includes('hips') && t.name.endsWith('.position'))
      );
    }

    const action = mixer.clipAction(clip);
    // sit and stand are one-shot transitions; wave is a one-shot celebration.
    // clampWhenFinished keeps the last frame (important for sit so the model
    // holds the seated pose until stand is triggered).
    if (state === 'wave' || state === 'sit' || state === 'stand') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions[state] = action;
  }

  if (actions.idle) {
    actions.idle.play();
    currentAction = actions.idle;
  }

  if (window.lilAgents.ready) {
    window.lilAgents.ready();
  }
}

// Render loop
const clock = new THREE.Clock();
(function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  mixer?.update(delta);
  
  if (sitYSnapTimer < sitYSnapDuration && model) {
    sitYSnapTimer += delta;
    const t = Math.min(1, sitYSnapTimer / sitYSnapDuration);
    sitYSnap = sitYSnapStart + (sitYSnapTarget - sitYSnapStart) * t;
    model.position.y = modelBaseY + sitYSnap;
  }

  renderer.render(scene, camera);
})();

init();

// IPC handlers
characterBtn.addEventListener('click', () => {
  window.lilAgents.clickCharacter(window.lilAgents.characterName);
});

window.lilAgents.onDirection((dir) => {
  currentDirection = dir;
  // Only apply sideways rotation while actively walking
  if (currentState === 'walk' && model) {
    model.rotation.y = dir < 0 ? -Math.PI / 2 : Math.PI / 2;
  }
});

window.lilAgents.onState((state) => transitionTo(state));

window.lilAgents.onBubble((payload) => {
  if (!payload) {
    bubble.classList.add('hidden');
    bubble.textContent = '';
    bubble.dataset.kind = '';
    return;
  }
  bubble.textContent = payload.text;
  bubble.dataset.kind = payload.kind;
  bubble.classList.remove('hidden');
});

window.lilAgents.onSound((soundPath) => {
  const audio = new Audio(`file:///${soundPath.replace(/\\/g, '/')}`);
  audio.volume = 0.55;
  audio.play().catch(() => {});
});
