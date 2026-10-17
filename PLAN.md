# Wave — Build Plan

Text-based audio editor for podcasts. Local-first, Mac-native via Tauri v2. Inspired by Descript.

---

## Stack

| Layer | Choice |
|---|---|
| Transcription (Rust) | whisper-rs 0.16 (in-process, Metal GPU) |
| Word alignment (Rust) | wav2vec2-base-960h int8 ONNX via `ort` 2.0.0-rc.13 (CTC forced alignment) |
| Model download | reqwest + custom code (HuggingFace) |
| Audio decoding | symphonia |
| Playback | custom `EditPlayer` (Web Audio, gapless cuts) + signalsmith-stretch 1.3.2 (patched) for speed changes |
| WAV I/O | hound |
| Audio splicing / export | hound-based custom splice (no FFmpeg) |
| Resampling | rubato 1.0.1 |
| Waveform visualization | wavesurfer.js 8.0 + Regions + Hover plugins |
| Transcript editor | TipTap 3.22 (@tiptap/react) |
| UI system | @carbon/react 1.104 (g100 dark theme) |

---

## Edit Model

When a user deletes a word:
1. Word node marked `deleted: true` in the `editActions` state (non-destructive — original audio untouched)
2. Edit op derived: `{ startMs, endMs }` — adjacent deleted words form one range, padded up to 60 ms into neighbouring gaps, with edges that touch another word eased to the quietest nearby point
3. Preview: `EditPlayer` plays the kept segments gaplessly on the audio clock, joined by the export's 8 ms crossfade
4. Visual: cuts shown as red regions on the waveform whose edges can be dragged (an undoable "adjust" edit); words in transcript styled with `wave-word--deleted` (red strikethrough)
5. Export: Rust `write_spliced` splices the original audio at native quality with the same crossfade, writing the final WAV

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

### Phase 11 — Free-Region (Non-Text) Cutting + Gentle Splicing ✓

**Goal:** Cut *any* waveform region — including audio with no transcript word attached (breaths, pauses < 3 s, room tone, music) — with click-free "gentle" splicing.

- [x] `EditAction` gains optional `range: { startMs, endMs }` for cuts not tied to a word (word-based actions keep `wordIndices`, `range` is undefined)
- [x] `deleteSelection` branches: selection overlapping ≥1 word → word cut (existing ±60 ms padded behaviour); selection overlapping **no** words → raw time-range cut of the exact selected span
- [x] `currentOps` merges word-derived ops **and** free-range ops (sort by start, merge ≤ 10 ms gaps); range cuts flow through the existing red-region overlay, skip-on-playback, undo, Edits tab, and export with no extra wiring
- [x] Edit label for free-range cuts: `"cut 1.4s at 0:12"`
- [x] Gentle splicer `write_spliced` (channel-aware): sort + merge cut ranges → **zero-crossing snap** (±2 ms) on each edge → **equal-power (cos/sin) crossfade** (8 ms) per channel at every join (replaces the old fade-to-silence which dipped at the cut) → 16-bit PCM out; shared by `splice_audio` (WAV) and `splice_original` (decoded source)
- [x] Helpers `nearest_zero_crossing_frame` + `find_original_audio`
- [x] **Full-fidelity export**: `export_audio` decodes and splices `audio_original.*` at its native sample rate + channels via `decode_to_interleaved_f32`, falling back to the 16 kHz mono WAV only if the original is missing or undecodable. Preview (`generate_preview`) still uses the 16 kHz WAV (speed + WebView compatibility).

**Manually testable:** Zoom in on the waveform, drag-select a breath or pause between words (no text under it), press Delete — the region turns red, playback skips it, and the exported WAV has a smooth, click-free join.

**Known follow-ups (not done):**
- Live-preview skip is a seek jump (no live crossfade); only generated/exported files get the gentle splice.
- Optional snap-to-silence so a roughly-drawn selection auto-tightens to the quietest boundary (avoids clipping a neighbouring word's tail/onset).

---

### Phase 12 — Accurate Word Timing + Single Model ✓

**Goal:** Word timestamps that match the audio, so a text edit cuts exactly what it appears to cut, and ship only the model that does this well.

- [x] **DTW token timestamps** (whisper.cpp cross-attention alignment, `DtwModelPreset::LargeV3Turbo`) replace the legacy timestamp-token heuristic
- [x] Words assembled from **Whisper's leading-space boundaries**; punctuation, apostrophes and hyphens attach to the current word (the 80 ms timestamp-gap rule is gone)
- [x] **`refine_with_vad`** replaces `refine_word_onsets`: an energy VAD with an adaptive threshold (loud speech p90 − 25 dB, ≥ noise p10 + 10 dB, clamped to −55…−25 dBFS) snaps word starts to speech onsets after ≥ 200 ms pauses and trims word ends back through silence, so pauses become real gaps
- [x] Detected language stored in `transcript.json` (was hardcoded `en`); `run_whisper` decoupled from Tauri (progress via callback)
- [x] Model catalog reduced to **Large v3 Turbo** (`KNOWN_MODELS` + `MODEL_CATALOG`); a saved selection naming a removed model is re-pointed to a ready one; the Settings card skips models the catalog doesn't describe
- [x] Editor: adjacent deleted words are cut as **one contiguous range** — internal pauses no longer survive as slivers of audio in preview and export

**Measured on a 15.5-minute recording (same model, identical words — 8,237 letters before and after):**

| | Before | After |
|---|---|---|
| Words whose span sits on silence | 17.4% | 1.9% |
| Onset error where speech resumes after a pause (median / p90) | 150 / 470 ms | 20 / 210 ms |
| Split words / detached punctuation | 21 / 38 | 0 / 0 |
| Pause time ≥ 0.5 s visible as gaps | 112.6 s | 205.8 s |
| Transcription time | — | 59 s (~16× real time) |

**Known follow-ups:** preview skips cuts from a `requestAnimationFrame` loop, which WebKit throttles when the window is in the background (deleted audio can play) — native preview playback fixes this; mid-sentence word boundaries are at DTW precision (CTC forced alignment if that proves insufficient); projects transcribed before this phase must be re-transcribed to benefit. *(The first two are resolved in Phase 13.)*

---

### Phase 13 — Forced Alignment, Gapless Preview, Editable Waveform ✓

**Goal:** Cutting a word removes all of it: no leftover start of the word, no abrupt join. When a boundary is still off, it can be fixed by hand on an Audition/Audacity-style waveform.

**Word timing**
- [x] **CTC forced alignment** (`alignment.rs`, the WhisperX approach): wav2vec2-base-960h (int8 ONNX, 91 MB, Apache-2.0) via `ort`. Words are chunked at pauses (~15 s), letters Viterbi-aligned to the model's per-frame output, numbers/symbols spelled out first, and unalignable words interpolated
- [x] Runs automatically after transcription for English when the aligner is downloaded, then a gentler VAD pass that only moves starts earlier and never into the previous word
- [x] `realign_transcript` + **Re-align words** (Details tab) re-times an existing project without re-transcribing; edits survive because the edits fingerprint is now text-only (old fingerprints still load)
- [x] Settings gains a **Word alignment** section; the aligner never appears as a transcription choice

**Preview playback**
- [x] **`EditPlayer`** replaces the RAF seek-skip: kept segments are scheduled on the audio clock with the export's 8 ms equal-power crossfade, so what plays is what exports, and it stays exact in a background window
- [x] Pitch-preserving speed changes via **Signalsmith Stretch**, fed the pre-edited signal in 15 s chunks (no 250 MB+ copy into the audio thread)
- [x] Dependency patch for signalsmith-stretch 1.3.2: its read loop crashed the worklet with more than one input buffer (no fixed release exists)
- [x] Seeking while playing restarts from the new position (it used to resume from the old one)

**Waveform**
- [x] wavesurfer.js 8 drawn from a **1 ms max/min envelope**: accurate down to 1000 px/s, versus smeared peaks before
- [x] Cut regions with **draggable edges**: each drag is an undoable "Cut start → 0:34.08"-style edit that overrides that edge
- [x] Drag on the waveform to select; hover readout with millisecond time; zoom (buttons, ⌘-scroll, pinch) keeps the cursor or playhead fixed on screen
- [x] **Gentle cut edges**: where a cut touches a neighbouring word, the edge eases to the quietest 10 ms frame within 70 ms, if one is ≥ 3 dB quieter

**Measured on a 22-minute recording (same words; truth = 381 speech onsets / 425 offsets at pauses ≥ 300 ms):**

| | DTW + VAD (Phase 12) | + forced alignment |
|---|---|---|
| Words whose span sits on silence | 80 | 7 |
| …of which pushed late into a pause | 76 | 4 |
| Implausibly short words (< 40 ms) | 19 | 1 |
| Pauses ≥ 300 ms visible between words | 317 (253 s) | 385 (315 s) |
| Start error at onsets after pauses (median / p90) | 20 / 20 ms | 20 / 25 ms |
| End error at offsets before pauses (median / p90) | 30 / 40 ms | 30 / 30 ms |
| "acknowledging" (a reported leftover) | 34.56–34.88 s | 34.10–34.68 s |
| Alignment time (debug build) | — | 71 s (~18× real time) |

Pause boundaries were already good after Phase 12. The gain is mid-phrase: words that were late or sat on silence (the "first bit of the word still plays" bug) now cover their audio. Preview at 1× matches the source exactly; at 1.5× it stays within a median 1.2 dB with no dropouts across cuts and chunk refills.

**Manually testable:** In Settings, download Word Alignment. Open a project, then Details → Re-align words. Delete a word and play across it: no leftover onset and no click. Zoom in on the cut and drag its red edge; the Edits tab shows the adjustment and Undo restores it. Repeat at 1.5×.

**Known follow-ups:** alignment is English-only (other languages keep DTW + VAD timing); `load_peaks`/`save_peaks`/`generate_preview` and `usePlayback` are now unused.

---

### Phase 14 — Timeline UX: One Selection, Smart Zoom, Edits in Context ✓

**Goal:** Make the waveform behave like a real editor (Audition, Audacity, Descript, Hindenburg), with every timeline action landing cleanly on the text.

**Fixes**
- [x] Dragging a selection no longer tints everything before the playhead orange. That was wavesurfer's "played" colour, which audio editors don't use, and it made the whole waveform look selected. `progressColor = waveColor` now, and the selection is one screen-blended band with the waveform lit inside it.
- [x] Strikethroughs survived re-alignment but not a Flow ↔ Segments switch; they now survive both.

**Text ↔ timeline**
- [x] **Right-click a word** in the transcript (a whole segment from its timestamp in Segments view, or the whole selection if you click inside it). This outlines it in purple on the waveform and word lane, underlines it in the text, and brings it into view, zooming in to about 4 s of context if it's too thin to see. A menu (Carbon `Menu`) then offers: Play / Play original · Play from here · Preview cut · Select · Zoom · Delete / Restore · Clear highlight.
- [x] **Right-click the waveform** gets the same menu for whatever is under the pointer:
  - a **cut**: Preview edit · Play what was cut · Show in transcript · Zoom · Restore cut
  - the selection
  - a word
  - a **pause** (selection-like actions, plus Cut)
- [x] Selections drawn on the waveform **snap to word edges** within 8 px, so the text selection matches exactly. ⌥ places them freely.
- [x] **Double-click** the waveform to select the word, or the pause between two words.
- [x] **Hovering** the waveform underlines the word under the pointer in the transcript.

**Zoom and navigation**
- [x] Context-aware zoom anchor for the keyboard and buttons: the pointer if it's over the waveform, else the selection, else the playhead, else the centre. ⌘-wheel and pinch stay anchored at the pointer.
- [x] **Z** zooms to the selection or highlight, and pressing it again returns to the previous view. **⇧Z** fits the whole file. There's also a toolbar button.
- [x] **Tab / ⇧Tab** jump to 2 s before the next or previous cut and show it.
- [x] Follow-playhead turns a page at a time (Premiere's default) and **pauses while you scroll or zoom away**. It resumes when the playhead is back in view or playback restarts.
- [x] A **live readout** of the selection's start, end and length in the toolbar.

**Hearing edits**
- [x] **C** previews a cut before you make it: 2 s pre-roll, the exact cut Delete would make (`computeCutOps` on a hypothetical edit, so padding and gentle edges included), 1 s post-roll. With nothing selected, it previews the next cut.
- [x] `EditPlayer.playRange(start, end, { ignoreCuts, extraCuts })` plays a range once and stops; `ignoreCuts` plays what was removed.

**Verified (browser, real 15-min project):**
- Snapped selection lands exactly on the word boundaries (4:30.96–4:31.56).
- C scheduled 268.96→270.96 · skip · 271.62→272.56, and committed nothing.
- Z then Z restored zoom 223.6× and scroll 6880 px exactly.
- Scrolling away during playback held the view.
- Restore cut removed the cut and un-struck the word.

**Revised after testing in the app (WebKit):**
- **Whole window highlighted on a waveform drag:** wavesurfer only cancels *pointermove*, so WebKit started a page-wide text selection. Fixed with our own drag handler that cancels `mousedown`, plus `user-select: none` on the timeline. The selection's `mix-blend-mode` was dropped too, because WebKit composites it unreliably.
- **Small selections came out too big:**
  - The Regions plugin starts drawn selections 5 px wide (~350 ms at 10×). Replaced with an exact handler: a 150 ms drag measured 150 ms.
  - Word snapping (8 px) pulled edges to words. It's now an opt-in toggle (6 px, off by default).
  - Delete removed every word a selection *touched*. A waveform selection is now cut exactly as drawn, unless it's exactly whole words. A 59 ms trim of a word's tail cuts 59 ms; the word stays, with a "partly trimmed" underline.
- **Right-click no longer highlights or zooms by itself.** It's a normal context menu whose header names the target. "Show in timeline" / "Show in transcript" are explicit items.
- Added ⇧/⌥⇧ ←/→ fine-tuning of the selection edges (10 ms, ⌘ for 1 ms), a millisecond readout, and millisecond edit labels.
- Removed `mixed-decls` from Sass `silenceDeprecations` (obsolete in Sass 1.98; it caused a warning).

**Backlog (from the same research, not built yet):**
1. **Shorten pauses** to a target length (Descript's "shorten word gaps") rather than deleting them.
2. An **overview strip** (Audition's zoom navigator) showing cuts and the selection.
3. **Markers / chapters** anchored to words, exported as chapters.
4. **Replace with room tone**: a cut that keeps the timing.
5. **Keyboard nudging of cut edges** (selection edges are done), and a key to jump an edge to the next word.
6. **⌘-drag a word's edge** in the word lane to fix its timing without cutting.
7. Optional **audio skimming**.

---

### Phase 15 — Filler Detection (Uhm by Desert Ant Labs) ✓

**Goal:** Whisper leaves out "um", "uh" and "hmm". Detect them on-device and make them removable from the text, using Desert Ant Labs' Uhm model.

- [x] Model: `uhm.onnx` (fp32, 94 MB), pinned to tag `v1.1.0` (the tag their SDK pins). It's listed in Settings → **AI enhancements**, with the "Powered by Desert Ant Labs" credit and licence link that the licence requires.
- [x] `fillers.rs`: a Rust port of their `Detector.swift`.
  - 30 s windows with a 25 s hop.
  - Filler probability = 1 − p(not_filler), averaged over overlapping windows.
  - Run grouping: threshold 0.5, merge gaps ≤ 100 ms, drop runs under 100 ms.
  - Unit tests cover the grouping.
- [x] **Input preprocessing measured, not assumed.** The SDK mean/std-normalises each window; their browser reference feeds raw audio. On 160 labelled AMI utterances (CC BY 4.0):

  | Input | AUC | Fillers caught |
  |---|---|---|
  | Raw | 0.90 / 0.88 | 59 / 80 |
  | Normalised | 0.81 / 0.84 | 49 / 80 |

  False alarms were about the same. Raw holds up from ¼ to 4× gain, so Wave feeds raw audio (`tests::preprocessing`).
- [x] Speed: about 45× realtime on CPU in a debug build (15 min of audio in about 20 s).
- [x] Editor:
  - Inspector **Tools** tab (the home for AI enhancements):
    - Find fillers, with progress.
    - Sensitivity Fewer / Normal / More, which is the SDK's bias presets 0.75 / 0.65 / 0.50. It re-filters instantly and needs no re-run.
    - A show/hide toggle, saved in `fillers.json`.
    - Remove N / Restore all.
    - A list with jump, remove and restore for each filler.
  - Transcript:
    - Filler tokens are placed by time.
    - A transcript word that *is* a filler gets a dotted underline (the SDK's reconciliation rule).
    - Clicking a token selects its exact span; ⌫ removes it.
    - Right-click a removed filler for Restore filler.
  - Word lane: dashed filler chips.
- [x] Removing fillers is one undoable edit, cut exactly at the detected spans, with nudgeable edges. Fillers live outside `enrichedWords`, so changing sensitivity never shifts word indices.

**Manually testable:**
1. Settings → AI enhancements → download Filler Detection.
2. Open a project with unscripted speech → Tools → Find fillers.
3. Change Sensitivity, click a filler in the text and press ⌫, then use Remove N / Restore all.

The current test project is a scripted voice-over with almost no fillers: one borderline detection in 15 min.

**Open:**
- Licence: telemetry and open-source questions sent to licensing@desertant.com.
- Segments view doesn't show filler tokens yet.
- CoreML execution provider for speed.
- Clear (speech enhancement) is next.

---

### Phase 16 — Transcription as One Download ✓

**Goal:** Precise cuts shouldn't depend on finding an optional model. Whisper and the word aligner become one required **Transcription** entry in Settings.

- [x] `TRANSCRIPTION_BUNDLE` (`modelCatalog.ts`): Whisper Large v3 Turbo (speech recognition) + wav2vec2 (word alignment), 1.6 GB, with a short note on why there are two.
- [x] `useModels.downloadBundle` downloads the missing parts in sequence; the next part starts when the previous one's `model:complete` arrives. Cancel and Delete act on the whole bundle; Resume continues with only the unfinished part.
- [x] Settings: one **Transcription** card listing both parts with their state, "1 of 2 · Speech recognition" progress, speed and ETA. **AI enhancements** stays a separate, optional section. The old "Use for transcription" choice is gone (there is one transcriber).
- [x] `hasReadyModel` needs both parts, so creating a project requires the full bundle. Installs that only have Whisper see **Finish download (91 MB)**.
- [x] Rust is unchanged: alignment still runs only when the aligner is present, so non-English audio and older installs keep working.

**Manually testable:** Settings → Transcription → Download: Whisper, then the aligner, start one after another. Cancel during the second part, then Resume: only the aligner continues. Delete removes both.

---

### Phase 17 — Speech Enhancement (Clear by Desert Ant Labs) ✓

**Goal:** Turn a laptop, phone or untreated-room recording into clean, podcast-level audio on-device, without touching the original and without breaking text-based edits.

- [x] Models: `clear-studio.onnx` and `clear-natural.onnx` (DeepFilterNet 3 fine-tunes, fp32, 24 MB each), pinned to `v0.3.0`, the tag the SDK pins. They are one Settings entry, **Speech Enhancement**, with the licence credit. Bundle downloads are now tracked per bundle.
- [x] `enhance.rs`: a Rust port of the SDK pipeline (`Sources/Clear`, `Sources/AudioDSP`). The ONNX file is only the network.
  - Decode the original, mix to mono, resample to 48 kHz (rubato).
  - STFT: Vorbis window, 960/480, gain 1/960, 480-sample prepad (`realfft`).
  - Features: ERB dB and unit norm, including the state-init ramps the SDK calls load-bearing.
  - Independent 200-frame chunks with the features 2 frames ahead, on a pool of 4 sessions; then overlap-add and the strength blend.
  - Mastering: BS.1770-4 integrated loudness → one gain capped at +9 dB → 5 ms look-ahead limiter at −1.5 dBTP, written as 16-bit WAV.
  - Long files use the SDK's streaming path: 20 s windows, each re-fed the previous 4 s so the feature normalisation re-converges, both on the 2 s chunk grid.
- [x] **Parity:** the SDK's cross-runtime fixture (`clear-parity.json`) gives envelope 0.064, loudness +0.45 dB and true peak +0.56 dB against the Apple reference. The SDK reports the same numbers for its own Linux runtime (0.064, 0.44, 0.56). Apple differs because its Core ML model is palettised. See `tests::parity`.
- [x] **Measured** on 60 s of a clean voice-over with noise added at 15.6 dB SNR. Levels are inside pauses, at least 100 ms from speech:

  | | All noise | Hiss alone |
  |---|---|---|
  | Noisy | −37 dBFS | −48 dBFS |
  | Studio | −51 dBFS | −63.5 dBFS |
  | Natural | −46 dBFS | −52 dBFS |

  Natural keeps the room by design. Clean input stays at about −77 dBFS. Timing is unchanged (0-sample lag), so edits line up.
- [x] **Speed** on a 15-minute file: 12.4 s in release (72× real time) and about 40 s in a debug build.
- [x] **Editor**, in the Tools tab:
  - Options: Style (Studio / Natural), Strength (Subtle / Medium / Full, the SDK's 0.4 / 0.7 / 1) and Loudness (Podcast −19, Spotify/YouTube −14, Broadcast −23, or Off).
  - Progress by phase, with Cancel.
  - An Original/Enhanced switch, saved, that swaps the audio in place while playing. The waveform redraws, and position, zoom and cuts stay.
  - Apply changes when the options differ from the last run; Discard to delete the file.
  - Export uses whichever version is on. Enhanced audio exports as 48 kHz mono.
- [x] Transcription, alignment and filler detection always read the original 16 kHz file.

**Manually testable:**
1. Settings → AI enhancements → download Speech Enhancement.
2. Open a project → Tools → Enhance audio.
3. Play, and flip the switch to compare. Try Natural or another loudness target and click Apply changes.
4. Export the WAV with the switch on and off.

**Open:**
- Licence: the DSP follows the SDK's Swift code (the SDK is under the same source-available licence; the algorithm is DeepFilterNet's, MIT). Confirm with Desert Ant Labs that this is fine in an open-source app.
- Stereo is downmixed (the SDK default). Keeping stereo costs one pass per channel.
- CoreML execution provider for speed.

---

### Phase 18 — Settings and Inspector Tidy-up ✓

**Goal:** One consistent look built from the design system (Carbon g100 plus the amber accent), and an inspector that fits the work.

- [x] **Settings:** every download is the same Carbon `Tile` (`ModelTile`), whether it's a bundle or a single model.
  - Each part's state is an `IconIndicator`; downloads show a `ProgressBar` with speed and ETA; failures are an `InlineNotification` with Retry.
  - Credits use Carbon `Link`s; Delete is a `danger--ghost` button.
  - Sections are "Required" and "AI enhancements". Speed/accuracy dots, custom badges and their dead catalog fields are gone.
- [x] **Inspector:**
  - Carbon `Tabs`, with the selected tab in the accent and stretched to the panel width.
  - Tools are `Accordion` items with a status `Tag` (enhancement On/Off, filler count); their open state is saved.
  - Export, Edits, Details and the filler list are `ContainedList`s with `IconButton` actions. Tool options use `FormGroup`, `ContentSwitcher`, `Toggle` and `Select`.
  - Saved filler detections stay usable when the model is removed.
- [x] **Resizable panel:** drag the left edge, or press ←/→ when it's focused. The width runs from 300 to 480 px and always leaves the transcript at least 480 px. Double-click resets it to 320. It's saved.
- [x] **Keyboard shortcuts** moved out of the inspector into a sheet (Carbon `Modal`), opened with ? or the top bar's keyboard button. It covers all 18 shortcuts in four groups; the old list had 6. Arrow keys no longer seek while a tab list, switcher or menu has focus.
- [x] The confidence legend is removed. Afterwards, low-confidence words (< 60 %) became dimmed with a tooltip instead of amber, and the 60–80 % fade was dropped, so amber means only the playing word: a solid accent chip.
- [x] New styles use Carbon's type, spacing and theme tokens. 89 stale rule blocks were removed from `global.scss`.

---

### Phase 19 — Speaker Detection (NVIDIA Nemotron 3 Diarization) ✓

**Goal:** Know who speaks when, so a conversation reads as one and exports carry the names.

- [x] **Model choice:** Nemotron 3 Diarization (released 23 Sept 2026, OpenMDW 1.1, ungated, up to 8 speakers, end to end so there's no clustering to tune). The alternatives:
  - pyannote Community-1 needs a Hugging Face account and is weaker on overlapping speech.
  - DiariZen's weights are non-commercial.
  - Desert Ant Labs has no diarization model.
- [x] **Runtime:** the onnx-community export, int8 (120 MB), pinned to commit 353b6f8. It's two files, so the download manager learned **companion files**. Python and PyTorch were used only to check it, never shipped.
- [x] `speakers.rs` ports transformers' implementation:
  - Mel front end.
  - Offline chunking: 340 frames plus 40 of look-ahead.
  - The Arrival-Order Speaker Cache (264 frames) with its scoring, boosts and silence slots, plus the 40-frame FIFO.
- [x] **Checked against the reference** on a 42.6-minute In Our Time episode (presenter plus three guests):

  | Version | Frame decisions agree |
  |---|---|
  | Python prototype, fp32 ONNX | 99.984% |
  | Python prototype, int8 ONNX | 99.975% |
  | Rust, int8 ONNX | 99.975% |

  - Features within 0.0002 of the reference.
  - Talk time per speaker identical: 305, 646, 609 and 572 s, plus 13 s of announcer.
  - Speed: 33.5 s for the episode in release (76× real time); features take 0.3 s.
- [x] **Editor:**
  - Tools → Speakers: Detect, a list with colour, rename field and talk time, Show in transcript and exports, and Detect again.
  - Flow: each turn starts a paragraph labelled with the name (CSS over paragraph attributes, so labels are never text).
  - Segments: split at turns, named where the speaker changes.
  - Exports: TXT `Name: …` per turn; SRT `Name: ` at changes; VTT `<v Name>`; JSON `speaker` per word.
- [x] Words get a speaker by overlap with the saved segments, so re-aligning keeps speakers.
- [x] A `transcription::tests::transcribe_file` dev test transcribes any WAV as the app does.

**Manually testable:** Settings → AI enhancements → download Speaker Detection. Open a conversation → Tools → Speakers → Detect speakers. Rename the speakers, check Flow and Segments, and export TXT and SRT.

- [x] **Follow-ups:**
  - Speaker colours on the waveform: a strip under the word lane, turn by turn.
  - Merge a speaker into another (non-destructive: Separate undoes it, and Detect again keeps it).
  - Select everything one person said, from the Speakers panel or a word's right-click menu. ⌫ deletes it as one undoable edit.

  Tested on the episode: merging the 13 s announcer into the presenter, separating them again, and selecting then deleting 1,770 words in one edit and undoing it.

**Open:** speed (a long file still takes a while in a debug build).

---

### Phase 20 — Native Waveform, Word Corrections, Polish ✓

**Goal:** The editor opens like a native app, misheard words can be fixed, and the transcript's marks are calm.

- [x] **Import speed:** an MP3 import that sat at 15% was Wave's dev build running symphonia and rubato unoptimised. Dev builds now compile dependencies at opt-level 3 and Wave's crate at 1. A 42-minute MP3 decodes in 1.3 s and resamples in 2.2 s in `tauri dev`.
- [x] **The waveform appears at once.** It used to arrive seconds after the text: the WebView decoded the whole compressed file (`decodeAudioData`, 6.9 s for the 42-minute MP3) and then scanned every sample in JavaScript on the UI thread (0.55 s) before drawing anything.
  - `waveform.rs` computes the 1 ms envelope and 10 ms energy in Rust, during the decode import already does, and saves `waveform.bin` (11 MB for the episode). Projects imported earlier build it on first open (1.7 s).
  - The editor draws from it straight away (0.6 s after opening, down from about 7.6 s) and decodes the audio for playback in the background. Play pressed before the audio is ready waits for it; the button pulses meanwhile.
- [x] **Word corrections:** ↩ on a selected word, or right-click → Correct word…, opens a field under the word. The correction is an undoable edit (Edits list, ⌘Z) and shows in green; right-click → Back to "…" restores what was heard. Flow, Segments, the word lane and all exports use the corrected text.
- [x] **The playing word no longer flashes:** its background faded while the text colour flipped instantly, and a ring shadow came and went with it. Word states are now one ordered CSS section with no transitions and no `!important`, and the transcript follows the playing word a page at a time instead of re-centring on every word.
- [x] **Menus match the app:** Carbon renders menus outside the themed tree, so the right-click and ⋯ menus were light. `<body>` now carries the dark theme; the menu's first line is a two-line caption (what, then when).

**Manually testable:** Open a long MP3 project: the waveform shows with the text, and Play starts as soon as the button stops pulsing. Select a dimmed word, press ↩, type the right word, press ↩: it turns green, the Edits tab lists it, ⌘Z undoes it. Right-click any word: the menu is dark.

**Open:** a release build (`bunx tauri build`) for a true native speed check; correcting a word can't yet split it into several timed words.

---

### Phase 21 — Activity Status, Menu Fixes, UI Tidy-up, Dead Code ✓

**Goal:** Long jobs are visible wherever you are, menus behave like a Mac's, and nothing stray is left in the UI or the code.

- [x] **Activity status:** one store (`lib/activity.ts`) for every background job: import, transcription, downloads, fillers, speakers, enhancement, re-alignment, audio export, and the editor's own loading.
  - Shown at the foot of the sidebar and in the editor's top bar: the newest job with a progress ring, opening a list of all of them (Carbon `Popover` and `ProgressBar`), with Cancel and Dismiss.
  - Mirrored on the Dock icon's progress bar.
  - Jobs outlive the editor. Leave mid-detection and the sidebar keeps counting; come back and the panel shows the run and loads its result when it ends.
- [x] **Context menu:**
  - Closes on a click, scroll or app switch outside it. Carbon's `Menu` only closed when focus moved to something focusable.
  - Opens at the pointer on every right-click. Before, a second right-click reused the first one's position.
  - Works on the word-lane chips too. The WebView's Reload/Inspect menu is gone outside text fields.
- [x] **UI tidy-up:**
  - **Inspector:** the tabs no longer scroll away when a field low in a panel takes focus. Carbon's hidden labels were positioned against the inspector.
  - **Shortcuts sheet:** opens without the close button's tooltip.
  - **Active states:** the current page, view and speed stay marked under the pointer.
  - **Projects:** status tags are Carbon `Tag`s, with no duplicate check icon. Delete is a Carbon `IconButton`.
  - **Dialogs:** primary buttons are amber like the rest of the app, and their text styles use tokens instead of inline colours.
  - **Progress:** amber everywhere.
  - **Editor:** Back is a Carbon `IconButton`; the editor's rename now updates the projects list.
  - **Favicon:** Wave's own mark replaces Vite's logo.
- [x] **Dead code removed:**
  - The `load_peaks`, `save_peaks` and `generate_preview` commands.
  - `usePlayback`, plus template leftovers (`App.css`, `react.svg`, `tauri.svg`, `vite.svg`).
  - Two unused exports, the unused CSS (the boundary markers, old badges and buttons), and a redundant audio fallback.
  - Stale comments and the Cargo template metadata, fixed.

**Manually testable:**
- Start speaker detection, go back to Projects: the sidebar shows it counting, and the Dock icon fills. Reopen the project before it ends: the panel is still running and fills in at the end.
- Right-click a word, then right-click the waveform: the menu jumps to the pointer. Click anywhere: it closes.

---

### Phase 22 — No White Flashes, Leftover Files, Declared Dependencies ✓

**Goal:** The app never shows the WebView's white, and old projects shed files nothing uses.

- [x] **The white flash:** WebKit's log shows where it came from.
  - At launch, the WebView hides the page and paints its own white until the first commit.
  - That first commit was the bare `index.html`: in dev, Vite injects the styles from JavaScript about 3 s later, so the screen was white for up to 6 s.
  - Wave's CSS has no light background, and no web process died, so a white screen elsewhere is the same WebView background showing wherever nothing has been drawn yet.
- [x] **The fix:**
  - The window starts hidden and appears when React has rendered, about 0.7 s after launch. That's on React's first effect, not on a frame: a hidden window gets no frames, so a `requestAnimationFrame` version only showed after its fallback.
  - The WebView no longer paints a background of its own (`macOSPrivateApi`), so the window's dark `backgroundColor` is what shows before anything draws.
  - `index.html` sets the background inline. The title bar is dark (`theme: Dark`).
  - A Rust fallback shows the window after 8 s if the frontend never does.
- [x] **Leftovers:** `remove_leftovers` deletes `peaks.json`, `preview_*.wav` and interrupted `.part` writes from every project at launch, before any job can be writing. A unit test pins exactly which names count.
- [x] **Dependencies:** `@tiptap/core` is declared in `package.json` (same 3.22.0 that was installed).

**Manually testable:** Quit and relaunch: the window appears with the app already drawn, never white. Old projects no longer contain `peaks.json` or `preview_*.wav`.

**Note:** `macOSPrivateApi` rules out the Mac App Store. For an App Store build, remove it and the Cargo feature: the hidden-until-rendered window still prevents the launch flash.

---

### Phase 23 — AI Agents (MCP) ✓

**Goal:** Claude or ChatGPT can do the text-heavy work (cleanup, cuts, corrections) with Wave's own edits, live and undoable.

- [x] **One command for every client:** `wave mcp`, a local MCP server over stdio.
  - It works with Claude Desktop, Claude Code, Codex, and the ChatGPT desktop app (Codex and Work modes).
  - ChatGPT on the web can only reach internet servers, so it can't.
  - It's hand-written (handshake, ping, `tools/list`, `tools/call`): no new dependencies.
- [x] **Private link to the app:** a Unix socket, readable by this user only, while Settings → AI agents is on. No network port and no token.
- [x] **Edits go through the open editor** instead of a Rust copy of the edit logic.
  - The project opens if needed, edits appear live, and undo works as usual.
  - One agent call is one edit: grouped, labelled with the agent's summary, tagged with its name in the Edits list, and undone together, including with ⌘Z.
- [x] **19 tools:**
  - **Reading:** list projects, project details, the transcript (numbered lines, ~10k tokens for 42 minutes), words, find text, pauses.
  - **Editing:** cut words, cut time, restore, correct, remove fillers, shorten pauses, rename a speaker, list edits, undo.
  - **Jobs and files:** analyze (fillers or speakers), export text, export audio (to Downloads), import audio.
- [x] **Settings → AI agents:** the switch, plus copy-ready setup for each client, built from this executable's path.
- [x] **Fixed on the way:** saving settings dropped keys Wave doesn't know. The file had two; writes now merge (tested).
- [x] **Tested:**
  - Every tool through the editor, on the 42-minute episode loaded read-only in a browser preview: intro cut, corrections, 26 pauses shortened (33 s), undo by the agent and by ⌘Z, exports, errors.
  - The real app end to end through `wave mcp` and the socket, read-only.
  - Rust tests for the protocol and tool schemas.

**Manually testable:** Settings → AI agents → On. Add Wave to Claude Desktop or Claude Code with the command shown, then ask it to tidy a project. Watch the edits land in the editor, each tagged "Claude" in the Edits tab, and undo one.

---

### Phase 24 — Native Shell, Find and Redo, Guidance, Keyboard ✓

**Goal:** Wave behaves like a Mac app and never leaves you stuck.

- [x] **Native shell:**
  - Named "Wave".
  - Hidden title bar, with the window buttons centred in the 48 px top rows and drag regions instead of a title bar.
  - A full menu bar (`menu.rs`).
  - Window size and position remembered (`tauri-plugin-window-state`, never its visibility, since it starts hidden).
- [x] **Find (⌘F):**
  - Every match is marked, and the current one is selected.
  - ↩/⌘G step through matches, Cut removes one and moves on, and reopening keeps the last search.
  - Matching is shared with the agents' `find_text` (`textSearch.ts`).
- [x] **Redo (⇧⌘Z):** a redo stack, cleared by any new edit; an agent's group redoes as one.
- [x] **Drag and drop:** audio files dropped anywhere become projects, with an overlay while dragging.
- [x] **States:**
  - The editor shows importing or transcribing progress live, and the transcript appears by itself when done.
  - Never transcribed: Transcribe. Failed: the message plus Transcribe again or Import again…, the same on the cards.
  - Tools without their model: Open Settings.
  - A crash screen with Reload.
- [x] **Guidance:**
  - A first-run checklist on the empty Projects page that ticks itself off.
  - A one-time hint in the editor.
  - A sample prompt under AI agents.
- [x] **Keyboard and focus:**
  - Arrow keys, ↩ and ⌫ on the project grid.
  - `[` `]` step word by word, and `{` `}` grow the selection.
  - Visible focus rings on the hand-built controls.
- [x] **Contrast:** muted and faint text raised to 4.5:1.
- [x] **Cards:** each shows its waveform in miniature (`get_waveform_overview`).

**Tested** in the browser preview with your episode and four project states:
- The checklist (with and without transcription set up).
- Cards, grid keys, and ⌘N from the editor and Settings.
- The drop overlay.
- Find: 7 matches, Cut, then undo and redo by keyboard and menu.
- Word stepping, and each status screen.

The real app launched with the new menu and title bar; their look needs a check on screen.

**Open:** the empty-state art (planned separately). The app icon came in Phase 27.

---

### Phase 25 — Brand: Fraunces, the Welcome, the Title Band ✓

**Goal:** The first screen feels like a product, and the window's top edge lines up.

- [x] **Window buttons:** they sat at macOS's default height, below the 48 pt logo row. `trafficLightPosition` is applied while the window is still hidden, and macOS resets it on show, so it's gone.
  - Wave's top edge is now laid out around the default 28 pt band.
  - The logo is centred in it, Projects and Settings start with a band-high strip, and the editor has a band above its top bar.
  - The bands collapse in full screen.
- [x] **Fraunces** (SIL OFL, bundled, 121 KB for Latin) for the wordmark "Wave", page titles and the welcome. The soft axis is turned up for a friendlier serif.
- [x] **The welcome:** `BrandHero`, an animated SVG that tells Wave's idea instead of showing a wave icon.
  - "Editing audio is um just editing text." over its waveform.
  - "um" is selected (blue), struck (coral), cut, and the sentence closes up, centred.
  - A playhead plays it through and the words light amber as they're spoken.
  - One 9 s SMIL loop with two soft gradients, and a still frame for reduced motion.
- [x] **Under it:** "Welcome to Wave" in Fraunces, and the first-run steps easing in.

**Checked** in the browser preview at 1280×820: frames at 0.5, 1.45, 2.3, 4.4 and 7.1 s, and stand-in window buttons against the sidebar and the editor bands.

---

### Phase 26 — A Fuller Welcome, Packaging Check ✓

**Goal:** The welcome shows more of what Wave does and says it's local and free. Find what stands between the code and a build others can install.

- [x] **Version mismatch:** adding the window-state plugin pulled the tauri crate to 2.12 while the npm packages stayed at 2.10, and the CLI refuses mismatched minors. `@tauri-apps/api` and `@tauri-apps/cli` are now `~2.12.0`, and Cargo pins `tauri = "~2.12"` so they move together.
- [x] **`BrandHero`, bigger and fuller:** 46 px Fraunces, up to 54rem wide, a 12 s loop of four beats:
  - A long pause is shortened (1.8 s → 0.4 s).
  - "um" is drag-selected, ⌫, struck and cut.
  - The misheard "tax." is corrected (↩) to "text.", underlined green.
  - Playback lights the words amber, then three chips: Runs on your Mac, Private, Free.
  - Keycaps pop over the word they act on, and the sentence stays centred through every edit.
- [x] **The steps, horizontal:** three columns under "Welcome to Wave", each with a rule that shows where you are (green done, amber current). One action below: Set up transcription, or New Project with "or drop an audio file anywhere on this window". It fits the 960×600 minimum window.
- [x] **Minimum macOS:** whisper.cpp was compiled for the macOS doing the build (27), while the bundle claimed 10.13 and ONNX Runtime needs 13.4.
  - `src-tauri/.cargo/config.toml` sets `MACOSX_DEPLOYMENT_TARGET = 13.4`, and `bundle.macOS.minimumSystemVersion` is 13.4.
  - The rebuilt binary and its Info.plist both say 13.4.

**Checked:**
- `bunx tauri build --bundles app` makes `Wave.app` (43 MB, arm64, no non-system libraries).
- The hero, frame by frame in the browser preview (the SMIL clock paused at each beat), at 1280×820 and 960×600.

**Before distributing:**
- Sign with a Developer ID and notarize. The build is ad-hoc signed today, so Gatekeeper blocks it on other Macs.
- Confirm the Desert Ant Labs licence terms.
- A content security policy (`csp` is null).
- An updater, if wanted.

---

### Phase 27 — The App Icon ✓

**Goal:** Wave's own icon, in every size macOS uses.

- [x] **The art:** an amber wave curling over a serif text cursor on warm charcoal. It was generated from a prompt that moved a blue reference into Wave's palette.
- [x] **On Apple's grid:** the generated tile ran edge to edge, wasn't square (1960×1934), was slightly see-through (alpha 252) and had a light rim along its top.
  - The master is a square crop clear of all of that (1839 px, found by measuring the tile's own corners).
  - It's scaled to an 824 px squircle in a 1024 canvas: opaque, antialiased, with a soft shadow.
- [x] **Every size:** `icon.icns` now holds 16, 32, 128, 256 and 512 pt at 1× and 2×. The placeholder had only 512.
  - The 16–64 px sizes are lightly sharpened.
  - `.ico` and the PNGs that `tauri.conf.json` lists come from `bunx tauri icon`.

**Checked:**
- A contact sheet of every size on light and dark backgrounds, and the corner edge at full size.
- The release bundle's icon as macOS draws it (`NSWorkspace`).
- **Fix:** the first `tauri dev` after the change still showed Tauri's icon. Its Dock icon is compiled into the binary, and Cargo doesn't watch icon files, so `build.rs` now watches `icons/`.

---

### Phase 28 — Animated Job Icons, Inspector Tabs ✓

**Goal:** You can tell at a glance what Wave is busy with. The inspector reads Details → Tools → Edits → Export.

- [x] **`JobIcon`:** each kind of background job has a Phosphor icon (MIT) that moves its own way:
  - Transcribing: the caption lines of *Subtitles* type themselves out.
  - Importing: a sound wave pulses out of *FileAudio*.
  - Downloading: the arrow of *DownloadSimple* drops into its tray.
  - Exporting: the arrow of *Export* rises out of its box.
  - Finding fillers: *MagnifyingGlass* looks along the line.
  - Detecting speakers: the waves of *UserSound* go near, then far.
  - Enhancing: *Sparkle* breathes and its small stars twinkle.
  - Re-aligning: the arrows of *ArrowsInLineHorizontal* nudge in.
  - Preparing the waveform or playback: level-meter bars.
  - Anything else: *CircleNotch* turns.
  - Reduced motion and finished jobs show them at rest.
- [x] **The pill:** the job's icon sits inside a 24 px ring of its progress. When there's no telling how far along, a quarter arc turns. A check or a warning takes the same space at the end. Every job in the Activity list carries its icon too.
- [x] **Inspector tabs:** Details, Tools, Edits, Export, with Information, MagicWand, RecentlyViewed and Export icons (Carbon). Each icon is stacked over a small label, so all four fit at the narrowest width (300 px). The last tab shown is remembered (`wave.inspectorTab`).

**Checked** in the browser preview: every icon animating, the pill in the toolbar and the sidebar (3×), the Activity list, and the tabs at 300 px with nothing clipped. The chosen tab survived a reload.

---

### Phase 29 — Pauses ✓

**Goal:** Make pauses easy to tighten, or to add.

- [x] **Pauses tool:**
  - Long pauses come from the transcript, and a sentence end or a speaker change counts as between sentences.
  - Tight/Natural/Relaxed rhythms, with a preview of the result and Shorten as one edit. On the Sample, Natural shortens 10 pauses and saves 6.9 s.
- [x] **Adding pauses:**
  - Right-click a word → Add pause after, or Add at playhead in the tool.
  - The pause is filled with the quietest nearby room tone.
  - It shows as a green token in the text and a marker on the waveform; right-click to take it out.
  - The player and the exporter place and crossfade it the same way. A pause added inside a cut goes to the cut's join.
- [x] **Subtitles match the edit:** TXT/SRT/VTT/JSON exports now use edited times (cuts removed, pauses added). Before, they kept the original timestamps.
- [x] **Fix:** disabled accent buttons kept the amber accent; now they turn grey like any disabled button.
- An "Enhance for publishing" redesign of Speech enhancement was tried in this phase and taken back out: its step-by-step panel made the tool harder to use. The panel and the pipeline are as they were.

**Checked:**
- Rust: 19 unit tests, including the splice of added pauses.
- Browser preview, with the editor's IPC mocked over copies of the Sample's audio, waveform and transcript:
  - Shorten (10 cuts, one Edits row);
  - adding and removing a pause (token, marker, Edits);
  - the player's layout and timing (the playhead holds 0.5 s at the pause);
  - the export payload, with the pause, its room tone and the edited SRT times.

---

### Phase 30 — DPDFNet, a Simpler Tools Tab and Settings ✓

**Goal:** A second, permissively licensed noise remover beside Clear, usable alone or together. Make the Tools tab and Settings easy to scan.

- [x] **DPDFNet** (Ceva, `dpdfnet8_48khz_hr`, Apache-2.0, 14 MB), in `dpdfnet.rs`:
  - The streaming graph runs one frame per call with its state carried along. The STFT and inverse are outside it; the 4-frame delay is removed.
  - Long files are cut into segments run in parallel, one session per core. Each gets the 4 s before it and the 200 ms after it.
  - It matches the reference implementation's output to 53 dB.
- [x] **Clear, DPDFNet or both:**
  - "Both" runs DPDFNet, then Clear. The strength blend now comes after the models, so it covers both; Clear alone gives the same output as before.
  - Saved runs from before read as Clear.
  - On the Sample: Clear alone runs at 56× real time, DPDFNet + Clear at about 10× (M3 Pro).
- [x] **Preview** of the chosen enhancement: 15 s from the selection or the playhead, Original/Enhanced in sync, the original loudness-matched. It decodes only that stretch, taking 0.6 s with Clear and 4.5 s with both.
- [x] **Tools tab:** a list grouped by job (Clean up, Sound, People), each row with its status and next step (Get, Find, Remove N, Shorten, Enhance, on/off). A row opens the tool on its own, results first, settings under Options.
- [x] **Speech enhancement view:**
  - The choice of noise removal up front, then Enhance and Preview. Clear's sound, Strength and Loudness sit under Options.
  - A missing model is named, and Open Settings is offered.
- [x] **Settings:** compact rows grouped like Tools (Required, Clean up, Sound, People), each with a one-line summary, size, maker and licence, state and one action. Clear's entry is now named "Clear"; DPDFNet has its own.
- [x] **Labels that say what happens:** each Tools row has a chevron, so it reads as opening the tool.
  - The enhancement switch on the row shows no text. Its status says what's on, or "Off: the original plays and exports"; its accessible name is "Use the enhanced audio for playback and export". It had been labelled "Play the enhanced audio", which it doesn't do.
  - In the tool, the switch reads "Use for playback and export".
  - "Get" became "Settings →", since it opens Settings.
  - The filler list says that clicking one selects it.
  - The rule is in CLAUDE.md's UI conventions.

**Checked:**
- Rust: 19 unit tests, Clear's SDK parity test, DPDFNet against its reference, and the real-audio and preview tests on the Sample with Clear and with both.
- Browser preview, with the editor mocked over copies of the Sample:
  - the Tools list in each state (download needed, ready, results), and a row's action without opening the tool;
  - each tool's view and Options;
  - Settings with a model downloading.


### Phase 31 — EQ Presets and Agents for the New Tools ✓

**Goal:** A short set of EQ presets for the voice that are safe on any recording. Give agents everything added since the MCP server was built.

- [x] **Research** (how professionals EQ spoken voice; Riverside, Adobe, Final Cut, Logic, Audacity, Descript, Auphonic):
  - Name presets by the problem they fix, as Riverside does: muddy, thin, boomy, boxy, nasal, dull, harsh, plus one all-round sound.
  - Keep moves small and boosts broad: the loudness target measures with K-weighting, so extra bass reaches the limiter as peaks.
  - Novelty effects (Telephone, AM radio) aren't fixes, and EQ can't fix echo, a distant mic or clipping.
- [x] **`eq.rs`:** eight presets as RBJ biquad chains, Subtle/Medium/Strong scaling every gain.
  - Less boom's high-pass rises with the amount.
  - Brighter, Less harsh and Broadcast end with a zero-phase split-band de-esser.
  - On the Sample, Brighter lifts voiced speech above 7 kHz by about 2 dB while S sounds stay put; Less harsh lowers S sounds 3–4 dB.
- [x] **The chain:** noise removal (now optional: Off) → EQ → loudness, into the one enhanced audio. Saved runs read as no EQ. A run with nothing to do is refused.
- [x] **EQ in the Tools tab** (Sound): the presets with a line each, the amount, what will run with a link to change noise removal or loudness, Apply EQ, the 15 s preview and the switch. Both rows show what's applied.
- [x] **Tools rows:** the text stops short of the row's action and chevron, and a status wraps to two lines.
- [x] **Agents** (23 tools):
  - `tighten_pauses` (Tight/Natural/Relaxed, as the Pauses tool) and `add_pauses` (after words, filled with room tone);
  - `enhance_audio` (noise removal, Clear's sound, strength, EQ preset and amount, loudness; anything left out keeps what's applied) and `use_enhanced_audio`;
  - `get_project` reports long and added pauses, the enhancement and the downloaded models;
  - `list_pauses` marks pauses as between or within sentences and lists added ones.

**Checked:**
- Rust: 23 unit tests, including each preset's curve and limits and the de-esser on voice and hiss; the MCP schemas.
- The Sample enhanced with each of six EQ settings: spectra compared on voiced and S frames; EQ adds 0.1–0.7 s per 97 s.
- Browser preview, with the editor mocked over copies of the Sample: the EQ view before and after applying, the Tools rows, Speech enhancement with Off, and every new agent tool (including a bad preset).


### Phase 32 — About Wave, and Version 1.0.0 ✓

- [x] **Version 1.0.0**, kept in `package.json` only: `tauri.conf.json` reads it from there, and the app shows it from there (`APP_VERSION`). `Cargo.toml` matches.
- [x] **Sidebar footer:** About on the left, the version on the right.
- [x] **About Wave** (the sidebar's About, or Wave → About Wave in the menu bar, which replaces the system's plain About box):
  - the welcome animation, starting from the top each time;
  - the name and version, what Wave is, and six things it does;
  - Built by Saleh Kayyali, with x.com/mskayyali and mskayyali.com (opened in the browser);
  - the speech models it runs on.
- [x] The animation's SVG ids are unique per copy, so About over the welcome runs on its own clock. The editor's shortcuts stand down while a dialog has focus.

**Checked:** browser preview over the empty Projects page: the footer, About at 1280×820 (no scrolling) and at the 960×600 minimum (it scrolls), both links (going to the system browser, not the window), Esc, and unique ids with both animations showing. The app built and relaunched under `tauri dev` with the new menu item and version.


### Phase 33 — Export as MP3, AAC, WAV or FLAC ✓

**Goal:** Export the edited audio in the formats podcasts are published and archived in, carefully: each encoder tested on its own before anything uses it.

- [x] **Formats and presets** (`lib/audioFormats.ts`, `encode.rs`):
  - MP3: Spoken word (64 kbps, mono), Podcast standard (128), High quality (192), Highest (320). Constant bit rate, which podcast apps and hosts handle best.
  - AAC in .m4a: Spoken word (64, mono), Standard (128), High quality (256).
  - WAV and FLAC at 16 or 24 bits.
- [x] **Encoders:**
  - WAV with hound, as before.
  - AAC and FLAC with macOS's own encoders (AudioToolbox's ExtAudioFile; no library, no licence).
  - MP3 with LAME 3.100, since macOS can't write MP3. It's a separate library inside the app, loaded at run time (`lame.rs`), as its licence (LGPL) asks. Built from the official release, checked against Homebrew's SHA-256, by `vendor/lame/build.sh`: arm64, macOS 13.4, the encoder only.
  - Files are written beside the destination under a hidden name and moved into place when complete.
- [x] **Export path:** a `format` on `export_audio`; progress as `export:progress` (Reading the audio, then Encoding MP3) in the activity status. The 16 kHz fallback now applies only when the original can't be decoded, not when writing fails.
- [x] **Export tab:** a format switch with what each is for, the presets with what each is for, the size for MP3 and AAC, and Export MP3… (the save dialog takes the extension). The choice is remembered.
- [x] **Agents:** `export_audio` takes a `format` (a preset or a format); MP3 at 128 kbps when left out, as in the tab.
- [x] **Credits:** About names LAME and its licence; the app carries the LGPL text and a notice in `Resources/licenses/`.

**Checked:**
- Rust: 13 new tests (36 in all), and one opt-in timing test on real audio.
  - WAV round trips at 16 and 24 bits; FLAC decodes bit for bit; AAC and MP3 match their input to 20–24 dB at the encoder's delay (MP3: exactly LAME's 1,105 samples).
  - MP3 is CBR with LAME's Info tag; mono presets mix down; 96 kHz comes down to 48 kHz.
  - The export path end to end (read, cut, encode, progress in order), and finding LAME inside an app bundle.
- Every test file also checked with ffprobe and decoded fully by ffmpeg, without errors. ffmpeg reads the MP3s' exact length and LAME's delay from the Info tag.
- The constants in the Core Audio declarations checked against the macOS SDK headers (one was wrong: `'accf'`, not `'acon'`).
- On the Sample: every format and preset, timed (MP3 120–145× real time, AAC 180–450×, FLAC 600×, which is about half a minute for an hour of stereo MP3).
- Browser preview with the editor mocked: the Export tab in each format, the payload sent, progress in order, the choice after a reload, and the agents' tool (default, a format, a preset, an unknown one).
- `tauri build`: LAME in `Contents/Frameworks`, the licence and notice in `Resources/licenses/`.


### Phase 34 — Design Review, Clean-up Measured ✓

**Goal:** A last pass over every screen for consistency. Check that the enhancement's many combinations can't upset playback, and compare the two clean-up models properly.

- [x] **Playback with every combination** (`enhance.rs`, `tests::stays_in_step`, on the Sample): Clear, DPDFNet and both, strength 1, 0.7 and 0.4, with and without EQ, all with mastering.
  - The enhanced audio is always the original's length.
  - It's sample-aligned at eight points along the file, so the strength blend can't comb-filter, cuts land in the same place, and switching versions mid-playback doesn't jump.
  - The limiter adds no delay. EQ shifts phase but not time (compared through the same EQ).
- [x] **Clear against DPDFNet** (`tests::compare_models`): the Sample with rumble and hum, broadband hiss and room echo mixed in.
  - DPDFNet took 44–56 dB of noise out of the pauses and came closest to the clean speech (SI-SDR +6 to +10 dB). Clear took 13–19 dB (Studio) or 8–14 dB (Natural) and barely improved SI-SDR. Both was no better than DPDFNet alone.
  - On echo, DPDFNet took more of the tail away (−18 dB against −13).
  - DPDFNet is now the default clean-up, listed first, and the notes say what each does as measured. "Both" no longer claims to be the most thorough.
- [x] **Naming:** "Noise removal" is now **Clean up**, and its strength **Clean-up strength**. The Tools and Settings group that was "Clean up" (Filler words, Pauses) is now **Tighten**.
- [x] **Consistency:**
  - Sentence case in the app ("New project", "Create project", "Filler detection", "Speaker detection", "Word alignment"). The menu bar keeps macOS's title case.
  - One style for lengths, the player's: "1:37", "43:00", not "1m 37s", "43m 0s" or "30 s" (`lib/time.ts`).
  - Details names the language ("English", not "EN").
  - "Transcribe" on a project card has no redo icon; Transcribe again and Import again… keep it.
  - Every way to Settings reads "Open Settings". The old "Settings → AI enhancements" path is gone from the tools and the agents' errors.
  - The AI agents intro in Settings lists what they can do now.
- [x] **Open-source readiness, researched** (not yet acted on): the Desert Ant Labs licence, the SDK the Clear and Uhm code is ported from, and the other models' licences. Summarised for a decision.

**Checked:** the whole app in a browser preview with Tauri mocked over copies of the Sample (Projects, Settings, the editor's tabs and every tool, the shortcuts sheet), before and after the fixes; 36 Rust tests; the frontend build.


### Phase 35 — Open-Source Ready: Clear and Uhm Out, Loudness Rewritten, Verbatim Transcription ✓

**Goal:** Wave open source: nothing derived from Desert Ant Labs' source-available SDK. Then the best clean-up, transcription and editing without it.

- [x] **Clear removed:** the model, its processing, the Studio/Natural option and its Settings entry. Its downloads are deleted at launch (`models::remove_retired`). Runs saved with Clear still play and read "Clear · …"; the next run starts from DPDFNet.
- [x] **`enhance.rs` written afresh** around DPDFNet: decode at 48 kHz, clean up (strength as a plain mix), EQ, loudness. Same commands and `enhance.json`, so projects keep working.
- [x] **`master.rs`, from the public standards:**
  - BS.1770-4 loudness: K-weighting from its analogue prototypes, matching the standard's 48 kHz coefficients to 1e-8; −3.01 LUFS for a full-scale 997 Hz sine; both gates.
  - True peak by 4× oversampling.
  - A look-ahead limiter of Wave's own design, with no delay. A 32-bit recovery that stalled short of 1.0 was caught by its test and moved to 64-bit.
  - One gain, capped at +24 dB (was +9): enough to bring a quiet −43 LUFS recording to −19.
- [x] **Speech enhancement without the download:** the EQ and loudness run on their own, and choosing DPDFNet names the download.
- [x] **Checked on the Sample:** sample-aligned with the original for every strength and EQ, preview loudness-matched, true peak −1.50 dBTP, and DPDFNet's yardstick unchanged.
- [x] **Filler detection removed** (Uhm, the same licence). No open model replaced it, measured on an AMI meeting (ES2002a, CC-BY-4.0) against its hand transcript's 121 fillers:
  - Parakeet TDT 0.6B v2 (NVIDIA, CC-BY-4.0) through a decoder written for the test: recall 12–26 % at any threshold. Uhm: 69 %, though it trained on AMI.
  - Energy-based "sounds" between words: precision 23 % at best, and the Sample's music bed flagged every pause. Spelling fillers out for the aligner didn't tell them apart either.
  - The Fillers tool, its panel, hook, model entry, agent tool (`remove_fillers`) and `fillers.json` (deleted at launch) are gone. Filler cuts saved earlier still apply, and Restore cut takes them back. Tighten holds Pauses alone.
- [x] **Verbatim transcription instead** (`transcription.rs`): fillers become words, cut by hand or by an agent. On the same meeting:

  | Whisper | words wrong | fillers written | loops |
  |---|---|---|---|
  | whole file, greedy (before) | 36.9 % | 19 % | 7 (207 words) |
  | whole file, beam search | 31.3 % | 21 % | 2 (106 words) |
  | whole file, filler prompt | 50.1 % | 36 % | 5 (588 words) |
  | in pieces without long silences, beam search, filler prompt (now) | 25.0 % | 68 % | none |

  - **In pieces** (`speech_chunks`): at most 30 s, cut in pauses, so a loop can't spread and nothing is decoded twice (whisper.cpp's own seeking did both), and the prompt, which Whisper reads only at the start, reaches every piece.
  - **Long silences left out:** 2 s or more, 10 dB under the speech threshold. Whisper had written the prompt's end again over a silence. On the meeting this leaves out 79 s and none of the annotated words.
  - **Beam search** (5), and **`FILLER_PROMPT`** for English only: the language is detected first, from the first three pieces.
  - About 70 % of the fillers written match one in the hand transcript. A stricter loop check (entropy 2.8) gained nothing once in pieces and took a word out of the Sample's retakes; whisper.cpp's own stays. On the Sample, every retake is kept and one more "um" is written; "Saleh" became "Salih" (Correct word fixes it).
  - The agents' instructions say fillers are words: `find_text`, then `cut_words`.

---

## Out of Scope for MVP

- Collaboration / cloud sync
- Video support
