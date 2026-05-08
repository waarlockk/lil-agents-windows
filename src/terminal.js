const output = document.getElementById('output');
const form = document.getElementById('form');
const input = document.getElementById('input');
const provider = document.getElementById('provider');
const character = document.getElementById('character');
const voiceButton = document.getElementById('voice');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let lastAssistant = '';
let streaming = false;
let pendingSpeech = '';
let recognition = null;
let listening = false;
let dictatedText = '';
let interimText = '';

function applyTheme(theme) {
  if (!theme || !theme.vars) return;
  for (const [key, value] of Object.entries(theme.vars)) {
    document.documentElement.style.setProperty(key, value);
  }
}

function append(className, text) {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = text;
  output.appendChild(node);
  output.scrollTop = output.scrollHeight;
  return node;
}

function appendAssistant(text) {
  if (!streaming) {
    append('assistant', '');
    streaming = true;
  }
  const node = output.lastElementChild;
  node.textContent += text;
  lastAssistant += text;
  pendingSpeech += text;
  output.scrollTop = output.scrollHeight;
}

function slashCommand(command) {
  if (command === '/clear') {
    output.replaceChildren();
    pendingSpeech = '';
    return true;
  }
  if (command === '/copy') {
    navigator.clipboard.writeText(lastAssistant || 'nothing to copy yet');
    append('system', 'copied to clipboard');
    return true;
  }
  if (command === '/help') {
    append('system', '/clear clears chat, /copy copies the last response, /help shows this message');
    return true;
  }
  if (command.startsWith('/')) {
    append('error', `unknown command: ${command}`);
    return true;
  }
  return false;
}

function setVoiceButtonState(active, title) {
  voiceButton.classList.toggle('listening', active);
  voiceButton.setAttribute('title', title);
  voiceButton.setAttribute('aria-label', title);
}

function setCharacterVoice(active, text, kind) {
  window.lilAgents.setVoiceState(window.lilAgents.characterName, { active, text, kind });
}

function stopSpeaking() {
  window.speechSynthesis.cancel();
  setCharacterVoice(false, '', 'speaking');
}

function speak(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned || !('speechSynthesis' in window)) return;
  stopSpeaking();
  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.rate = 1.03;
  utterance.pitch = 1.0;
  utterance.volume = 1;
  utterance.onstart = () => setCharacterVoice(true, 'speaking...', 'speaking');
  utterance.onend = () => setCharacterVoice(false, '', 'speaking');
  utterance.onerror = () => setCharacterVoice(false, '', 'speaking');
  window.speechSynthesis.speak(utterance);
}

function syncDictationInput() {
  input.value = [dictatedText, interimText].filter(Boolean).join(' ').trim();
}

function stopListening(resetInput = false) {
  if (recognition && listening) recognition.stop();
  listening = false;
  interimText = '';
  if (resetInput) {
    dictatedText = '';
    input.value = '';
  }
  setVoiceButtonState(false, 'Dictate with microphone');
  setCharacterVoice(false, '', 'listening');
}

async function submitMessage(message) {
  append('user', `> ${message}`);
  streaming = false;
  lastAssistant = '';
  pendingSpeech = '';
  await window.lilAgents.send(window.lilAgents.characterName, message);
}

function startListening() {
  if (!SpeechRecognition) {
    append('error', 'Speech recognition is not available in this Electron build.');
    return;
  }
  stopSpeaking();
  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      listening = true;
      dictatedText = '';
      interimText = '';
      setVoiceButtonState(true, 'Stop microphone');
      setCharacterVoice(true, 'listening...', 'listening');
    };

    recognition.onresult = async (event) => {
      interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = (event.results[i][0] && event.results[i][0].transcript || '').trim();
        if (!transcript) continue;
        if (event.results[i].isFinal) {
          dictatedText = [dictatedText, transcript].filter(Boolean).join(' ').trim();
        } else {
          interimText = transcript;
        }
      }
      syncDictationInput();
    };

    recognition.onerror = (event) => {
      listening = false;
      setVoiceButtonState(false, 'Dictate with microphone');
      setCharacterVoice(false, '', 'listening');
      if (event.error !== 'aborted' && event.error !== 'no-speech') {
        append('error', `voice error: ${event.error}`);
      }
    };

    recognition.onend = async () => {
      const message = [dictatedText, interimText].filter(Boolean).join(' ').trim();
      listening = false;
      interimText = '';
      dictatedText = '';
      setVoiceButtonState(false, 'Dictate with microphone');
      setCharacterVoice(false, '', 'listening');
      if (message) {
        input.value = '';
        if (!slashCommand(message.toLowerCase())) await submitMessage(message);
      }
    };
  }

  recognition.start();
}

window.lilAgents.theme().then(applyTheme);
window.lilAgents.provider().then((name) => {
  if (window.lilAgents.onboarding) return;
  provider.textContent = name;
  input.placeholder = `Ask ${name}...`;
});
character.textContent = window.lilAgents.characterName;
input.focus();

if (window.lilAgents.onboarding) {
  provider.textContent = 'Welcome';
  input.disabled = true;
  voiceButton.disabled = true;
  input.placeholder = '';
  append('assistant', "hey! we're bruce and jazz - your lil taskbar agents.\n\nclick either of us to open a Claude or Codex chat. now the popover also supports microphone dictation and spoken replies when Chromium exposes those speech APIs.\n\nuse the tray icon for provider, size, style, display, and sound controls.\n\nclose this popover or click us again when you're ready.");
} else if (!SpeechRecognition) {
  voiceButton.disabled = true;
  voiceButton.title = 'Speech recognition unavailable';
  voiceButton.setAttribute('aria-label', 'Speech recognition unavailable');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (window.lilAgents.onboarding) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  stopListening();
  if (slashCommand(message.toLowerCase())) return;
  await submitMessage(message);
});

voiceButton.addEventListener('click', () => {
  if (voiceButton.disabled || window.lilAgents.onboarding) return;
  if (listening) {
    stopListening();
    return;
  }
  startListening();
});

window.lilAgents.onText((text) => appendAssistant(text));
window.lilAgents.onTool((text) => append('tool', `TOOL ${text}`));
window.lilAgents.onError((text) => append('error', text));
window.lilAgents.onSystem((text) => append('system', text));
window.lilAgents.onProvider((name) => {
  provider.textContent = name;
  input.placeholder = `Ask ${name}...`;
  append('system', `switched to ${name}`);
});
window.lilAgents.onTheme(applyTheme);
window.lilAgents.onComplete(() => {
  streaming = false;
  speak(pendingSpeech);
});

window.addEventListener('beforeunload', () => {
  stopListening(true);
  stopSpeaking();
});
