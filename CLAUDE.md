# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Wave** is a cross-platform desktop application built with [Tauri v2](https://tauri.app/) — a React/TypeScript frontend and a Rust backend communicating via IPC.

- **Identifier:** `com.mskayyali.wave`
- **Window size:** 800×600

## Commands

### Development

```bash
# Start the frontend dev server only (port 1420)
# Node is at /opt/homebrew/bin/node — ensure PATH includes /opt/homebrew/bin
/opt/homebrew/bin/node node_modules/.bin/vite

# Start the full Tauri app in dev mode (requires Rust toolchain)
bunx tauri dev
```

> The preview server is configured in `.claude/launch.json` (uses `/opt/homebrew/bin/node` directly since `bun`/`npm` aren't on the default shell PATH in this environment).

### Build

```bash
# Type-check and build the frontend
bun run build

# Package the full desktop app
bunx tauri build
```

### Type Checking

```bash
# TypeScript type check (no emit)
npx tsc --noEmit
```

> No lint or test tooling is currently configured.

## Architecture

```
Frontend (React/TS/Vite) ←── Tauri IPC (invoke) ──→ Backend (Rust)
```

### Frontend — `src/`

React 19 app bundled with Vite. Entry point is `src/main.tsx` → `src/App.tsx`. Communicates with Rust via `@tauri-apps/api` (`invoke`) and uses `@tauri-apps/plugin-opener` for opening URLs/files.

### Backend — `src-tauri/`

Rust library crate (`lib.rs`) set up with `tauri::Builder`. Tauri commands are defined as Rust functions annotated with `#[tauri::command]` and registered in the builder. The `opener` plugin is included.

Key files:
- `src-tauri/src/lib.rs` — Tauri app setup, plugin registration, command handlers
- `src-tauri/src/main.rs` — Binary entry point (calls `lib::run()`)
- `src-tauri/tauri.conf.json` — Window size, app identifier, bundle targets, CSP
- `src-tauri/capabilities/` — Tauri capability definitions (controls what the app can access)

### IPC Pattern

To add a new Rust command:
1. Define it in `lib.rs` with `#[tauri::command]`
2. Register it in `.invoke_handler(tauri::generate_handler![...])`
3. Call it from the frontend with `invoke("command_name", { arg })`

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) with:
- [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
