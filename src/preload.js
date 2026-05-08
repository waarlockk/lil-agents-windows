const { contextBridge, ipcRenderer } = require('electron');

function argValue(prefix) {
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

contextBridge.exposeInMainWorld('lilAgents', {
  characterName: argValue('--character='),
  characterAssetsDir: argValue('--char-assets='),
  color: argValue('--color='),
  onboarding: process.argv.includes('--onboarding=1'),
  clickCharacter: (name) => ipcRenderer.send('character:clicked', name),
  setVoiceState: (characterName, payload) => ipcRenderer.send('terminal:voice-state', { characterName, ...payload }),
  provider: () => ipcRenderer.invoke('terminal:provider'),
  theme: () => ipcRenderer.invoke('terminal:theme'),
  send: (characterName, message) => ipcRenderer.invoke('terminal:send', { characterName, message }),
  onDirection: (callback) => ipcRenderer.on('character:direction', (_, direction) => callback(direction)),
  onState: (callback) => ipcRenderer.on('character:state', (_, state) => callback(state)),
  onBubble: (callback) => ipcRenderer.on('character:bubble', (_, payload) => callback(payload)),
  onSound: (callback) => ipcRenderer.on('character:sound', (_, path) => callback(path)),
  animationDone: (state) => ipcRenderer.send('character:anim-done', state),
  onProvider: (callback) => ipcRenderer.on('terminal:provider', (_, name) => callback(name)),
  onTheme: (callback) => ipcRenderer.on('terminal:theme', (_, theme) => callback(theme)),
  onText: (callback) => ipcRenderer.on('terminal:text', (_, text) => callback(text)),
  onError: (callback) => ipcRenderer.on('terminal:error', (_, text) => callback(text)),
  onSystem: (callback) => ipcRenderer.on('terminal:system', (_, text) => callback(text)),
  onTool: (callback) => ipcRenderer.on('terminal:tool', (_, text) => callback(text)),
  onComplete: (callback) => ipcRenderer.on('terminal:complete', callback),
  ready: () => ipcRenderer.send('character:ready')
});
