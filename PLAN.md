# Wave — Build Plan

Text-based audio editor for podcasts. Local-first, Mac-native via Tauri v2. Inspired by Descript.

---

## Stack

| Layer | Choice |
|---|---|
| Transcription (Rust) | whisper-rs 0.16 (in-process, Metal GPU) |
| Model download | reqwest + custom code (HuggingFace GGML) |
| Audio decoding | symphonia |
| Playback | WaveSurfer.js 7.12 (Web Audio API) |
| WAV I/O | hound |
| Audio splicing / export | hound-based custom splice (no FFmpeg) |
| Resampling | rubato 1.0.1 |
| Waveform visualization | wavesurfer.js 7.12 + RegionsPlugin |
| Transcript editor | TipTap 3.22 (@tiptap/react) |
| UI system | @carbon/react 1.104 (g100 dark theme) |

---

## Edit Model

When a user deletes a word:
1. Word node marked `deleted: true` in the `editActions` state (non-destructive — original audio untouched)
2. Edit op derived: `{ startMs, endMs }` with ±60ms boundary expansion for real words (not silences)
3. Preview: WaveSurfer skips deleted ranges in real-time via `seek` calls during RAF loop
4. Visual: deleted word ranges shown as red overlay regions on waveform; words in transcript styled with `wave-word--deleted` (red strikethrough)
5. Export: Rust `splice_audio` splices non-deleted PCM segments directly with hound, writing final WAV

---

## Phases

---

### Phase 1 — App Shell + Design System ✓

**Goal:** Carbon DS wired up, navigation works, pages exist as stubs. App feels like a real product.

- [x] Install and configure `@carbon/react` with g100 dark theme
- [x] IBM Plex fonts loaded locally (bundled by Vite via Carbon SCSS)
- [x] App layout: fixed left sidebar + main content area
- [x] Sidebar: app logo/name, Projects nav item, Settings nav item, active state
- [x] Projects page: empty state with "New Project" CTA
- [x] Settings page: stub with "Models" section header
- [x] Tauri window: 1280×820, min 960×600, native title bar
- [x] Global CSS tokens and custom design layer over Carbon

**Manually testable:** App launches, nav between Projects ↔ Settings, Carbon g100 renders correctly, no FOUC, fonts load.

---

### Phase 2 — Model Management ✓

**Goal:** User can download, monitor, and delete Whisper models from Settings.

- [x] Add `reqwest` (streaming) + `futures-util` + `tokio` to `Cargo.toml`
- [x] Rust: `list_models()` — scans app_data/models/, returns all 6 known models with status
- [x] Rust: `start_model_download(modelId)` — streaming download with resume, progress events, cancellation via AtomicBool
- [x] Rust: `cancel_model_download(modelId)` — sets cancel flag, keeps .part for resume
- [x] Rust: `delete_model(modelId)` — removes .bin and .part files
- [x] Edge cases: network errors, connection loss, disk full (ENOSPC), HTTP errors (404/429/503), size mismatch, partial resume
- [x] Settings > Models: 2-col card grid with description, speed/accuracy dots, size, requirements
- [x] Status states: Not Downloaded / Partial (resume) / Downloading / Ready / Error
- [x] Download: `ProgressBar` + speed (MB/s) + ETA + bytes counter
- [x] Frontend `useModels` hook — event listeners, optimistic updates, error map
- [x] Projects page: warning banner + modal gate when no model is ready

**Manually testable:** Download `ggml-tiny.en.bin`, see progress, see Ready tag, delete it, see Not Downloaded.

---

### Phase 3 — Projects + Audio Import ✓

**Goal:** Create a project, import audio, store it on disk with proper format conversion.

- [x] Rust: project data model (`project.json`: id, name, created_at, audio_path, status)
- [x] Rust: `create_project(name)` — creates `{app_data}/projects/{id}/` dir + `project.json`
- [x] Rust: `list_projects()` — returns all projects sorted by created_at desc, repairs stale `importing` state on startup
- [x] Rust: `import_audio(project_id, source_path)` — symphonia decode → rubato resample → hound 16kHz WAV (`audio_16k.wav`); original file copied as `audio_original.*`
- [x] Projects page: card grid — name, date, status badge, import progress bar
- [x] New Project: Carbon `Modal` → text input for name → native file picker (tauri-plugin-dialog)
- [x] Project card: shows full status lifecycle (Empty / Importing / ReadyToTranscribe / Transcribing / Ready / Error)

**Manually testable:** Create project, import MP3, verify `audio_16k.wav` in project dir. Project tile appears in grid with progress bar.

---

### Phase 4 — Transcription Engine ✓

**Goal:** Transcribe imported audio using a local Whisper model. Get word-level timestamps.

- [x] Rust: `transcribe(project_id, model_id)` async command
  - Load model from `{app_data}/models/ggml-{id}.bin`
  - Read `audio_16k.wav` via hound → raw PCM f32
  - Run whisper-rs 0.16 with `token_timestamps: true`, Metal GPU via `metal` feature
  - Extract word-level tokens (sub-word merging, special token filtering)
  - Write `transcript.json` to project dir (`words[]`, `language`, `durationMs`)
- [x] Tauri events: `transcription:progress { projectId, percentage }`, `transcription:complete`, `transcription:error`
- [x] Settings: `get_settings` / `set_settings` — persist `selectedModelId` to `settings.json`
- [x] Settings page: "Active model" badge + "Use for transcription" button per ready model card
- [x] Auto-transcription: triggers automatically after import completes using selected model
- [x] Auto-select: first downloaded model auto-becomes selected model
- [x] Project status lifecycle: Importing → ReadyToTranscribe → Transcribing → Ready
- [x] Transcription progress bar (teal) on project card, distinct from import bar (amber)

**Manually testable:** Import audio, watch transcription start automatically, see teal progress bar, open project dir and inspect `transcript.json`. Spot-check 3–5 timestamps against audio. Download a second model → Settings shows "Use for transcription" button; clicking it persists the selection.

---

### Phase 5 — Text Editor + Playback ✓

**Goal:** Transcript renders in TipTap with word-level nodes. Audio playback with word-accurate highlight, keyboard shortcuts, and dual display modes.

**Editor layout (full-window, no sidebar):**
- [x] `EditorTopBar`: back button, project name, filename, status badge, view mode toggle (Flow | Segments)
- [x] `wave-editor-body`: transcript editor (flex 1) + `InspectorPanel` (260px fixed)
- [x] `TimelineBar`: 80px strip at bottom — playback controls docked here

**Transcript editor:**
- [x] Install `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit` (v3.22)
- [x] Custom `WordExtension`: inline atom node, attrs `{ id, text, startMs, endMs, confidence, deleted }`
- [x] Words grouped into paragraphs on silence gaps ≥ 1.5 s
- [x] Confidence colours: high = normal, mid 60–80% = `#a8a8a8`, low <60% = amber
- [x] `onWordClick` callback → seek audio to `startMs`

**Playback (HTML5 Audio element, `usePlayback` hook):**
- [x] `HTMLAudioElement` backed by `asset://` protocol via `convertFileSrc`
- [x] RAF-based `currentMs` tracking for sub-frame accuracy
- [x] `play()`, `pause()`, `toggle()`, `seek(ms)`, `setRate(rate)`
- [x] `PlaybackControls` docked inside timeline bar: −5s, play/pause, +5s, time display, speed selector (0.5×–2×)

**Word-accurate highlight:**
- [x] Binary-search `transcript.words` by `currentMs` → `activeWordId`
- [x] DOM manipulation (no re-render): add/remove `.wave-word--active` class
- [x] Auto-scroll to keep highlighted word in view

**Keyboard shortcuts:**
- [x] `Space` → play / pause
- [x] `← →` → seek ±5 s
- [x] `J / L` → speed −0.25× / +0.25×
- [x] Displayed in Inspector → Details tab (Shortcuts section)

**Dual display modes:**
- [x] **Flow mode**: TipTap continuous flowing text (default)
- [x] **Segments mode**: timestamp-chunked view, each cue shows timestamp + ~12 words, mimics a prompter / subtitle layout

**Inspector panel:**
- [x] Export tab: Plain Text, SRT, WebVTT, JSON — native save dialog → `save_text_file` command
- [x] Audio export section (MP3/WAV) — disabled, "future update" note
- [x] Details tab: language, duration, word count, avg. confidence (colour-coded)
- [x] Shortcuts section (always visible in Details tab)

**Rust additions:**
- [x] `get_transcript(project_id)` → reads `transcript.json`
- [x] `save_text_file(path, content)` → writes export files
- [x] `get_audio_path(project_id)` → returns filesystem path to `audio_16k.wav`
- [x] Asset protocol enabled in `tauri.conf.json` for `$APPDATA/**`

**Manually testable:** Open a transcribed project. Press Space — audio plays; words highlight word-by-word in sync. Click any word — audio jumps to that position. Arrow keys seek ±5s. Switch to Segments view — same playback, text shown as timestamped cue blocks. Open Inspector → Details to see shortcuts. Export as SRT — check timestamps align with audio.

---

### Phase 6 — Waveform Timeline (Synced Dual View) ✓

**Goal:** Waveform and transcript fully synced. Playback controls working. Bidirectional selection.

- [x] Install `wavesurfer.js@7.12.5`
- [x] `useWaveform` hook: owns `containerRef`, creates WaveSurfer (`interact: false`) with `RegionsPlugin`, RAF loop for sub-frame `currentMs`; individual region refs for active-word and selection (no `clearRegions`)
- [x] Peaks caching: `load_peaks` / `save_peaks` Rust commands; peaks loaded before WaveSurfer init for instant render, saved on `ready` event
- [x] `WaveformTimeline`: toolbar (Cursor / Blade buttons, 28px) + waveform canvas (88px) + playback controls (52px) stacked in `.wave-timeline` (flex column)
- [x] Waveform overlay: transparent absolute div intercepts pointer events — click = seek, drag = emit selection range
- [x] `EditorPage`: `selectionRange` state syncs bidirectionally — editor mouseup → detect selected word spans → `setSelectionRange`; waveform drag → `setSelectionRange` → DOM word highlight (`wave-word--selected`, blue) + waveform selection region (cornflower blue)
- [x] Active-word region: amber (`rgba(232,160,32,0.10)`); Selection region: cornflower blue (`rgba(100,149,237,0.22)`); both managed independently
- [x] Escape key clears selection
- [x] Blade tool: visual placeholder for Phase 7 cut operations

**Manually testable:** Play audio — waveform cursor and amber word highlight in sync. Drag on waveform → words in range turn blue, waveform shows blue region. Select text in editor → waveform shows blue region for that time range. Escape clears selection.

---

### Phase 7 — Text-Based Editing (Core Feature) ✓

**Goal:** Delete selected words → non-destructive edit queue → skip-based preview playback → visual red overlays.

Selection (Phase 6) is the entry point for all edits — nothing is deleted without a selection.

- [x] `editActions: EditAction[]` state in `EditorPage`; each action has `{ id, label, wordIndices[] }` where indices are into `enrichedWords[]`
- [x] `Delete` key when `selectionRange` is set → find all word indices in range → add `EditAction` → clear selection
- [x] DOM effect: deleted words get `wave-word--deleted` class (red strikethrough, reduced opacity)
- [x] Waveform deleted regions: red (`rgba(255,80,80,0.18)`) overlaid on canvas via `setDeletedRegions`
- [x] Skip-based preview: RAF loop detects when `currentMs` is inside a deleted range → `seek` to end of that range; no re-encoding needed
- [x] Edit ops derived from `editActions`: deleted word time ranges merged, expanded ±60ms (Whisper boundary imprecision); silences use exact boundaries (no expansion)
- [x] Undo: per-action undo from Inspector → Edits tab; `Cmd+Z` pops most recent action
- [x] Blade tool: click on waveform → calls `onDeleteAtMs` → deletes the word at that timestamp
- [x] Edit persistence: `save_edits` / `load_edits` Rust commands write/read `edits.json` in project dir; loaded on project open with `editsLoadedRef` guard to prevent race with save
- [x] Inspector → Edits tab: lists all cuts in reverse order, each with an Undo button
- [x] Playback audio: `get_playback_audio_path` Rust command returns `audio_original.*` (stereo, native quality) for WaveSurfer; falls back to `audio_16k.wav` if original can't be decoded (`waveError` state)

**Manually testable:** Select words, press Delete — words strike through, waveform shows red region, audio skips over cut. Undo from Inspector or Cmd+Z restores. Navigate away and back — edits survive. Blade tool click removes a single word at that waveform position.

---

### Phase 8 — Export ✓

**Goal:** Export final edited audio as WAV; export transcript in multiple formats reflecting edits.

- [x] Rust: `export_audio(project_id, ops[], dest_path)` — reads `audio_16k.wav` (or `audio_original.*`), splices non-deleted PCM segments via `splice_audio` helper, writes final WAV to user-chosen path
- [x] Inspector → Export tab: WAV audio export with native `save` dialog (tauri-plugin-dialog); button shows cut count or "no cuts" note
- [x] Transcript exports use `filteredWords` (deleted words AND silence sentinels excluded) so exported text/subtitles reflect edits
- [x] Transcript export formats: Plain Text (`.txt`), SRT (`.srt`), WebVTT (`.vtt`), JSON (`.json`) — all with updated timestamps post-edit
- [x] Export buttons show spinner (`…`) while busy; errors shown inline below the WAV section
- [x] WAV export button uses Download icon (not speaker icon)

**Manually testable:** Make cuts, export WAV — open in QuickTime, duration is shorter by the sum of deleted segments, no audible glitches. Export SRT — timestamps in file match the edited audio. Export JSON — word array excludes deleted words.

---

### Phase 9 — Silence Detection ✓

**Goal:** Surface long silence gaps in the transcript as deletable sentinels, giving users an easy way to trim dead air.

- [x] Frontend-only `enrichWithSilences(words)` function in `EditorPage` — no new ML inference; uses existing Whisper timestamps
- [x] Silence threshold: gaps ≥ 3000ms between consecutive words are injected as `EnrichedWord` sentinels: `{ text: '█', isSilence: true, startMs, endMs, confidence: 1.0 }`
- [x] `EnrichedWord` type: extends `TranscriptWord` with `isSilence: boolean`
- [x] `enrichedWords` useMemo replaces raw `transcript.words` throughout `EditorPage`
- [x] `filteredWords` (for export) excludes both deleted words AND silence sentinels
- [x] `currentOps` skips ±60ms boundary expansion for silence entries (they are the gap, not words with imprecise timestamps)
- [x] `WordExtension` gains `isSilence` attr; silence words rendered with `wave-word--silence` class — monospace `█`, muted colour, hover highlight, opt-in deletion like any other word
- [x] `TranscriptEditor` paragraph logic: silence sentinels force paragraph breaks before and after (regardless of time-gap check, since gap = 0 after injecting the sentinel)
- [x] `SegmentsView` updated: silence sentinels each get their own cue (no timestamp shown), rendered with `wave-segment--silence` class
- [x] `activeWordId` returns `null` for silence entries (no waveform highlight region)
- [x] Edit label for silence deletions: `"silence at 0:12"` format

**Manually testable:** Open a recording with 3+ second pauses — `█` symbols appear in transcript at those positions. Click a `█` to seek to that silence. Select it and press Delete — silence range added to edits, waveform shows red region over the gap. Export WAV — silence gap removed from audio.

---

### Phase 10 — Waveform Zoom + Word-Boundary Awareness ✓

**Goal:** Let users zoom the waveform for precision trimming; keep zoom, scroll, and word-snapping all in sync.

- [x] `zoomLevel: number` and `wrapperScrollLeft: number` added to `WaveformState` in `useWaveform`
- [x] `setZoom(level)` callback: clamped [1, 32]; computes `basePxPerSec = containerWidth / durationSecs`, calls `ws.zoom(basePxPerSec × level)`; syncs `zoomLevel` state
- [x] `getWrapper()` callback: returns WaveSurfer's inner scrollable wrapper element
- [x] RAF loop extended: reads `ws.getWrapper().scrollLeft` each tick → `wrapperScrollLeft` state (triggers marker re-layout via CSS)
- [x] `xToMs` corrected for zoom and scroll: `time = (wrapperScrollLeft + localX) / (containerWidth × zoomLevel) × durationMs`
- [x] Wheel handler (non-passive, registered in `useEffect`): `ctrlKey=true` (trackpad pinch or Ctrl+scroll) → zoom via `zoomLevelRef.current`; `ctrlKey=false` (two-finger swipe) → forwards `deltaX`/`deltaY` to `wrapper.scrollLeft`
- [x] `zoomLevelRef` kept in sync during render to avoid stale closure in wheel handler
- [x] Keyboard shortcuts: `=`/`+` → zoom in 1.5×, `-` → zoom out 1.5÷, `Cmd+0` → reset zoom to 1×
- [x] Zoom toolbar in `WaveformTimeline`: ZoomOut button (disabled at 1×), zoom level label (shown when >1.01×, IBM Plex Mono), ZoomIn button, "1×" reset button (shown when zoomed)
- [x] **Time ruler** (`WaveformRuler` component): tick labels scroll with waveform via `wave-ruler__inner` div (`width: zoomLevel×100%`, `transform: translateX(-wrapperScrollLeft px)`); tick density adapts to visible time window (`visibleMs = durationMs / zoomLevel`); playhead marker synced
- [x] **Word boundary markers**: shown when `zoomLevel ≥ 1.5`; positioned with `calc(startMs/durationMs × zoomLevel × 100% - wrapperScrollLeft px)` — scroll-synced without JS per marker; 1px blue line with dot at top
- [x] **Snap-to-word**: on drag-release, both selection endpoints snap to nearest word boundary within threshold `max(50, min(500, 500 / zoomLevel))` ms — tighter threshold at higher zoom for precision

**Manually testable:** Pinch to zoom on trackpad — waveform expands, ruler ticks update. Two-finger swipe — waveform scrolls. Boundary markers appear when zoomed ≥1.5×. Drag-select near a word boundary — selection snaps to exact word edge. Zoom to 8× and trim a single word precisely. Reset with Cmd+0 or "1×" button.

---

## Out of Scope for MVP

- Speaker diarization
- AI-assisted editing ("remove all filler words")
- Collaboration / cloud sync
- Video support
- Noise removal / audio enhancement
