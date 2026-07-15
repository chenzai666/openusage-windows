# OpenUsage for Windows

Track your AI coding subscriptions from the Windows system tray.

This is a **Windows port** of [OpenUsage](https://github.com/robinebers/openusage) (based on the open-source Tauri edition). It shows how much of your AI coding plans you've used — session and weekly limits, credits, and spend — in one panel next to the tray icon.

> Upstream: [robinebers/openusage](https://github.com/robinebers/openusage) (macOS-first; current native Swift app on `main`, Tauri legacy on `tauri-legacy`).

![OpenUsage Screenshot](screenshot.png)

## Features

- **System tray app** — click the tray icon to open the usage panel
- **Provider plugins** — Claude, Codex, Cursor, Copilot, Grok, and more
- **Local credentials** — reuses logins already on your machine (auth files under your user profile)
- **Local HTTP API** — `127.0.0.1:6736` for other tools and agents
- **Proxy support** — SOCKS5 / HTTP via `~/.openusage/config.json`
- **Global shortcut** — toggle the panel from anywhere
- **Auto-start** — optional launch at login

## Supported providers

Most providers work on Windows when you are signed into the corresponding CLI or app:

| Provider | Credentials |
|---|---|
| Claude | `~/.claude/.credentials.json` or `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | Codex CLI auth under `%USERPROFILE%\.codex` / `$CODEX_HOME` |
| Cursor | Cursor app local state (when present) |
| Copilot | GitHub / Copilot auth on this machine |
| Grok | `~/.grok/auth.json` after `grok login` |
| OpenCode Go, Z.ai, Amp, Kimi, MiniMax, … | Same plugin logic as upstream |

macOS Keychain-only logins are not available on Windows; use the CLI file-based login for those tools.

## Install (from source)

### Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (MSVC toolchain)
- Visual Studio Build Tools with “Desktop development with C++”
- WebView2 (usually preinstalled on Windows 11; bootstrapper is used if missing)

### Build

```powershell
git clone https://github.com/chenzai666/openusage-windows.git
cd openusage-windows
npm install
npm run bundle:plugins
npm run tauri:build
```

Installer output:

- `src-tauri\target\release\bundle\nsis\*.exe`
- `src-tauri\target\release\bundle\msi\*.msi`

### Dev

```powershell
npm install
npm run tauri:dev
```

## Usage

1. Sign into your AI CLIs/apps (Claude Code, Codex, Cursor, Grok, …).
2. Launch OpenUsage — it appears in the system tray.
3. Left-click the tray icon to open the dashboard; right-click for the menu (Settings, Quit, …).

Optional proxy config (`%USERPROFILE%\.openusage\config.json`):

```json
{
  "proxy": "socks5://127.0.0.1:1080"
}
```

Local API (loopback only):

```text
GET http://127.0.0.1:6736/v1/usage
```

## Architecture

- **Frontend:** React + TypeScript + Vite + Tailwind (panel UI)
- **Backend:** Rust + Tauri 2 (tray, plugins, local HTTP API)
- **Providers:** JavaScript plugins under `plugins/`, run in an embedded QuickJS host

Windows-specific changes vs upstream Tauri edition:

- Replaced macOS `NSPanel` with a standard always-on-top tray-adjacent window
- Disabled macOS-private APIs / App Nap / WebKit tweaks
- Path expansion supports Windows home paths
- Bundles NSIS + MSI installers

## Credits

- Original project by [Robin Ebers](https://github.com/robinebers) — [openusage](https://github.com/robinebers/openusage)
- Inspired by [CodexBar](https://github.com/steipete/CodexBar)

## License

[MIT](LICENSE) — same as upstream OpenUsage.
