# AGENTS.md

OpenUsage for Windows is a Tauri 2 system-tray app that shows AI provider usage widgets (Claude, Codex, Cursor, Grok, and more).

This repository is a Windows port of the upstream [OpenUsage](https://github.com/robinebers/openusage) Tauri edition (`tauri-legacy` branch). The upstream `main` branch is now a native Swift macOS app.

## Architecture

- React + TypeScript frontend in `src/`
- Rust + Tauri 2 backend in `src-tauri/`
- Provider plugins are JavaScript under `plugins/`, executed via embedded QuickJS (`rquickjs`)
- Tray + floating panel (Windows uses a standard always-on-top webview; macOS code paths for NSPanel remain optional)

## Windows notes

- Credentials come from user-profile auth files (`~/.claude`, `~/.codex`, `~/.grok`, …), not macOS Keychain
- Path expansion supports `~/` and `~\`
- Bundle targets: NSIS + MSI
- Build: `npm install` then `npm run tauri:build`

## Commands

```powershell
npm install
npm run bundle:plugins
npm run tauri:dev      # development
npm run tauri:build    # release installer
```

## Conventions

- Keep provider plugins aligned with upstream behavior where APIs allow
- Prefer file-based auth on Windows; document Keychain-only limitations
- No silent credential network use outside the matching provider
