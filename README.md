# Wave

**A local-first, Mac-native text-based audio editor for podcasts.** Edit audio by editing text — delete a word in the transcript and it's cut from the audio. Inspired by Descript, but everything runs on-device: no cloud, no account, no upload.

Built with [Tauri v2](https://tauri.app/) (Rust backend) and React 19 + TypeScript. Transcription runs locally via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`whisper-rs`) on the Apple Silicon GPU (Metal).

---

## What it does

1. **Create a project** and import an audio file (any format — decoded via symphonia).
2. Wave **transcribes it locally** with a Whisper model, producing word-level timestamps.
3. **Edit the transcript** in a rich editor — delete words or dead-air silences. Edits are non-destructive; the original audio is never modified.
4. **Preview instantly** — playback skips deleted ranges in real time, no re-encoding.
5. **Export** the edited audio as WAV, plus the transcript as TXT / SRT / WebVTT / JSON (all reflecting your cuts).

## Features

- **Local Whisper transcription** — word-level timestamps, Metal GPU accelerated, fully offline.
- **Model manager** (Settings) — download, resume, cancel, and delete 6 Whisper models (Tiny → Large v3) with live progress, speed, and ETA.
- **Transcript editor** (TipTap) — word-level nodes with confidence coloring; **Flow** (continuous text) and **Segments** (timestamped cue blocks) views.
- **Word-accurate playback** — the spoken word highlights as audio plays; click any word to seek; keyboard shortcuts (Space, ←/→, J/L).
- **Synced waveform timeline** (wavesurfer.js) — zoom up to 32×, word-boundary markers, snap-to-word trimming, bidirectional selection with the transcript.
- **Non-destructive text-based editing** — select words and Delete; cuts show as red overlays, preview skips them live, per-action undo (⌘Z).
- **Silence detection** — long pauses surface as deletable `█` sentinels for one-click dead-air trimming.
- **Export** — edited WAV via direct PCM splicing (no FFmpeg); transcript in TXT, SRT, WebVTT, JSON.

## Tech stack

| Layer | Choice |
|---|---|
| App shell | Tauri v2 (Rust ↔ React over IPC) |
| Frontend | React 19, TypeScript, Vite 7 |
| UI system | `@carbon/react` (IBM Carbon, g100 dark theme) |
| Transcript editor | TipTap 3 (custom inline word nodes) |
| Waveform | wavesurfer.js 7 + RegionsPlugin |
| Transcription | `whisper-rs` 0.16 (Metal GPU) |
| Audio decode / resample | symphonia → rubato → hound (16 kHz mono WAV) |
| Audio export | hound-based PCM splice (no FFmpeg) |

## Requirements

- **macOS on Apple Silicon** — transcription uses the Metal GPU (`whisper-rs` `metal` feature).
- **Rust** toolchain (cargo, rustc).
- **Node** and **[bun](https://bun.sh/)** (bun is the package manager and Tauri's configured dev/build runner).

> In this dev environment Node lives at `/opt/homebrew/bin/node` and isn't on the default shell PATH — prefix it or add `/opt/homebrew/bin` to PATH. See [CLAUDE.md](CLAUDE.md) for details.

## Getting started

```bash
# Install dependencies
bun install

# Run the full desktop app in dev mode (Vite + Tauri)
bunx tauri dev

# Or just the frontend dev server (port 1420)
bun run dev
```

## Build

```bash
# Type-check + build the frontend
bun run build

# Package the desktop app
bunx tauri build
```

## How it works

```
React (src/) ──invoke()──▶ Rust commands (src-tauri/src/)
                            ├─ models.rs         download / manage Whisper models
                            ├─ projects.rs       project CRUD, audio import, peaks, edits, export
                            ├─ transcription.rs  whisper-rs → word-level transcript
                            └─ settings.rs       selected-model persistence
```

All state lives on disk in the app data directory: Whisper models in `models/`, and per-project files (`audio_16k.wav`, `transcript.json`, `edits.json`, `peaks.json`, …) under `projects/{id}/`. Edits are stored as a non-destructive queue of time ranges and only applied to PCM at export time.

For architecture details and conventions see [CLAUDE.md](CLAUDE.md). For the full build history and feature breakdown (Phases 1–10) see [PLAN.md](PLAN.md).

## Status

MVP complete through Phase 10. Out of scope for now: speaker diarization, AI-assisted editing, cloud sync, video, and noise removal.
