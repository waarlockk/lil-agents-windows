# lil agents — Windows

An Electron app that places an animated 3D character (Goku) on your Windows taskbar. Click the character to open a floating terminal and chat with Claude, Codex, or Self-GPT directly from your desktop.

## Demo

<video src="example/vid.mp4" controls width="100%"></video>

## What it does

- Renders Goku walking along your taskbar using Three.js and Mixamo FBX animations
- Goku walks to the edge of the taskbar, sits down, and stands up again on a natural idle cycle
- Click Goku to open a floating terminal popover
- Send messages to Claude Code, OpenAI Codex, or Self-GPT — responses stream back in real time
- Tool use is displayed inline; a completion sound and wave animation play when a response finishes
- Thought bubbles show agent status while the popover is closed
- Microphone dictation and speech synthesis let you talk hands-free
- The character and terminal window stay always-on-top and transparent

## Providers

| Provider | How it works | Requirement |
|---|---|---|
| **Claude** | Streams via Claude Code CLI (`--output-format stream-json`) | [Claude Code](https://claude.ai/download) installed and on `PATH` |
| **Codex** | Spawns `codex exec --json` per turn | `npm install -g @openai/codex` |
| **Self-GPT** | Browser automation — uses ChatGPT in your browser without installing any CLI | See Self-GPT project setup |

Self-GPT is a separate project that drives ChatGPT through browser automation, so you can use it without a paid API key or any CLI installation.

## Requirements

- Windows 10 or 11
- Node.js 20+
- At least one provider set up (see table above)
- Mixamo FBX character + animation files (see [Assets](#assets) below)

## Setup

```powershell
cd WindowsApp
npm install
npm start
```

## Assets

The app loads Goku's model and animations from `assets/characters/goku/`. Drop in Mixamo FBX files with these names:

| File | Animation |
|---|---|
| `model.fbx` | T-pose / bind pose (required) |
| `idle.fbx` | Standing idle loop |
| `idle2.fbx` | Alternate idle loop |
| `walk.fbx` | Walk cycle |
| `sit.fbx` | Sit-down transition (one-shot) |
| `stand.fbx` | Stand-up transition (one-shot) |
| `think.fbx` | Thinking loop |
| `wave.fbx` | Wave (one-shot) |
| `listen.fbx` | Listening loop |
| `talk.fbx` | Talking loop |

Download free animations from [Mixamo](https://www.mixamo.com). Export as **FBX for Unity** (includes skeleton) with skin.

## Configuration

Settings are saved to `%APPDATA%\lil-agents-windows\settings.json` and persist across restarts.

| Setting | Options |
|---|---|
| Provider | Claude, Codex, Self-GPT |
| Size | Small, Medium, Large |
| Style | Peach, Midnight, Cloud, Moss |
| Display | Auto (taskbar display), or pin to a specific monitor |
| Sounds | On / Off |

Access all settings from the tray icon or the app menu.

## Terminal commands

Inside the popover:

| Command | Effect |
|---|---|
| `/clear` | Clear the chat output |
| `/copy` | Copy the last assistant response to clipboard |
| `/help` | Show available commands |

## Architecture

```
src/
  main.js         — Electron main process: windows, IPC, CLI sessions, positioning
  preload.js      — Context bridge exposing a safe IPC API to renderer pages
  character.js    — Three.js renderer + animation state machine (renderer process)
  terminal.js     — Chat UI, voice input/output (renderer process)
  character.html  — Shell for the character window
  terminal.html   — Shell for the popover terminal window
  styles.css      — Shared styles for both windows
assets/
  characters/
    goku/         — FBX model and animation files (not included, see Assets above)
```

## About this port

This is a Windows port of the original macOS [lil agents](https://github.com/ryanstephen/lil-agents) app, rebuilt with Electron so it runs natively on Windows 10/11.

### What's been carried over
- Animated character walking on the system taskbar with idle, sit, stand, think, wave, listen, and talk states
- Floating terminal popover with themed UI (Peach, Midnight, Cloud, Moss)
- Claude and Codex provider support with streaming JSON output
- Thinking/completion bubbles and completion sounds
- Per-character size settings (Small, Medium, Large)
- Message queueing when a provider is still processing
- First-run onboarding popover
- `/clear`, `/copy`, and `/help` slash commands

### What's new in this port
- Self-GPT provider — uses ChatGPT via browser automation instead of a local CLI
- Windows taskbar geometry detection (bottom, top, left, right taskbar positions)
- Tray icon with full settings menu
- Multi-monitor support with auto or pinned display selection
- Microphone dictation and spoken replies via Web Speech API
- Windows-specific process spawning (handles `.cmd`/`.bat` npm shims)

### What's been removed or is not yet supported
- Gemini, Copilot, OpenCode, and OpenClaw providers are not included
- macOS Dock positioning logic is replaced by Windows taskbar geometry
- Windows does not expose individual taskbar icon positions, so the character walks the full taskbar width
- Auto-update and Windows installer packaging are not wired yet
- Auto-hide taskbar detection depends on Windows reporting a reduced work area

## Privacy

The app runs entirely locally. Your chat messages are sent only to the provider you select through a local subprocess or browser automation — nothing is sent by this wrapper itself. No telemetry is collected.

## Known limitations

- The transparent character window covers a portion of the taskbar area, which can interfere with normal activity (clicks, drag targets) in that region
- Windows does not expose individual taskbar icon positions through Electron, so Goku walks the full taskbar width rather than between specific icons
- Auto-hide taskbar detection relies on Windows reporting a reduced work area; pin a display from the menu if the character doesn't appear
- Speech recognition availability depends on the Chromium build bundled with the Electron version
- Installer and auto-update are not wired yet

## License

MIT License. See [LICENSE](LICENSE) for details.
