const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

const providers = {
  claude: {
    displayName: 'Claude',
    binary: 'claude',
    install: 'Install Claude Code from https://claude.ai/download',
    mode: 'stream-json',
    args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose']
  },
  codex: {
    displayName: 'Codex',
    binary: 'codex',
    install: 'Install Codex with: npm install -g @openai/codex',
    mode: 'exec-json'
  },
  chatgpt: {
    displayName: 'ChatGPT',
    mode: 'api'
  }
};

const characterSizes = {
  small: { label: 'Small', height: 330 },
  medium: { label: 'Medium', height: 465 },
  large: { label: 'Large', height: 600 }
};

const themes = {
  peach: {
    label: 'Peach',
    vars: {
      '--popover-bg': 'rgba(255, 248, 238, 0.97)',
      '--popover-border': 'rgba(230, 108, 128, 0.8)',
      '--title-bg': 'rgba(250, 237, 224, 1)',
      '--title-text': 'rgb(214, 84, 105)',
      '--text-primary': 'rgb(42, 36, 44)',
      '--text-dim': 'rgb(118, 108, 120)',
      '--input-bg': 'rgba(255, 255, 255, 0.72)',
      '--tool': 'rgb(214, 84, 105)',
      '--error': 'rgb(220, 70, 50)',
      '--success': 'rgb(58, 176, 112)'
    }
  },
  midnight: {
    label: 'Midnight',
    vars: {
      '--popover-bg': 'rgba(18, 18, 17, 0.96)',
      '--popover-border': 'rgba(255, 103, 31, 0.65)',
      '--title-bg': 'rgba(28, 28, 26, 0.98)',
      '--title-text': 'rgb(255, 103, 31)',
      '--text-primary': 'rgba(255, 255, 255, 0.9)',
      '--text-dim': 'rgba(255, 255, 255, 0.58)',
      '--input-bg': 'rgba(255, 255, 255, 0.08)',
      '--tool': 'rgb(255, 161, 102)',
      '--error': 'rgb(255, 105, 91)',
      '--success': 'rgb(95, 205, 120)'
    }
  },
  cloud: {
    label: 'Cloud',
    vars: {
      '--popover-bg': 'rgba(240, 244, 248, 0.98)',
      '--popover-border': 'rgba(82, 142, 205, 0.42)',
      '--title-bg': 'rgba(222, 229, 237, 1)',
      '--title-text': 'rgb(42, 88, 140)',
      '--text-primary': 'rgb(30, 35, 46)',
      '--text-dim': 'rgb(96, 104, 118)',
      '--input-bg': 'rgba(255, 255, 255, 0.92)',
      '--tool': 'rgb(38, 118, 198)',
      '--error': 'rgb(206, 60, 50)',
      '--success': 'rgb(48, 160, 80)'
    }
  },
  moss: {
    label: 'Moss',
    vars: {
      '--popover-bg': 'rgba(210, 214, 198, 0.98)',
      '--popover-border': 'rgba(92, 98, 78, 0.76)',
      '--title-bg': 'rgba(184, 192, 172, 1)',
      '--title-text': 'rgb(36, 42, 28)',
      '--text-primary': 'rgb(26, 31, 20)',
      '--text-dim': 'rgb(82, 88, 70)',
      '--input-bg': 'rgba(226, 230, 216, 1)',
      '--tool': 'rgb(55, 82, 46)',
      '--error': 'rgb(145, 44, 30)',
      '--success': 'rgb(42, 112, 48)'
    }
  }
};

let selectedProvider = 'codex';
let selectedTheme = 'midnight';
let selectedSize = 'large';
let selectedDisplayId = 'auto';
let soundsEnabled = true;
let tray = null;
let tickTimer = null;
let onboardingActive = false;
const characters = [];
const sessions = new Map();
const binaryCache = new Map();

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function updateSettings(patch) {
  saveSettings({ ...loadSettings(), ...patch });
}

function characterAssetsDir(name) {
  const perChar = path.join(appRoot, 'assets', 'characters', name.toLowerCase());
  const shared  = path.join(appRoot, 'assets', 'characters');
  // Use per-character folder if it exists, otherwise fall back to shared
  return fs.existsSync(perChar) ? perChar : shared;
}

function soundPaths() {
  const dir = path.join(repoRoot, 'LilAgents', 'Sounds');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => /^ping-.*\.(mp3|m4a)$/i.test(file))
    .map((file) => path.join(dir, file));
}

function iconPath() {
  const candidates = [
    path.join(repoRoot, 'LilAgents', 'menuicon-2x.png'),
    path.join(repoRoot, 'LilAgents', 'menuicon.png'),
    path.join(repoRoot, 'LilAgents', 'Assets.xcassets', 'MenuBarIcon.imageset', 'bubble-icon.png')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function providerEnv() {
  const env = {
    ...process.env,
    PATH: [
      process.env.PATH || '',
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.claude', 'local', 'bin')
    ].filter(Boolean).join(path.delimiter),
    TERM: 'dumb'
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function findBinary(name) {
  if (binaryCache.has(name)) return Promise.resolve(binaryCache.get(name));
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    execFile(cmd, [name], { env: providerEnv(), windowsHide: true }, (error, stdout) => {
      const found = normalizeBinaryPath(name, error ? null : stdout.split(/\r?\n/).filter(Boolean));
      binaryCache.set(name, found);
      resolve(found);
    });
  });
}

function normalizeBinaryPath(name, foundPaths) {
  const candidates = [];
  if (Array.isArray(foundPaths)) candidates.push(...foundPaths);

  if (process.platform === 'win32') {
    const pathEntries = (providerEnv().PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathEntries) {
      candidates.push(
        path.join(dir, `${name}.cmd`),
        path.join(dir, `${name}.exe`),
        path.join(dir, `${name}.bat`),
        path.join(dir, name)
      );
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = process.platform === 'win32'
      ? preferWindowsExecutableShim(candidate)
      : candidate;
    if (normalized && fs.existsSync(normalized)) return normalized;
  }
  return null;
}

function preferWindowsExecutableShim(candidate) {
  const ext = path.extname(candidate).toLowerCase();
  if (ext === '.cmd' || ext === '.exe' || ext === '.bat') return candidate;
  for (const suffix of ['.cmd', '.exe', '.bat']) {
    const withSuffix = `${candidate}${suffix}`;
    if (fs.existsSync(withSuffix)) return withSuffix;
  }
  return fs.existsSync(candidate) ? candidate : null;
}

function spawnCli(binary, args, options) {
  const ext = process.platform === 'win32' ? path.extname(binary).toLowerCase() : '';
  if (ext === '.cmd' || ext === '.bat') {
    const shimTarget = npmShimTarget(binary);
    if (shimTarget) {
      return spawn(nodeForShim(binary), [shimTarget, ...args], {
        ...options,
        windowsHide: true
      });
    }
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', wrapCmdCommand([binary, ...args])], {
      ...options,
      windowsHide: true
    });
  }
  return spawn(binary, args, {
    ...options,
    windowsHide: true
  });
}

function quoteCmdCommand(parts) {
  return parts.map(quoteCmdArg).join(' ');
}

function wrapCmdCommand(parts) {
  return `"${quoteCmdCommand(parts)}"`;
}

function quoteCmdArg(value) {
  const text = String(value).replace(/\r?\n/g, '\n');
  return `"${text.replace(/(["^&|<>%])/g, '^$1')}"`;
}

function npmShimTarget(binary) {
  if (!fs.existsSync(binary)) return null;
  const content = fs.readFileSync(binary, 'utf8');
  const match = content.match(/node_modules[\\/][^"]+?\.js/i);
  if (!match) return null;
  const target = path.join(path.dirname(binary), ...match[0].split(/[\\/]/));
  return fs.existsSync(target) ? target : null;
}

function nodeForShim(binary) {
  const localNode = path.join(path.dirname(binary), 'node.exe');
  return fs.existsSync(localNode) ? localNode : 'node';
}

function currentThemePayload() {
  return { key: selectedTheme, ...themes[selectedTheme] };
}

function applySavedSettings() {
  const settings = loadSettings();
  if (providers[settings.selectedProvider]) selectedProvider = settings.selectedProvider;
  if (themes[settings.selectedTheme]) selectedTheme = settings.selectedTheme;
  if (characterSizes[settings.selectedSize]) selectedSize = settings.selectedSize;
  if (typeof settings.selectedDisplayId === 'string') selectedDisplayId = settings.selectedDisplayId;
  if (typeof settings.soundsEnabled === 'boolean') soundsEnabled = settings.soundsEnabled;
}

function characterDimensions() {
  const height = characterSizes[selectedSize].height;
  return { width: Math.round(height * 0.5625), height };
}

function verticalTaskbarOverlap(char) {
  // The source videos include transparent padding below the visible feet.
  // Lower the transparent window into the taskbar so the drawn feet sit on it.
  return Math.round(char.height * 0.13) + (char.footNudge || 0);
}

function displayHasTaskbarReserve(display) {
  const { bounds, workArea } = display;
  return bounds.x !== workArea.x ||
    bounds.y !== workArea.y ||
    bounds.width !== workArea.width ||
    bounds.height !== workArea.height;
}

function activeDisplay() {
  const displays = screen.getAllDisplays();
  if (selectedDisplayId !== 'auto') {
    const pinned = displays.find((display) => String(display.id) === selectedDisplayId);
    if (pinned) return pinned;
  }
  const withTaskbar = displays.find(displayHasTaskbarReserve);
  if (withTaskbar) return withTaskbar;
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
}

function taskbarEdge(display) {
  const { bounds, workArea } = display;
  if (workArea.y > bounds.y) return 'top';
  if (workArea.x > bounds.x) return 'left';
  if (workArea.x + workArea.width < bounds.x + bounds.width) return 'right';
  return 'bottom';
}

function taskbarGeometry(display) {
  const { bounds, workArea } = display;
  const edge = taskbarEdge(display);
  const leftReserve = workArea.x - bounds.x;
  const topReserve = workArea.y - bounds.y;
  const rightReserve = (bounds.x + bounds.width) - (workArea.x + workArea.width);
  const bottomReserve = (bounds.y + bounds.height) - (workArea.y + workArea.height);

  if (edge === 'top') {
    return {
      edge,
      line: workArea.y,
      thickness: Math.max(topReserve, 1),
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: Math.max(topReserve, 1)
    };
  }
  if (edge === 'left') {
    return {
      edge,
      line: workArea.x,
      thickness: Math.max(leftReserve, 1),
      x: bounds.x,
      y: bounds.y,
      width: Math.max(leftReserve, 1),
      height: bounds.height
    };
  }
  if (edge === 'right') {
    return {
      edge,
      line: workArea.x + workArea.width,
      thickness: Math.max(rightReserve, 1),
      x: workArea.x + workArea.width,
      y: bounds.y,
      width: Math.max(rightReserve, 1),
      height: bounds.height
    };
  }
  return {
    edge,
    line: workArea.y + workArea.height,
    thickness: Math.max(bottomReserve, 1),
    x: bounds.x,
    y: workArea.y + workArea.height,
    width: bounds.width,
    height: Math.max(bottomReserve, 1)
  };
}

function walkingTrack(display, char) {
  const taskbar = taskbarGeometry(display);
  const horizontal = taskbar.edge === 'top' || taskbar.edge === 'bottom';
  const usableLength = horizontal ? taskbar.width : taskbar.height;
  const charLength = horizontal ? char.width : char.height;
  // No inset — character walks all the way to the screen edge so it can sit there.
  // The old 12 % inset was a safety margin for random walking; it is no longer needed.
  const start = horizontal ? taskbar.x : taskbar.y;
  const length = usableLength;
  return { taskbar, horizontal, start, length };
}

function shouldShowCharacters(display) {
  if (selectedDisplayId !== 'auto') return true;
  if (displayHasTaskbarReserve(display)) return true;
  return false;
}

function createCharacter(config) {
  const size = characterDimensions();
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000', // required on Windows for correct GPU alpha compositing
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      additionalArguments: [
        `--character=${config.name}`,
        `--char-assets=${characterAssetsDir(config.name)}`,
        `--color=${config.color}`
      ]
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'character.html'));
  win.once('ready-to-show', () => {
    // Call setBackgroundColor after the native window surface exists — this
    // nudges the GPU compositor into transparent mode on Windows even when
    // the constructor backgroundColor alone doesn't take effect.
    win.setBackgroundColor('#00000000');
    win.showInactive();
  });

  const state = {
    ...config,
    ...size,
    win,
    visible: true,
    progress: config.progress,
    direction: config.direction,
    // Phase-based state machine:
    //   loading → greeting → walk-to-edge → sitting → standing →
    //   walk-from-edge → interacting → idling → walk-to-edge → …
    phase: 'loading',
    sittingEdge: 'right',   // which edge the character sat at
    idleUntil: 0,           // timestamp: when to leave idling and walk to edge
    standTimeout: null,     // fallback timer if stand anim is missing
    pendingPopup: false,    // open popup once walk-from-edge completes
    busy: false,
    voiceState: null,
    completionUntil: 0,
    bubbleText: '',
    walkStart: 0,
    walkDuration: 5000,
    walkFrom: config.progress,
    walkTo: config.progress,
    popover: null
  };
  characters.push(state);

  return state;
}

function easeWalk(t) {
  // Ease-out: window moves immediately when the walk starts (no slow lead-in),
  // then decelerates smoothly so it doesn't snap to a hard stop.
  return 1 - Math.pow(1 - t, 2);
}

// ── Phase helpers ─────────────────────────────────────────────────────────────

function charByWebContents(wc) {
  return characters.find((c) => c.win.webContents === wc);
}

function sendRandomIdle(char) {
  char.win.webContents.send('character:state', Math.random() < 0.5 ? 'idle' : 'idle2');
}

/** Begin walking toward the right screen edge to sit down. */
function startWalkToEdge(char) {
  clearTimeout(char.standTimeout);
  char.phase = 'walk-to-edge';
  const goRight = true;          // always walk to the right edge
  char.sittingEdge = 'right';
  char.direction   = 1;
  char.walkFrom    = char.progress;
  char.walkTo      = goRight ? 1 : 0;
  char.walkStart   = Date.now();
  const dist = Math.abs(char.walkTo - char.walkFrom);
  char.walkDuration = Math.max(1000, Math.round((dist / 0.06) * 1000));
  char.win.webContents.send('character:direction', char.direction);
  char.win.webContents.send('character:state', 'walk');
}

/** Sit the character down at the edge. */
function sitCharacter(char) {
  char.phase = 'sitting';
  char.win.webContents.send('character:state', 'sit');
}

/** Trigger the stand-up animation; fallback timer advances phase if anim is missing. */
function standCharacter(char) {
  char.phase = 'standing';
  char.win.webContents.send('character:state', 'stand');
  clearTimeout(char.standTimeout);
  char.standTimeout = setTimeout(() => {
    if (char.phase === 'standing') startWalkFromEdge(char);
  }, 2500);
}

/** Walk 10–50 % of the track back toward the center after standing. */
function startWalkFromEdge(char) {
  clearTimeout(char.standTimeout);
  char.phase     = 'walk-from-edge';
  const toward   = char.sittingEdge === 'right' ? -1 : 1;
  char.direction = toward;
  char.walkFrom  = char.progress;
  const amount   = 0.1 + Math.random() * 0.4;
  char.walkTo    = Math.max(0.05, Math.min(0.95, char.progress + amount * toward));
  char.walkStart = Date.now();
  const dist = Math.abs(char.walkTo - char.walkFrom);
  char.walkDuration = Math.max(1000, Math.round((dist / 0.06) * 1000));
  char.win.webContents.send('character:direction', char.direction);
  char.win.webContents.send('character:state', 'walk');
}

/** Enter the stationary idle phase; after 15–30 s the character walks to an edge. */
function startIdling(char) {
  char.phase     = 'idling';
  char.idleUntil = Date.now() + 15000 + Math.random() * 15000;
  sendRandomIdle(char);
}

/** Open the popup, or start the stand-up sequence if the character is sitting. */
function requestPopup(char) {
  if (!char) return;
  if (char.phase === 'sitting') {
    char.pendingPopup = true;
    standCharacter(char);
  } else {
    createPopover(char);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function startWalk(char) {
  char.walking = true;
  char.walkStart = Date.now();
  char.walkFrom = char.progress;
  if (char.progress > 0.85) char.direction = -1;
  else if (char.progress < 0.15) char.direction = 1;
  else char.direction = Math.random() > 0.5 ? 1 : -1;
  const amount = 0.25 + Math.random() * 0.35;
  char.walkTo = Math.max(0, Math.min(1, char.walkFrom + amount * char.direction));
  const actualAmount = Math.abs(char.walkTo - char.walkFrom);
  // Duration scales with distance so speed stays consistent (~6% of track/sec)
  char.walkDuration = Math.round((actualAmount / 0.06) * 1000);
  char.win.webContents.send('character:direction', char.direction);
  char.win.webContents.send('character:state', 'walk');
}

function pauseWalk(char, min = 4000, spread = 8000) {
  char.walking = false;
  char.pausedUntil = Date.now() + min + Math.random() * spread;
  char.win.webContents.send('character:state', 'idle');
}

function thinkingPhrase() {
  const phrases = ['thinking...', 'one sec...', 'working on it', 'reading...', 'on it!', 'checking...', 'almost...'];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function completionPhrase() {
  const phrases = ['done!', 'all set!', 'ready!', 'finished!', 'here you go'];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function setBubble(char, text, kind = 'thinking') {
  char.bubbleText = text;
  char.win.webContents.send('character:bubble', { text, kind });
}

function clearBubble(char) {
  if (char.voiceState) return;
  char.bubbleText = '';
  char.win.webContents.send('character:bubble', null);
}

function updateBusyBubble(char) {
  if (!char.busy || (char.popover && !char.popover.isDestroyed())) return;
  if (!char.bubbleText || Math.random() < 0.01) setBubble(char, thinkingPhrase(), 'thinking');
}

function playCompletionSound(char) {
  if (!soundsEnabled) return;
  const sounds = soundPaths();
  if (sounds.length === 0) return;
  const sound = sounds[Math.floor(Math.random() * sounds.length)];
  char.win.webContents.send('character:sound', sound);
}

function showCompletion(char) {
  char.busy = false;
  char.completionUntil = Date.now() + 3000;
  playCompletionSound(char);
  if (!char.voiceState && (!char.popover || char.popover.isDestroyed())) {
    setBubble(char, completionPhrase(), 'complete');
  }
  // Don't wave while seated — it looks wrong; bubble + sound are enough.
  if (char.phase === 'sitting') return;
  char.win.webContents.send('character:state', 'wave');
  // anim-done 'wave' will handle what comes next (see ipcMain handler below)
}

function setVoiceState(characterName, active, text, kind = 'speaking') {
  const char = charByName(characterName);
  if (!char) return;
  char.voiceState = active ? { text, kind } : null;
  if (active) {
    setBubble(char, text, kind);
    if (kind === 'listening') char.win.webContents.send('character:state', 'listen');
    else if (kind === 'speaking') char.win.webContents.send('character:state', 'talk');
    return;
  }
  if (char.busy) {
    char.win.webContents.send('character:state', 'think');
    if (!char.popover || char.popover.isDestroyed()) setBubble(char, thinkingPhrase(), 'thinking');
    return;
  }
  if (Date.now() < char.completionUntil) {
    if (!char.popover || char.popover.isDestroyed()) setBubble(char, completionPhrase(), 'complete');
    return;
  }
  char.win.webContents.send('character:state', 'idle');
  clearBubble(char);
}

function applySizeToCharacters() {
  const size = characterDimensions();
  for (const char of characters) {
    char.width = size.width;
    char.height = size.height;
    char.win.setBounds({ ...char.win.getBounds(), width: size.width, height: size.height }, false);
    if (char.popover && !char.popover.isDestroyed()) positionPopover(char);
  }
}

function positionPopover(char) {
  if (!char.popover || char.popover.isDestroyed()) return;
  const bounds = char.win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const width = 430;
  const height = 330;
  const x = Math.max(
    display.workArea.x + 8,
    Math.min(bounds.x + bounds.width / 2 - width / 2, display.workArea.x + display.workArea.width - width - 8)
  );
  const y = Math.max(display.workArea.y + 8, bounds.y - height + 18);
  char.popover.setBounds({ x: Math.round(x), y: Math.round(y), width, height }, false);
}

function updateCharacters() {
  const display = activeDisplay();
  const show = shouldShowCharacters(display);

  for (const char of characters) {
    if (!show) {
      if (char.visible) {
        char.win.hide();
        if (char.popover && !char.popover.isDestroyed()) char.popover.hide();
        char.visible = false;
      }
      continue;
    }
    if (!char.visible) {
      char.visible = true;
      char.win.showInactive();
      if (char.popover && !char.popover.isDestroyed()) char.popover.show();
    }

    if (Date.now() > char.completionUntil && !char.busy) clearBubble(char);
    updateBusyBubble(char);

    if (char.popover && !char.popover.isDestroyed()) {
      positionPopover(char);
      continue;
    }

    const track = walkingTrack(display, char);
    const { taskbar } = track;
    const travelLength = Math.max(0, track.length - (track.horizontal ? char.width : char.height));

    const now = Date.now();
    const isWalkPhase = char.phase === 'walk-to-edge' || char.phase === 'walk-from-edge';
    if (isWalkPhase) {
      const elapsed = now - char.walkStart;
      const t = Math.min(1, elapsed / char.walkDuration);
      const p = easeWalk(t);
      char.progress = char.walkFrom + (char.walkTo - char.walkFrom) * p;
      if (t >= 1) {
        if (char.phase === 'walk-to-edge') {
          sitCharacter(char);
        } else {
          // walk-from-edge finished: open pending popup or start idling
          char.phase = 'interacting';
          sendRandomIdle(char);
          if (char.pendingPopup) {
            char.pendingPopup = false;
            createPopover(char);
          }
        }
      }
    } else if (char.phase === 'idling' && now >= char.idleUntil) {
      startWalkToEdge(char);
    }

    let x;
    let y;
    if (taskbar.edge === 'left') {
      x = Math.round(taskbar.line + 4);
      y = Math.round(track.start + travelLength * char.progress);
    } else if (taskbar.edge === 'right') {
      x = Math.round(taskbar.line - char.width - 4);
      y = Math.round(track.start + travelLength * char.progress);
    } else {
      if (char.phase === 'sitting') {
        // When seated, snap directly to the screen edge so the visible model
        // body touches it regardless of canvas-transparency margins.
        // 'right' edge: character window right = screen right edge.
        // 'left' edge: character window left  = screen left  edge.
        x = char.sittingEdge === 'right'
          ? Math.round(taskbar.x + taskbar.width - char.width)
          : Math.round(taskbar.x);
      } else {
        x = Math.round(track.start + travelLength * char.progress);
      }
      y = taskbar.edge === 'top'
        ? Math.round(taskbar.line - verticalTaskbarOverlap(char))
        : Math.round(taskbar.line - char.height + verticalTaskbarOverlap(char));
    }
    char.win.setBounds({ x, y, width: char.width, height: char.height }, false);
  }
}

function createPopover(char) {
  if (!char) return;
  if (onboardingActive) return createOnboardingPopover(char);
  if (char.popover && !char.popover.isDestroyed()) {
    char.popover.close();
    char.popover = null;
    return;
  }

  char.phase = 'interacting';
  clearBubble(char);
  const popover = new BrowserWindow({
    width: 430,
    height: 330,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--character=${char.name}`]
    }
  });
  char.popover = popover;
  popover.setAlwaysOnTop(true, 'screen-saver');
  positionPopover(char);
  popover.loadFile(path.join(__dirname, 'terminal.html'));
  popover.once('ready-to-show', () => popover.show());
  popover.on('closed', () => {
    char.popover = null;
    if (char.busy) {
      // AI still processing after popup closed; idle cycle starts once it finishes
      setBubble(char, thinkingPhrase(), 'thinking');
      return;
    }
    startIdling(char);
  });
}

function triggerOnboarding() {
  const settings = loadSettings();
  if (settings.hasCompletedOnboarding) return;
  const goku = charByName('Goku');
  if (!goku) return;
  onboardingActive = true;
  setTimeout(() => {
    if (!onboardingActive) return;
    setBubble(goku, 'hi!', 'complete');
    playCompletionSound(goku);
  }, 1800);
}

function createOnboardingPopover(char) {
  if (char.popover && !char.popover.isDestroyed()) {
    char.popover.close();
    return;
  }
  char.phase = 'interacting';
  clearBubble(char);
  const popover = new BrowserWindow({
    width: 430,
    height: 330,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--character=${char.name}`, '--onboarding=1']
    }
  });
  char.popover = popover;
  popover.setAlwaysOnTop(true, 'screen-saver');
  positionPopover(char);
  popover.loadFile(path.join(__dirname, 'terminal.html'));
  popover.once('ready-to-show', () => popover.show());
  popover.on('closed', () => {
    char.popover = null;
    completeOnboarding();
    startIdling(char);
  });
}

function completeOnboarding() {
  if (!onboardingActive) return;
  onboardingActive = false;
  updateSettings({ hasCompletedOnboarding: true });
  for (const char of characters) clearBubble(char);
}

async function ensureProvider(providerKey) {
  const provider = providers[providerKey];
  if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
  if (provider.mode === 'api') return { provider, binary: null };
  const binary = await findBinary(provider.binary);
  if (!binary) throw new Error(`${provider.displayName} CLI not found.\n\n${provider.install}`);
  return { provider, binary };
}

function sessionKey(characterName, providerKey) {
  return `${characterName}:${providerKey}`;
}

function charByName(name) {
  return characters.find((item) => item.name === name);
}

function markBusy(characterName) {
  const char = charByName(characterName);
  if (!char) return;
  char.busy = true;
  char.completionUntil = 0;
  char.win.webContents.send('character:state', 'think');
  if (!char.popover || char.popover.isDestroyed()) setBubble(char, thinkingPhrase(), 'thinking');
}

function markComplete(characterName) {
  const char = charByName(characterName);
  if (char) showCompletion(char);
}

function clearCharacterBusy(characterName) {
  const char = charByName(characterName);
  if (!char) return;
  char.busy = false;
  char.completionUntil = 0;
  clearBubble(char);
}

function terminateSessionsForProvider(providerKey) {
  for (const [key, session] of sessions.entries()) {
    if (session.providerKey !== providerKey) continue;
    if (session.child && !session.child.killed) session.child.kill();
    sessions.delete(key);
  }
  for (const char of characters) clearCharacterBusy(char.name);
}

function notifyProviderChanged() {
  const name = providers[selectedProvider].displayName;
  for (const char of characters) {
    if (char.popover && !char.popover.isDestroyed()) {
      char.popover.webContents.send('terminal:provider', name);
    }
  }
}

async function sendToProvider(characterName, message, sender) {
  const { provider, binary } = await ensureProvider(selectedProvider);
  markBusy(characterName);
  if (provider.mode === 'api') {
    return sendChatGPT(characterName, message, sender, provider);
  }
  if (provider.mode === 'stream-json') {
    return sendClaudeLike(characterName, message, sender, provider, binary);
  }
  return sendCodex(characterName, message, sender, provider, binary);
}

function createClaudeSession(characterName, provider, binary) {
  const child = spawnCli(binary, provider.args, {
    cwd: os.homedir(),
    env: providerEnv(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const session = {
    providerKey: 'claude',
    child,
    busy: false,
    queue: [],
    senders: new Set(),
    history: [],
    buffer: '',
    exited: false
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    session.buffer += chunk;
    let index;
    while ((index = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, index);
      session.buffer = session.buffer.slice(index + 1);
      handleJsonLine(line, session, characterName);
    }
  });
  child.stderr.on('data', (text) => broadcast(session, 'terminal:error', text));
  child.on('exit', () => {
    session.exited = true;
    session.busy = false;
    broadcast(session, 'terminal:error', `${provider.displayName} session ended.`);
    sessions.delete(sessionKey(characterName, 'claude'));
  });
  child.on('error', (error) => {
    session.exited = true;
    session.busy = false;
    broadcast(session, 'terminal:error', `Failed to run Claude: ${error.message}`);
  });
  return session;
}

function sendClaudeLike(characterName, message, sender, provider, binary) {
  const key = sessionKey(characterName, 'claude');
  let session = sessions.get(key);
  if (!session || session.exited || session.child.killed) {
    session = createClaudeSession(characterName, provider, binary);
    sessions.set(key, session);
  }
  session.senders.add(sender);
  session.history.push({ role: 'user', text: message });
  if (session.busy) {
    session.queue.push(message);
    sender.send('terminal:system', 'queued after current Claude response');
    return;
  }
  writeClaudeMessage(session, message);
}

function writeClaudeMessage(session, message) {
  session.busy = true;
  const payload = {
    type: 'user',
    message: {
      role: 'user',
      content: message
    }
  };
  session.child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function codexPrompt(history, latestUserMessage) {
  const prior = history.slice(0, -1);
  if (prior.length === 0) return latestUserMessage;
  const context = prior.map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`).join('\n\n');
  return `Conversation so far:\n\n${context}\n\n---\n\nUser: ${latestUserMessage}`;
}

function sendCodex(characterName, message, sender, provider, binary) {
  const key = sessionKey(characterName, 'codex');
  let session = sessions.get(key);
  if (!session) {
    session = { providerKey: 'codex', busy: false, queue: [], senders: new Set(), history: [], child: null, completed: false };
    sessions.set(key, session);
  }
  session.senders.add(sender);
  session.history.push({ role: 'user', text: message });
  if (session.busy) {
    session.queue.push(message);
    sender.send('terminal:system', 'queued after current Codex response');
    return;
  }
  runCodexTurn(characterName, session, provider, binary, message);
}

function runCodexTurn(characterName, session, provider, binary, message) {
  session.busy = true;
  session.completed = false;
  const prompt = codexPrompt(session.history, message);
  const child = spawnCli(binary, ['exec', '--json', '--full-auto', '--skip-git-repo-check', prompt], {
    cwd: os.homedir(),
    env: providerEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  session.child = child;
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleJsonLine(line, session, characterName);
    }
  });
  child.stderr.on('data', (text) => broadcast(session, 'terminal:error', text));
  child.on('error', (error) => {
    broadcast(session, 'terminal:error', `Failed to run Codex: ${error.message}`);
  });
  child.on('exit', () => {
    if (buffer.trim()) handleJsonLine(buffer.trim(), session, characterName);
    completeTurn(session, characterName);
  });
}

function sendChatGPT(characterName, message, sender, provider) {
  const key = sessionKey(characterName, 'chatgpt');
  let session = sessions.get(key);
  if (!session) {
    session = { providerKey: 'chatgpt', busy: false, queue: [], senders: new Set(), history: [], completed: false };
    sessions.set(key, session);
  }
  session.senders.add(sender);
  session.history.push({ role: 'user', text: message });
  if (session.busy) {
    session.queue.push(message);
    sender.send('terminal:system', 'queued after current ChatGPT response');
    return;
  }
  runChatGPTTurn(characterName, session, message);
}

function runChatGPTTurn(characterName, session, message) {
  session.busy = true;
  session.completed = false;

  const masterPrompt = `You are a strict data-processing pipeline. Your job is to process the provided user query, perform any necessary reasoning or web searches, and output the result exclusively as a standardized JSON object.

User Query:
"""
${message}
"""

Output Requirements:

Return ONLY a single, valid JSON object.
Do NOT wrap the JSON in markdown code blocks (e.g., do not use \`\`\`json).
Do NOT include any conversational filler, introductory text, or concluding remarks.
You must use the exact following JSON schema:
{
  "query_intent": "string (A brief 3-5 word summary of what the user is asking)",
  "primary_answer": "string (Your complete, detailed text response to the query)",
  "extracted_data": "object or array (If the query asks to extract or list specific data, place it here in key-value pairs. If not applicable, return null)",
  "needs_more_info": "boolean (Set to true only if the query is too vague to answer accurately)"
}`;

  const requestBody = JSON.stringify({ query: masterPrompt });

  fetch('http://127.0.0.1:3000/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody
  })
  .then(res => res.json())
  .then(data => {
    let outputText = '';
    if (data && data.parsedBody) {
      if (data.parsedBody.primary_answer) {
        outputText += data.parsedBody.primary_answer + '\n\n';
      }
      if (data.parsedBody.extracted_data && Object.keys(data.parsedBody.extracted_data).length > 0) {
        outputText += 'Extracted Data:\n';
        outputText += JSON.stringify(data.parsedBody.extracted_data, null, 2);
      }
    } else {
      outputText = JSON.stringify(data, null, 2);
    }
    outputText = outputText.trim();

    session.history.push({ role: 'assistant', text: outputText });
    broadcast(session, 'terminal:text', outputText);
    completeTurn(session, characterName);
  })
  .catch(error => {
    broadcast(session, 'terminal:error', `Failed to run ChatGPT: ${error.message}`);
    completeTurn(session, characterName);
  });
}

function broadcast(session, channel, payload) {
  for (const sender of session.senders) {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  }
}

function completeTurn(session, characterName) {
  if (!session.busy && session.completed) return;
  session.busy = false;
  session.completed = true;
  broadcast(session, 'terminal:complete');
  markComplete(characterName);
  const next = session.queue.shift();
  if (next) {
    markBusy(characterName);
    if (session.providerKey === 'claude') writeClaudeMessage(session, next);
    if (session.providerKey === 'chatgpt') runChatGPTTurn(characterName, session, next);
    if (session.providerKey === 'codex') {
      ensureProvider('codex')
        .then(({ provider, binary }) => runCodexTurn(characterName, session, provider, binary, next))
        .catch((error) => {
          broadcast(session, 'terminal:error', error.message);
          completeTurn(session, characterName);
        });
    }
  }
}

function handleJsonLine(line, session, characterName) {
  if (!line) return;
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    return;
  }

  if (json.type === 'assistant') {
    const content = json.message && json.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          session.history.push({ role: 'assistant', text: block.text });
          broadcast(session, 'terminal:text', block.text);
        }
        if (block.type === 'tool_use') broadcast(session, 'terminal:tool', block.name || 'Tool');
      }
    }
  } else if (json.type === 'item.completed' && json.item && json.item.type === 'agent_message') {
    const text = json.item.text || '';
    if (text) {
      session.history.push({ role: 'assistant', text });
      broadcast(session, 'terminal:text', text);
    }
  } else if (json.type === 'item.started' && json.item && json.item.type === 'command_execution') {
    broadcast(session, 'terminal:tool', json.item.command || 'command');
  } else if (json.type === 'result' || json.type === 'turn.completed') {
    completeTurn(session, characterName);
  } else if (json.type === 'error' || json.type === 'turn.failed') {
    broadcast(session, 'terminal:error', json.message || json.error || 'Provider error');
    completeTurn(session, characterName);
  }
}

function rebuildMenus() {
  const providerItems = Object.entries(providers).map(([key, provider]) => ({
    label: provider.displayName,
    type: 'radio',
    checked: key === selectedProvider,
    click: () => {
      if (selectedProvider === key) return;
      terminateSessionsForProvider(selectedProvider);
      selectedProvider = key;
      updateSettings({ selectedProvider });
      notifyProviderChanged();
      rebuildMenus();
    }
  }));

  const sizeItems = Object.entries(characterSizes).map(([key, size]) => ({
    label: size.label,
    type: 'radio',
    checked: key === selectedSize,
    click: () => {
      selectedSize = key;
      updateSettings({ selectedSize });
      applySizeToCharacters();
      rebuildMenus();
    }
  }));

  const themeItems = Object.entries(themes).map(([key, theme]) => ({
    label: theme.label,
    type: 'radio',
    checked: key === selectedTheme,
    click: () => {
      selectedTheme = key;
      updateSettings({ selectedTheme });
      for (const char of characters) {
        if (char.popover && !char.popover.isDestroyed()) {
          char.popover.webContents.send('terminal:theme', currentThemePayload());
        }
      }
      rebuildMenus();
    }
  }));

  const displayItems = [
    {
      label: 'Auto',
      type: 'radio',
      checked: selectedDisplayId === 'auto',
      click: () => {
        selectedDisplayId = 'auto';
        updateSettings({ selectedDisplayId });
        rebuildMenus();
      }
    },
    { type: 'separator' },
    ...screen.getAllDisplays().map((display, index) => ({
      label: `Display ${index + 1} (${display.bounds.width}x${display.bounds.height})`,
      type: 'radio',
      checked: selectedDisplayId === String(display.id),
      click: () => {
        selectedDisplayId = String(display.id);
        updateSettings({ selectedDisplayId });
        rebuildMenus();
      }
    }))
  ];

  const appMenuTemplate = [
    {
      label: 'lil agents',
      submenu: [
        { label: 'Provider', submenu: providerItems },
        { label: 'Size', submenu: sizeItems },
        { label: 'Style', submenu: themeItems },
        { label: 'Display', submenu: displayItems },
        {
          label: 'Sounds',
          type: 'checkbox',
          checked: soundsEnabled,
          click: (item) => {
            soundsEnabled = item.checked;
            updateSettings({ soundsEnabled });
            rebuildMenus();
          }
        },
        { type: 'separator' },
        { label: 'Show Goku', click: () => requestPopup(charByName('Goku')) },
        { label: 'Open Project', click: () => shell.openPath(repoRoot) },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ];

  const trayMenuTemplate = [
    { label: 'Provider', submenu: providerItems },
    { label: 'Size', submenu: sizeItems },
    { label: 'Style', submenu: themeItems },
    { label: 'Display', submenu: displayItems },
    {
      label: 'Sounds',
      type: 'checkbox',
      checked: soundsEnabled,
      click: (item) => {
        soundsEnabled = item.checked;
        updateSettings({ soundsEnabled });
        rebuildMenus();
      }
    },
    { type: 'separator' },
    { label: 'Show Goku', click: () => requestPopup(charByName('Goku')) },
    { label: 'Open Project', click: () => shell.openPath(repoRoot) },
    { type: 'separator' },
    { role: 'quit' }
  ];

  const menu = Menu.buildFromTemplate(appMenuTemplate);
  Menu.setApplicationMenu(menu);
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate));
}

function setupTray() {
  const icon = iconPath();
  tray = new Tray(icon ? nativeImage.createFromPath(icon) : nativeImage.createEmpty());
  tray.setToolTip('lil agents');
  tray.on('click', () => createPopover(characters[0]));
  rebuildMenus();
}

// Windows 10/11: CalculateNativeWinOcclusion throttles compositing for windows
// the OS considers "occluded", which breaks alpha blending on transparent always-
// on-top windows and makes them render as solid black.  Disable it before ready.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.lilagents.windows');
  applySavedSettings();
  createCharacter({ name: 'Goku', progress: 0.3, direction: 1, footNudge: 3, initialPause: 700, color: '#66b88c' });
  setupTray();
  tickTimer = setInterval(updateCharacters, 1000 / 30);
  screen.on('display-added', rebuildMenus);
  screen.on('display-removed', rebuildMenus);
  screen.on('display-metrics-changed', rebuildMenus);
  triggerOnboarding();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  if (tickTimer) clearInterval(tickTimer);
  for (const session of sessions.values()) {
    if (session.child && !session.child.killed) session.child.kill();
  }
});

ipcMain.on('character:ready', (event) => {
  const char = charByWebContents(event.sender);
  if (!char || char.phase !== 'loading') return;

  char.phase = 'greeting';
  setTimeout(() => {
    if (char.win.isDestroyed()) return;
    char.win.webContents.send('character:state', 'wave');
    char.standTimeout = setTimeout(() => {
      if (char.phase === 'greeting') startWalkToEdge(char);
    }, 5000);
  }, char.initialPause || 700);
});

ipcMain.on('character:clicked', (event, characterName) => {
  requestPopup(charByName(characterName));
});

ipcMain.on('character:anim-done', (event, animState) => {
  const char = charByWebContents(event.sender);
  if (!char) return;

  if (animState === 'wave') {
    if (char.phase === 'greeting') {
      // Greeting wave finished → walk to a random edge and sit
      clearTimeout(char.standTimeout);
      startWalkToEdge(char);
    } else {
      // Completion wave finished
      if (!char.popover || char.popover.isDestroyed()) {
        // Popup already closed — start the idle-then-sit cycle
        startIdling(char);
      } else {
        // Popup still open — just return to idle animation
        sendRandomIdle(char);
      }
    }
  }

  if (animState === 'stand' && char.phase === 'standing') {
    startWalkFromEdge(char);
  }
  // 'sit' completion: phase is already 'sitting', nothing more to do
});

ipcMain.handle('terminal:provider', () => providers[selectedProvider].displayName);
ipcMain.handle('terminal:theme', () => currentThemePayload());

ipcMain.handle('terminal:send', async (event, payload) => {
  try {
    await sendToProvider(payload.characterName, payload.message, event.sender);
  } catch (error) {
    event.sender.send('terminal:error', error.message);
    event.sender.send('terminal:complete');
    clearCharacterBusy(payload.characterName);
  }
});

ipcMain.on('terminal:voice-state', (_event, payload) => {
  setVoiceState(payload.characterName, Boolean(payload.active), payload.text || '', payload.kind || 'speaking');
});
