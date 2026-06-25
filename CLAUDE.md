# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Wave** is a local-first, Mac-native **text-based audio editor for podcasts** — edit audio by editing its transcript (à la Descript). It is a [Tauri v2](https://tauri.app/) desktop app: a React/TypeScript frontend and a Rust backend communicating over IPC. Transcription runs entirely on-device via `whisper-rs` (whisper.cpp) on the Apple Silicon GPU.

- **Identifier:** `com.mskayyali.wave`
- **Window:** 1280×820, min 960×600 (see `src-tauri/tauri.conf.json`)
- **Platform:** macOS / Apple Silicon (the `whisper-rs` `metal` feature ties transcription to Metal)
- **Status:** MVP complete through Phase 10 — see [PLAN.md](PLAN.md) for the full feature history.

## Commands

> **Environment note:** Node is at `/opt/homebrew/bin/node` and `bun`/`cargo` aren't on the default shell PATH. Either prefix with the full path or run `export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"` first. The package manager is **bun** (`bun.lock` is the lockfile; there is intentionally no `package-lock.json`). The preview server is configured in `.claude/launch.json`.

### Development

```bash
# Frontend dev server only (port 1420)
/opt/homebrew/bin/node node_modules/.bin/vite     # or: bun run dev

# Full Tauri app in dev mode (requires Rust toolchain)
bunx tauri dev
```

### Build & checks

```bash
bun run build          # tsc type-check + vite build (frontend)
npx tsc --noEmit       # type-check only
bunx tauri build       # package the desktop app
cargo check            # Rust check (run from src-tauri/)
```

> No lint or test tooling is currently configured.

## Architecture

```
Frontend (React/TS/Vite) ←── Tauri IPC (invoke) ──→ Backend (Rust)
```

### Backend — `src-tauri/src/`

Rust library crate (`wave_lib`). `lib.rs` wires up `tauri::Builder`, registers the `opener` and `dialog` plugins, manages the `DownloadManager` state, and registers all command handlers. Commands are split by domain:

- **`lib.rs`** — app setup, plugin/handler registration; `save_text_file` command.
- **`models.rs`** — Whisper model lifecycle. `list_models`, `start_model_download` (streaming, resumable, cancellable), `cancel_model_download`, `delete_model`. Models pulled from `https://huggingface.co/ggerganov/whisper.cpp` into `{app_data}/models/ggml-{id}.bin` (`.part` while in flight). Six known models: `tiny.en`, `base.en`, `small.en`, `medium.en`, `large-v3-turbo`, `large-v3`.
- **`projects.rs`** — project CRUD, audio import, edits/peaks persistence, export. `create_project`, `list_projects` (repairs stale `importing` state on launch), `rename_project`, `delete_project`, `import_audio` (symphonia decode → rubato resample → hound 16 kHz WAV), `get_audio_path`, `get_playback_audio_path`, `load_peaks`/`save_peaks`, `load_edits`/`save_edits`, `generate_preview`, `export_audio` (PCM splice via hound, no FFmpeg).
- **`transcription.rs`** — `transcribe` (async; runs whisper-rs with word-level token timestamps, emits progress events) and `get_transcript`.
- **`settings.rs`** — `get_settings`/`set_settings` persisting `selectedModelId` to `settings.json`.

Rust↔frontend types use `#[serde(rename_all = "camelCase")]`.

### Frontend — `src/`

React 19 + Vite. Entry `main.tsx` → `App.tsx`. UI is IBM Carbon (`@carbon/react`, g100 dark theme). Layered structure:

- **`pages/`** — `ProjectsPage`, `SettingsPage`, `EditorPage` (the ~600-line core; owns selection, edit queue, and silence enrichment).
- **`components/editor/`** — `EditorTopBar`, `TranscriptEditor` (TipTap), `WordNode` (custom inline atom node), `SegmentsView`, `WaveformTimeline`, `PlaybackControls`, `InspectorPanel`.
- **`components/layout/`** — `AppShell` (sidebar + nav).
- **`hooks/`** — one per domain: `useModels`, `useProjects`, `useSettings`, `useTranscript`, `usePlayback`, `useWaveform`.
- **`lib/modelCatalog.ts`** — frontend-only display metadata for models (Rust knows only ids/filenames).
- **`utils/exportFormats.ts`** — TXT/SRT/VTT/JSON serializers.
- **`styles/global.scss`** — custom design layer over Carbon.

App navigation lives in `App.tsx`: a Projects/Settings shell, with the editor opening full-window (bypassing the sidebar) when a project is selected.

### On-disk data model (`{app_data}` = Tauri app data dir)

```
{app_data}/
  settings.json                  # { selectedModelId }
  models/ggml-{id}.bin           # downloaded Whisper models (.part = partial)
  projects/{uuid}/
    project.json                 # { id, name, created_at, audio_path?, status }
    audio_original.*             # copied source file (native quality, used for playback)
    audio_16k.wav                # decoded 16 kHz mono PCM (whisper input + export source)
    transcript.json              # { words[], language, durationMs }
    edits.json                   # non-destructive cut queue (time ranges)
    peaks.json                   # cached waveform peaks
```

**Project status lifecycle:** `Empty → Importing → ReadyToTranscribe → Transcribing → Ready` (or `Error { message }`).

### Core concept — non-destructive editing

Deleting words/silences appends `{ startMs, endMs }` ranges to an in-memory edit queue (persisted to `edits.json`). Original audio is never mutated. Playback skips deleted ranges live via a requestAnimationFrame loop calling `seek`. Only at export does Rust splice the surviving PCM segments into a new WAV. Deleted real words expand boundaries ±60 ms (Whisper timestamp imprecision); silence sentinels use exact boundaries.

## Adding a Tauri command

1. Define it in the relevant `src-tauri/src/*.rs` module with `#[tauri::command]`.
2. Register it in `lib.rs` under `.invoke_handler(tauri::generate_handler![...])`.
3. Call it from the frontend with `invoke("command_name", { camelCaseArg })`.

## Key config files

- `src-tauri/tauri.conf.json` — window, identifier, bundle targets, CSP, asset protocol scope (`$APPDATA/**`, `$HOME/**`).
- `src-tauri/capabilities/default.json` — Tauri capability/permission definitions.
- `src-tauri/Cargo.toml` — Rust dependencies (whisper-rs, symphonia, rubato, hound, reqwest, tokio, …).

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.
