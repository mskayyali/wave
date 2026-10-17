# Wave

**A local-first, Mac-native text-based audio editor for podcasts.** Edit audio by editing text — delete a word in the transcript and it's cut from the audio. Inspired by Descript, but everything runs on-device: no cloud, no account, no upload.

Built with [Tauri v2](https://tauri.app/) (Rust backend) and React 19 + TypeScript. Transcription runs locally via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`whisper-rs`) on the Apple Silicon GPU (Metal).

---

## What it does

1. **Create a project** and import an audio file (any format — decoded via symphonia).
2. Wave **transcribes it locally** with a Whisper model, producing word-level timestamps.
3. **Edit the transcript** in a rich editor — delete words or dead-air silences. Edits are non-destructive; the original audio is never modified.
4. **Preview instantly** — playback joins the kept audio gaplessly with the same crossfade the export uses, no re-encoding.
5. **Export** the edited audio as MP3, AAC, WAV or FLAC, plus the transcript as TXT / SRT / WebVTT / JSON (all reflecting your cuts).

## Features

- **Local Whisper transcription** — verbatim, fillers included (English), so every "um" and "uh" is a word you can cut. Whisper hears the recording in pieces cut at pauses, with long silences left out, which keeps it from looping or inventing words in the quiet. Word timings are aligned to the audio (DTW + voice-activity snapping, so pauses are real gaps); Metal GPU accelerated, fully offline.
- **Word alignment** (English) — wav2vec2 forced alignment places every word on its exact audio, so cutting a word removes all of it; existing projects can be re-aligned without re-transcribing.
- **Model manager** (Settings) — **Transcription** is one required 1.6 GB download (Whisper Large v3 Turbo, then the word aligner, fetched in sequence); AI enhancements are optional. Resume, cancel and delete, with live progress, speed and ETA.
- **Transcript editor** (TipTap) — word-level nodes (words Whisper is unsure of are dimmed; the playing word is highlighted); **Flow** (continuous text) and **Segments** (timestamped cue blocks) views.
- **Word-accurate playback** — the spoken word highlights as audio plays; click any word to seek; keyboard shortcuts (Space, ←/→, J/L); pitch-preserving 0.5–2× speed.
- **Editable waveform** (wavesurfer.js) — appears as soon as the editor opens (computed natively at import), accurate down to 1 ms per pixel; context-aware zoom (Z to fit the selection and back); selections are exactly what you drag (word snapping is an optional toggle); ⌫ cuts exactly the selected audio, so the tail of a word can be trimmed without losing the word; ⇧←/→ fine-tune selection edges to the millisecond; double-click selects a word or pause; drag a cut's edge to fine-tune it; word track synced with the transcript.
- **Word corrections** — fix a word transcription misheard: select it and press ↩ (or right-click → Correct word…). Corrected words are marked in green, undoable like any edit, and exports use the corrected text.
- **Text ↔ timeline linking** — right-click a word, cut, selection or pause for a context menu (play, preview, delete/restore, show in the other view); hovering the waveform underlines the word in the text.
- **Speech enhancement** (optional) — a clean-up that removes background noise and room echo, then an optional EQ preset, then the loudness for podcast delivery (Apple Podcasts, Spotify/YouTube or broadcast targets). The clean-up is DPDFNet by Ceva; the EQ and loudness work without it. Preview 15 s against the original first; the original is kept and you can switch between the two while playing, in step to the sample.
- **EQ** — presets for the voice, each named for what it fixes: Clearer (muddy), Warmer (thin: laptop, headset or lapel mic), Less boom (too close to the mic), Less boxy (small room), Less nasal, Brighter (dull, also after heavy noise removal), Less harsh (piercing, sharp S sounds) and Broadcast, at Subtle, Medium or Strong. Presets that lift the highs keep S sounds in check. The EQ runs between noise removal and the loudness target, into the same enhanced audio, with the same preview.
- **Pauses** — shorten long pauses to a Tight, Natural or Relaxed rhythm read from the transcript (pauses between sentences stay longer than pauses within one), with a preview first and one undo. Add a pause after any word; it's filled with the room's own quiet.
- **Speaker detection** (optional; NVIDIA Nemotron 3 Diarization) — finds who speaks when, for up to 8 people: turns become paragraphs under each speaker's name (rename or merge them in the Tools panel), the timeline shows who has the floor, you can select or delete everything one person said, and the names go into TXT, SRT and VTT exports.
- **AI agents (MCP)** — let Claude or ChatGPT edit with you. They can read the transcript, cut words, fillers or stretches of audio, fix mishearings, tighten pauses to a rhythm or add pauses, name speakers, enhance the audio (noise removal, an EQ preset, loudness), and export. Their edits appear live in the editor, marked with the agent's name, and undo like your own. See *Using Wave with Claude or ChatGPT* below.
- **Activity status** — one place for everything running in the background (imports, transcription, model downloads, the AI tools, exports): at the foot of the sidebar and in the editor's top bar, with a list of every job, cancel where possible, and progress on the Dock icon. Jobs keep going, and keep reporting, when you leave the editor.
- **Mac-native shell** — a hidden title bar, a full menu bar (⌘N, ⌘,, ⌘F, ⌘1/⌘2…), the window size remembered, and drag and drop: drop audio files anywhere on the window to create projects.
- **Find and redo** — ⌘F finds a phrase in the transcript, marks every match and cuts them one by one; ⇧⌘Z redoes.
- **Guidance** — a first-run checklist, a one-time hint in the editor, clear screens while a project imports or transcribes (with live progress), and Try again on anything that failed.
- **Keyboard shortcuts sheet** — press ? (or the keyboard button) for every shortcut, grouped; the inspector panel is resizable.
- **Hear edits in context** — C previews a cut before you make it (pre-roll, skip, post-roll); "Play what was cut" plays the removed audio; Tab jumps between cuts.
- **Non-destructive text-based editing** — select words and Delete; cuts show as red regions, edges ease to the quietest nearby point, per-action undo (⌘Z).
- **Silence detection** — long pauses surface as deletable `█` sentinels for one-click dead-air trimming.
- **Export** — the edited audio as MP3 (Spoken word 64 kbps mono, Podcast standard 128, 192, 320), AAC in .m4a (64 mono, 128, 256), WAV (16/24-bit) or FLAC (16/24-bit), spliced directly (no FFmpeg), with progress and the last choice remembered; transcript in TXT, SRT, WebVTT, JSON.

## Tech stack

| Layer | Choice |
|---|---|
| App shell | Tauri v2 (Rust ↔ React over IPC) |
| Frontend | React 19, TypeScript, Vite 7 |
| UI system | `@carbon/react` (IBM Carbon, g100 dark theme) |
| Transcript editor | TipTap 3 (custom inline word nodes) |
| Waveform | wavesurfer.js 8 + Regions / Hover plugins |
| Playback | Web Audio `EditPlayer` + signalsmith-stretch (speed) |
| Transcription | `whisper-rs` 0.16 (Metal GPU) |
| Word alignment | wav2vec2 (ONNX) via `ort` |
| Speech enhancement | DPDFNet (streaming ONNX) by Ceva, Apache-2.0, via `ort`, for the clean-up; EQ, de-esser, BS.1770-4 loudness and a true-peak limiter written in Rust (`realfft`) |
| Audio export | WAV with `hound`; AAC and FLAC with macOS's own encoders (AudioToolbox); MP3 with LAME 3.100 (LGPL), a separate library in the app, built by `src-tauri/vendor/lame/build.sh` |
| Speaker detection | NVIDIA Nemotron 3 Diarization (Streaming Sortformer, int8 ONNX) via `ort`, speaker cache in Rust — OpenMDW 1.1 |
| Audio decode / resample | symphonia → rubato → hound (16 kHz mono WAV) |
| Audio export | hound-based PCM splice (no FFmpeg) |

## Requirements

- **macOS 13.4 or later on Apple Silicon** — transcription uses the Metal GPU (`whisper-rs` `metal` feature), and ONNX Runtime's prebuilt library needs 13.4.
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
                            ├─ models.rs         download / manage the Whisper + alignment models
                            ├─ projects.rs       project CRUD, audio import, edits, export
                            ├─ transcription.rs  whisper-rs → word-level transcript (+ re-align)
                            ├─ alignment.rs      wav2vec2 CTC forced alignment
                            ├─ enhance.rs        speech enhancement: DPDFNet clean-up, EQ, loudness (master.rs)
                            ├─ speakers.rs       speaker detection (Nemotron 3 Diarization)
                            ├─ waveform.rs       the drawn waveform, computed natively
                            ├─ agent.rs          AI agents: the socket `wave mcp` talks to
                            ├─ mcp.rs            `wave mcp`, the MCP server agent apps launch
                            └─ settings.rs       selected-model persistence
```

All state lives on disk in the app data directory: models in `models/`, and per-project files (`audio_16k.wav`, `transcript.json`, `edits.json`, …) under `projects/{id}/`. Edits are stored as a non-destructive queue and only applied to PCM at export time.

For architecture details and conventions see [CLAUDE.md](CLAUDE.md). For the full build history and feature breakdown (Phases 1–25) see [PLAN.md](PLAN.md).

## Using Wave with Claude or ChatGPT

Wave includes an MCP server, so AI agents can work on your projects with the same edits you make.

1. In Wave, open **Settings → AI agents** and turn it on. The page shows the exact command for your copy of Wave.
2. Add Wave to your agent app once:
   - **Claude Desktop:** Settings → Developer → Edit Config, add the `wave` entry shown, then quit and reopen Claude.
   - **Claude Code:** `claude mcp add --scope user wave -- <command> mcp`
   - **ChatGPT desktop app** (Codex and Work modes) **or Codex:** Settings → MCP servers → Add server (STDIO, the command, argument `mcp`), or `codex mcp add wave -- <command> mcp`.
3. Keep Wave open, and ask, for example: *"In my project Episode 12, remove the false starts and filler words, tighten the pauses, fix any misspelled names, and enhance the audio with the Clearer EQ."*

**What needs to work**
- Wave must be running with agent access on. The agent app starts `wave mcp` itself; it reaches Wave through a socket only your user can open.
- Working on a project opens it in Wave's editor, and edits show up there as they're made.
- ChatGPT in the browser, and the desktop app's plain chat, only reach servers on the internet, so they can't use Wave.
- The command is this copy of Wave's executable. If Wave moves (say, from the dev build to an installed app), update the agent app's entry.
- Agents can't hear the audio. They work from the words, their timing and confidence, and the pauses, so give the result a listen.

## Status

Version 1.0.0: MVP complete through Phase 35. Out of scope for now: cloud sync and video.
