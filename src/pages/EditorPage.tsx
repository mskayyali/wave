import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { InlineLoading, InlineNotification } from '@carbon/react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { EditorTopBar } from '../components/editor/EditorTopBar';
import { TranscriptEditor, type TextToken, type TranscriptContextEvent } from '../components/editor/TranscriptEditor';
import { missing, type EnhanceToolProps } from '../components/editor/EnhancePanel';
import { availableModels, canRun, useEnhancement, type EnhanceModelsReady, type EnhanceOptions } from '../hooks/useEnhancement';
import { editedTime, findPauses, findRoomTone, RHYTHMS, shortenPauses, type Rhythm } from '../lib/pauses';
import type { PauseToolProps } from '../components/editor/PausesPanel';
import type { InsertedPause } from '../lib/editPlayer';
import type { SpeakerToolProps } from '../components/editor/SpeakersPanel';
import { useSpeakers } from '../hooks/useSpeakers';
import { assignSpeakers, rootSpeaker, speakerTurns, type SpeakerLabels } from '../lib/speakers';
import { SegmentsView } from '../components/editor/SegmentsView';
import { InspectorPanel, insertOp } from '../components/editor/InspectorPanel';
import { ShortcutsModal } from '../components/editor/ShortcutsModal';
import { WaveformTimeline } from '../components/editor/WaveformTimeline';
import { WordContextMenu, type WordContextMenuActions, type WordContextMenuState } from '../components/editor/WordContextMenu';
import { WordCorrection } from '../components/editor/WordCorrection';
import { FindBar } from '../components/editor/FindBar';
import { ProjectStatus } from '../components/editor/ProjectStatus';
import { onCommand, typing } from '../lib/commands';
import { findPhrase } from '../lib/textSearch';
import { useTranscript } from '../hooks/useTranscript';
import { useWaveform } from '../hooks/useWaveform';
import { quietestPoint } from '../lib/audioAnalysis';
import { loadWaveform, type WaveformPeaks } from '../lib/waveformData';
import { activity } from '../lib/activity';
import { registerEditor, type AgentWord, type EditorAgentApi } from '../lib/agent';
import { toJSON, toPlainText, toSRT, toVTT } from '../utils/exportFormats';
import type { Project } from '../hooks/useProjects';
import type { EnrichedWord } from '../hooks/useTranscript';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ViewMode = 'flow' | 'segments';

export interface SelectionRange {
  startMs: number;
  endMs:   number;
}

export interface EditAction {
  id:          string;
  wordIndices: number[];  // indices into enrichedWords[] (empty for free-range cuts)
  /** Raw time range to cut, for selections not tied to any transcript word
   *  (breaths, pauses, room tone, music…). Present only on free-range cuts. */
  range?:      { startMs: number; endMs: number };
  /** A manual nudge of one cut edge on the waveform: `key` names the edge
   *  (see currentOps), `ms` is where it now sits. Undoable like any edit. */
  adjust?:     { key: string; ms: number };
  /** Fillers removed by this edit, as spans in original time. Earlier
   *  versions of Wave detected fillers; their removals still cut. The cut
   *  edges are keyed `fs:`/`fe:` + the span's start. */
  fillers?:    { startMs: number; endMs: number }[];
  /** A misheard word corrected by hand: its index in enrichedWords and the
   *  text it should read. Changes no audio; the latest one per word wins. */
  correction?: { index: number; text: string };
  /** A pause added at `atMs` (original time), `ms` long, filled with the room
   *  tone at `tone` (a quiet stretch nearby). Adds audio; cuts nothing. */
  insert?:     { atMs: number; ms: number; tone?: { startMs: number; endMs: number } };
  /** Made as one step (an AI agent's call, or a tool's run like Shorten
   *  pauses): undone together, shown as one edit under `label`, marked with
   *  the agent's name when an agent made it (lib/agentTools.ts). */
  group?:      { id: string; label: string; agent?: string };
  label:       string;    // human-readable "2 words (0:12–0:18)"
  createdAt:   number;
}

// ─── Silence enrichment ───────────────────────────────────────────────────────

/** The Pauses tool's rhythm, remembered across projects. */
const RHYTHM_KEY = 'wave.pauseRhythm';

/** Gaps ≥ this between spoken words get a █ silence sentinel inserted. */
const SILENCE_THRESHOLD_MS = 3000;

function enrichWithSilences(words: import('../hooks/useTranscript').TranscriptWord[]): EnrichedWord[] {
  const out: EnrichedWord[] = [];
  for (let i = 0; i < words.length; i++) {
    out.push({ ...words[i], isSilence: false });
    if (i < words.length - 1) {
      const gap = words[i + 1].startMs - words[i].endMs;
      if (gap >= SILENCE_THRESHOLD_MS) {
        out.push({
          text:       '█',
          startMs:    words[i].endMs,
          endMs:      words[i + 1].startMs,
          confidence: 1.0,
          isSilence:  true,
        });
      }
    }
  }
  return out;
}

// ─── Active-word binary search ────────────────────────────────────────────────

function findActiveWordIndex(words: EnrichedWord[], ms: number): number {
  if (words.length === 0 || ms < words[0].startMs) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].endMs <= ms)        lo = mid + 1;
    else if (words[mid].startMs > ms)  hi = mid - 1;
    else return mid;
  }
  // ms is between words (silence gap) — don't highlight anything.
  // Previously this returned lo - 1 (the word that just finished), causing
  // the last word of a sentence to stay lit during the silence that follows.
  return -1;
}

/** The value in sorted `values` closest to `x` (null if empty). */
function nearestValue(values: Float64Array, x: number): number | null {
  if (values.length === 0) return null;
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  const after  = values[lo];
  const before = lo > 0 ? values[lo - 1] : after;
  return Math.abs(before - x) <= Math.abs(after - x) ? before : after;
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Compact duration label: "0.4s", "1.4s", "42s". */
/** Precise timestamp for edge nudges: "1:32.45". */
function fmtPrecise(ms: number): string {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
}

/** "0.5 s", "1.25 s" */
function fmtSeconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(2))} s`;
}

function fmtDur(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** Edit-list label for cutting these words: `"so" at 0:12`, `3 words (0:12–0:14)`. */
function wordsLabel(words: EnrichedWord[], indices: number[]): string {
  const first = words[indices[0]];
  const last  = words[indices[indices.length - 1]];
  if (indices.length === 1) {
    return first.isSilence ? `silence at ${fmtMs(first.startMs)}` : `"${first.text}" at ${fmtMs(first.startMs)}`;
  }
  return `${indices.length} words (${fmtMs(first.startMs)}–${fmtMs(last.endMs)})`;
}

/** Edit-list label for removing several fillers (an earlier version's edits). */
function fillersLabel(count: number): string {
  return count === 1 ? '1 filler' : `${count} fillers`;
}

/** A passage marked in the timeline for reference (right-click in the transcript). */
interface ReferenceRange {
  startMs:     number;
  endMs:       number;
  wordIndices: number[];
}

// ─── Types ────────────────────────────────────────────────────────────────────
// Note: time-domain conversion helpers (toPreviewMs / toOriginalMs) live here
// when export is implemented.  The waveform always plays the original audio so
// no conversion is needed during playback — all timestamps are in original time.

/** A cut range in original time. `startKey`/`endKey` name the edges so a
 *  drag on the waveform can be recorded as an adjustment of that edge. */
type TimeOp = { startMs: number; endMs: number; startKey?: string; endKey?: string };

// ─── Cut ops ──────────────────────────────────────────────────────────────────
// Merged cut ops (original-time ranges), from the deleted words, free-range cuts
// and edge nudges. Pure, so a hypothetical edit can be previewed (C) exactly.
// Silence entries are cut exactly at their boundaries — they represent real
// silence, no Whisper imprecision to absorb.  Real words get up to ±60 ms of
// padding into the neighbouring gap to absorb timestamp imprecision.
//
// Where a kept word runs straight into the cut (no pause to pad into), the
// edge moves to the quietest moment just before the boundary — aligned word
// starts lag the real onset slightly, so that's where the true gap between
// the words is. Manual nudges from the waveform override both.
const TRIM_PAD_MS = 60;
const GENTLE_BEFORE_MS = 70;
const GENTLE_AFTER_MS  = 10;

function computeCutOps(
  enrichedWords: EnrichedWord[],
  deletedWords:  ReadonlySet<number>,
  rangeOps:      { startMs: number; endMs: number; id: string }[],
  adjustments:   ReadonlyMap<string, number>,
  energy:        Float32Array | null,
  fillerCuts:    { startMs: number; endMs: number }[] = [],
): TimeOp[] {
  const rawOps: TimeOp[] = [];

  // ── Removed fillers (an earlier version's edits): cut exactly at the saved
  // span; edges can be nudged like any cut.
  for (const f of fillerCuts) {
    const key = String(Math.round(f.startMs));
    rawOps.push({
      startMs:  adjustments.get(`fs:${key}`) ?? f.startMs,
      endMs:    adjustments.get(`fe:${key}`) ?? f.endMs,
      startKey: `fs:${key}`,
      endKey:   `fe:${key}`,
    });
  }

  // ── Word / silence deletions ──────────────────────────────────────────
  // Adjacent deleted entries form one run and are cut as a single contiguous
  // range — including any pauses between them. Cutting word-by-word left
  // every internal pause longer than ~130 ms behind as a sliver of audio.
  if (enrichedWords.length > 0 && deletedWords.size > 0) {
    const runs: [number, number][] = [];
    for (const idx of [...deletedWords].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && idx === last[1] + 1) last[1] = idx;
      else runs.push([idx, idx]);
    }

    for (const [firstIdx, lastIdx] of runs) {
      const first = enrichedWords[firstIdx];
      const last  = enrichedWords[lastIdx];
      if (!first || !last) continue;

      // Neighbours of a maximal run are always kept entries.
      const prevWord = firstIdx > 0 ? enrichedWords[firstIdx - 1] : null;
      const nextWord = lastIdx < enrichedWords.length - 1 ? enrichedWords[lastIdx + 1] : null;

      // Pad into the gap to a kept word (a full pad when the neighbour is silence).
      const gapBefore = prevWord && !prevWord.isSilence ? first.startMs - prevWord.endMs : TRIM_PAD_MS;
      const gapAfter  = nextWord && !nextWord.isSilence ? nextWord.startMs - last.endMs  : TRIM_PAD_MS;
      const expandStart = first.isSilence ? 0 : Math.min(TRIM_PAD_MS, Math.max(0, gapBefore));
      const expandEnd   = last.isSilence  ? 0 : Math.min(TRIM_PAD_MS, Math.max(0, gapAfter));
      let startMs = first.startMs - expandStart;
      let endMs   = last.endMs    + expandEnd;

      if (energy) {
        if (!first.isSilence && prevWord && !prevWord.isSilence && gapBefore < TRIM_PAD_MS) {
          const q = quietestPoint(energy, first.startMs, GENTLE_BEFORE_MS, GENTLE_AFTER_MS);
          if (q !== null && q > prevWord.startMs) startMs = q;
        }
        if (!last.isSilence && nextWord && !nextWord.isSilence && gapAfter < TRIM_PAD_MS) {
          const q = quietestPoint(energy, nextWord.startMs, GENTLE_BEFORE_MS, GENTLE_AFTER_MS);
          if (q !== null && q > last.startMs && q < nextWord.endMs) endMs = q;
        }
      }

      const startKey = `ws:${firstIdx}`;
      const endKey   = `we:${lastIdx}`;
      rawOps.push({
        startMs: adjustments.get(startKey) ?? startMs,
        endMs:   adjustments.get(endKey)   ?? endMs,
        startKey,
        endKey,
      });
    }
  }

  // ── Free-range cuts (audio with no transcript word) ───────────────────
  // Used exactly as drawn — gentle splicing (zero-crossing snap + equal-power
  // crossfade) is applied in Rust at preview/export time.
  for (const r of rangeOps) {
    const startKey = `rs:${r.id}`;
    const endKey   = `re:${r.id}`;
    rawOps.push({
      startMs: adjustments.get(startKey) ?? r.startMs,
      endMs:   adjustments.get(endKey)   ?? r.endMs,
      startKey,
      endKey,
    });
  }

  const valid = rawOps.filter((op) => op.endMs - op.startMs > 1);
  if (valid.length === 0) return [];

  // Sort by start, then merge overlapping / adjacent ops (≤ 10 ms gap),
  // keeping track of which edge each merged boundary came from.
  valid.sort((a, b) => a.startMs - b.startMs);
  const ops: TimeOp[] = [];
  for (const op of valid) {
    const last = ops[ops.length - 1];
    if (last && op.startMs <= last.endMs + 10) {
      if (op.endMs > last.endMs) {
        last.endMs  = op.endMs;
        last.endKey = op.endKey;
      }
    } else {
      ops.push({ ...op });
    }
  }
  return ops;
}

// ─── Editor body ──────────────────────────────────────────────────────────────

interface EditorBodyProps {
  project:           Project;
  viewMode:          ViewMode;
  onWordClick:       (attrs: { id: string; startMs: number; endMs: number; text: string }) => void;
  onSelectionChange: (range: SelectionRange | null) => void;
  onContextMenu:     (e: TranscriptContextEvent) => void;
  activeWordId:      string | null;
  transcript:        ReturnType<typeof useTranscript>['transcript'];
  loading:           boolean;
  error:             string | null;
  editActions:       EditAction[];
  onUndoAction:      (id: string) => void;
  alignerReady:      boolean;
  onRealign:         () => Promise<void>;
  enrichedWords:     EnrichedWord[];
  currentOps:        TimeOp[];
  /** Added pauses, shown between the words (Flow view). */
  textTokens:        TextToken[];
  /** The Speech enhancement tool in the inspector. */
  enhanceTool:       EnhanceToolProps;
  /** The Speakers tool in the inspector. */
  speakerTool:       SpeakerToolProps;
  /** The Pauses tool in the inspector. */
  pauseTool:         PauseToolProps;
  /** Pauses added by hand (for the audio export). */
  addedPauses:       InsertedPause[];
  /** Who says each word, when speakers are shown. */
  speakerLabels:     SpeakerLabels | null;
  /** Words for the text and subtitle exports (with speaker names when shown). */
  exportWords:       (EnrichedWord & { speaker?: string })[];
  /** Above the text: the first-time hint and the Find bar (memoised by the page). */
  banner:            ReactNode;
  /** Transcribe again, or import again (ProjectStatus). */
  onRetry:           () => void;
}

// Wrapped in memo so it only re-renders when props actually change.
// During audio playback the parent (EditorPage) re-renders ~60fps as currentMs
// updates; without memo, TipTap and InspectorPanel would re-render 60fps too.
// The only prop that legitimately changes during playback is activeWordId
// (at word boundaries, ~once per 300-500ms), so memo cuts re-renders by ~100×.
const EditorBody = memo(function EditorBody({
  project, viewMode, onWordClick, onSelectionChange, onContextMenu, activeWordId, transcript, loading, error,
  editActions, onUndoAction, alignerReady, onRealign, enrichedWords, currentOps,
  textTokens, enhanceTool, speakerTool, pauseTool, addedPauses, speakerLabels, exportWords, banner, onRetry,
}: EditorBodyProps) {
  if (loading) {
    return (
      <div className="wave-editor-loading">
        <InlineLoading description="Loading transcript…" status="active" />
      </div>
    );
  }
  if (error || !transcript) {
    return <ProjectStatus project={project} loadError={error} onRetry={onRetry} />;
  }

  return (
    <>
      <div className="wave-editor-main">
      {banner}
      <div className="wave-editor-scroll">
        {viewMode === 'flow' ? (
          <TranscriptEditor
            words={enrichedWords}
            activeWordId={activeWordId}
            onWordClick={onWordClick}
            onSelectionChange={onSelectionChange}
            onContextMenu={onContextMenu}
            tokens={textTokens}
            speakers={speakerLabels}
          />
        ) : (
          <SegmentsView
            words={enrichedWords}
            activeWordId={activeWordId}
            onWordClick={onWordClick}
            onSelectionChange={onSelectionChange}
            onContextMenu={onContextMenu}
            speakers={speakerLabels}
          />
        )}
      </div>
      </div>

      <InspectorPanel
        transcript={transcript}
        projectName={project.name}
        projectId={project.id}
        filteredWords={exportWords}
        currentOps={currentOps}
        editActions={editActions}
        onUndoAction={onUndoAction}
        alignerReady={alignerReady}
        onRealign={onRealign}
        enhanceTool={enhanceTool}
        speakerTool={speakerTool}
        pauseTool={pauseTool}
        addedPauses={addedPauses}
      />
    </>
  );
}); // end memo(EditorBody)

// ─── Page ─────────────────────────────────────────────────────────────────────

interface EditorPageProps {
  project:      Project;
  /** The word-alignment model is downloaded (enables "Re-align words"). */
  alignerReady: boolean;
  /** Which speech-enhancement models are downloaded. */
  enhanceModels:    EnhanceModelsReady;
  /** The speaker-detection model is downloaded. */
  speakerModelReady: boolean;
  onBack:       () => void;
  onRename?: (id: string, name: string) => void;
  /** Transcribe again, or import again, when the project has no transcript. */
  onRetry:      () => void;
}

export function EditorPage({ project, alignerReady, enhanceModels, speakerModelReady, onBack, onRename, onRetry }: EditorPageProps) {
  const [viewMode,        setViewMode]       = useState<ViewMode>('flow');
  const [audioSrc,        setAudioSrc]       = useState<string | null>(null);
  /** The precomputed waveform (waveform.rs); null when it couldn't be had. */
  const [peaks,           setPeaks]          = useState<WaveformPeaks | null>(null);
  const [selectionRange,  setSelectionRange] = useState<SelectionRange | null>(null);
  /**
   * A selection of words that aren't one stretch of audio: everything one
   * speaker said. Exclusive with `selectionRange`; ⌫ deletes the words.
   */
  const [wordSelection, setWordSelection] = useState<{ indices: number[]; speaker: number; label: string } | null>(null);
  const [reference,       setReference]      = useState<ReferenceRange | null>(null);
  const [contextMenu,     setContextMenu]    = useState<WordContextMenuState | null>(null);
  /** The word being corrected (its index in enrichedWords). */
  const [correcting,      setCorrecting]     = useState<number | null>(null);
  const [isLooping,       setIsLooping]      = useState(false);
  const [editActions,     setEditActions]    = useState<EditAction[]>([]);
  const [waveformHeight,  setWaveformHeight] = useState(240);
  // Local override of the project name so it updates instantly after rename.
  const [projectName, setProjectName] = useState(project.name);
  // True once the initial edit history has been loaded from disk.
  // We use this to avoid immediately overwriting the saved file before loading.
  const editsLoadedRef = useRef(false);
  // The same, as state: agents may work on the editor once it's set.
  const [editsReady, setEditsReady] = useState(false);
  // Guard so the transcript-gated edit-load effect runs its body only once.
  const editsLoadStartedRef = useRef(false);
  // True when saved cuts were discarded because the transcript changed under them.
  const [editsInvalidated, setEditsInvalidated] = useState(false);

  const { transcript, loading, error, realign } = useTranscript(project.id, project.status.type === 'ready');
  const enhance         = useEnhancement(project.id);
  const speakerDetection = useSpeakers(project.id);
  const enhancedPath    = enhance.enhancement?.audioPath ?? null;
  const enhancedSrc     = useMemo(() => (enhancedPath ? convertFileSrc(enhancedPath) : null), [enhancedPath]);

  // Fingerprint of the word sequence the cut queue was authored against.
  // edits.json stores positional word indices; if the project is re-transcribed
  // the words (and thus every index) change, so saves are stamped with this and
  // a saved queue whose fingerprint no longer matches is refused. Timings are
  // left out on purpose: re-aligning moves words without changing them.
  const transcriptFingerprint = useMemo(() => {
    if (!transcript) return null;
    const w = transcript.words;
    let h = 5381;
    for (let i = 0; i < w.length; i++) {
      const t = w[i].text;
      for (let j = 0; j < t.length; j++) h = ((h << 5) + h + t.charCodeAt(j)) | 0;
      h = (h + 0x20) | 0; // word separator
    }
    return `t:${w.length}:${h >>> 0}`;
  }, [transcript]);

  // The earlier fingerprint also hashed start times. Still accepted on load so
  // edits saved before it changed aren't discarded (they re-save as text-only).
  const legacyFingerprint = useMemo(() => {
    if (!transcript) return null;
    const w = transcript.words;
    let h = 5381;
    for (let i = 0; i < w.length; i++) {
      const t = w[i].text;
      for (let j = 0; j < t.length; j++) h = ((h << 5) + h + t.charCodeAt(j)) | 0;
      h = (h + w[i].startMs) | 0;
    }
    return `${w.length}:${transcript.durationMs}:${h >>> 0}`;
  }, [transcript]);
  const waveform = useWaveform(audioSrc, { peaks, altSrc: enhancedSrc, useAlt: enhance.enhancement?.enabled ?? false });

  // Destructure stable callbacks to keep effect deps clean
  const {
    setActiveWordRegion, clearActiveWordRegion,
    setSelectionRegion,  clearSelectionRegion,
    setReferenceRegion,  clearReferenceRegion,
    setCuts, setInserts,
    energy,
    waveError,
  } = waveform;

  // ── Fallback to 16kHz WAV if the original format can't be decoded ─────────
  // WKWebView doesn't support OGG/Opus/WMA — if WaveSurfer reports an error
  // and we haven't already fallen back, retry with the guaranteed-compatible
  // 16 kHz mono WAV. Mono causes left-channel-only output on some devices but
  // at least audio will play.
  useEffect(() => {
    if (!waveError) return;
    invoke<string>('get_audio_path', { projectId: project.id })
      .then((fsPath) => setAudioSrc(convertFileSrc(fsPath)))
      .catch((e) => console.warn('Fallback audio not available:', e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waveError]);

  // Sync refs — always hold the latest value without adding to effect deps.
  // Written during render (synchronous), so effects/handlers always read fresh data.
  const waveformRef    = useRef(waveform);
  const currentOpsRef  = useRef<TimeOp[]>([]);
  waveformRef.current  = waveform;

  const deletedWords = useMemo(
    () => new Set(editActions.flatMap((a) => a.wordIndices)),
    [editActions]
  );

  // Transcript words enriched with silence sentinels for long gaps (≥ 3 s).
  // All indices throughout the editor (editActions.wordIndices, deletedWords,
  // data-word-id attributes) reference this array, not transcript.words.
  const transcribedWords = useMemo<EnrichedWord[]>(
    () => transcript ? enrichWithSilences(transcript.words) : [],
    [transcript]
  );

  // Hand corrections (word index → text; the latest per word wins), applied
  // over the transcribed words. Keyed by their content, so the many edits that
  // aren't corrections leave enrichedWords (and the transcript view) alone.
  // The fingerprint stays on the transcribed text: corrections are edits.
  const correctionsKey = useMemo(
    () => JSON.stringify(editActions.flatMap((a) => (a.correction ? [[a.correction.index, a.correction.text]] : []))),
    [editActions]
  );
  const enrichedWords = useMemo<EnrichedWord[]>(() => {
    const corrections = new Map<number, string>(JSON.parse(correctionsKey));
    if (corrections.size === 0) return transcribedWords;
    return transcribedWords.map((w, i) => {
      const text = corrections.get(i);
      return text !== undefined && !w.isSilence && text !== w.text ? { ...w, text, correctedFrom: w.text } : w;
    });
  }, [transcribedWords, correctionsKey]);

  // Words kept for export: deleted entries removed, silence sentinels removed
  // (they are internal editing helpers, not real transcript content).
  const filteredWords = useMemo<EnrichedWord[]>(
    () => enrichedWords.filter((w, i) => !deletedWords.has(i) && !w.isSilence),
    [enrichedWords, deletedWords]
  );

  // Who says each word, from the saved speaker segments (when shown).
  // Merged speakers count as the one they were merged into, before words are
  // assigned, so a word split between the two goes to the merged speaker.
  const speakerAnalysis = speakerDetection.analysis;
  const speakerOfWord = useMemo<SpeakerLabels | null>(() => {
    if (!speakerAnalysis) return null;
    const speakers = speakerAnalysis.speakers;
    const segments = speakerAnalysis.segments.map((s) => ({ ...s, speaker: rootSpeaker(s.speaker, speakers) }));
    return {
      of:    assignSpeakers(enrichedWords, segments),
      names: Object.fromEntries(speakers.map((s) => [s.id, speakers.find((r) => r.id === rootSpeaker(s.id, speakers))?.name ?? s.name])),
    };
  }, [speakerAnalysis, enrichedWords]);
  // What the transcript, the timeline and exports show (when speakers are on).
  const speakerLabels = speakerAnalysis?.settings.show ? speakerOfWord : null;
  const turns = useMemo(() => (speakerLabels ? speakerTurns(enrichedWords, speakerLabels.of) : []), [speakerLabels, enrichedWords]);

  const exportWordsOriginal = useMemo(
    () => (speakerLabels
      ? enrichedWords.flatMap((w, i) => (!deletedWords.has(i) && !w.isSilence
        ? [{ ...w, speaker: speakerLabels.of[i] !== null ? speakerLabels.names[speakerLabels.of[i]!] : undefined }]
        : []))
      : filteredWords),
    [speakerLabels, enrichedWords, deletedWords, filteredWords]
  );

  // Raw time-range cuts (waveform selections not associated with any word —
  // breaths, pauses, room tone, music, etc). Stored verbatim on the action.
  const rangeOps = useMemo(
    () => editActions.flatMap((a) => (a.range ? [{ ...a.range, id: a.id }] : [])),
    [editActions]
  );

  // Manual edge nudges made on the waveform — the latest one per edge wins.
  const adjustments = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of editActions) if (a.adjust) map.set(a.adjust.key, a.adjust.ms);
    return map;
  }, [editActions]);

  // Spans of fillers removed by an earlier version of Wave, which detected them.
  const fillerCuts = useMemo(
    () => editActions.flatMap((a) => a.fillers ?? []),
    [editActions]
  );

  const currentOps = useMemo<TimeOp[]>(
    () => computeCutOps(enrichedWords, deletedWords, rangeOps, adjustments, energy, fillerCuts),
    [deletedWords, enrichedWords, rangeOps, adjustments, energy, fillerCuts],
  );
  currentOpsRef.current = currentOps; // keep ref in sync with latest memo result

  // Pauses added by hand (EditAction.insert), in time order, each with the id
  // of the edit that made it (which names its token in the text).
  const addedPauses = useMemo<(InsertedPause & { id: string })[]>(
    () => editActions.flatMap((a) => (a.insert ? [{ id: a.id, ...a.insert }] : [])).sort((x, y) => x.atMs - y.atMs),
    [editActions],
  );
  const addedPausesRef = useRef(addedPauses);
  addedPausesRef.current = addedPauses;

  // Text and subtitle exports time the words as the exported audio has them:
  // less what's cut before each, plus the pauses added before it.
  const exportWords = useMemo(
    () => exportWordsOriginal.map((w) => ({
      ...w,
      startMs: editedTime(w.startMs, currentOps, addedPauses, 'start'),
      endMs:   editedTime(w.endMs, currentOps, addedPauses, 'end'),
    })),
    [exportWordsOriginal, currentOps, addedPauses],
  );

  // The pauses added by hand, as tokens in the text.
  const textTokens = useMemo<TextToken[]>(
    () => addedPauses.map((p) => ({ id: `p${p.id}`, label: `+${fmtSeconds(p.ms)}`, startMs: p.atMs })),
    [addedPauses],
  );

  // ── Load audio asset URL ──────────────────────────────────────────────────
  // Prefer the original stereo file for playback quality.  The 16 kHz mono
  // WAV is kept strictly for Whisper — playing it causes a 1-channel signal
  // that macOS routes to the left output only.
  // If WaveSurfer can't decode the original (unsupported codec in WKWebView)
  // it will emit an error and we fall back to the 16 kHz WAV.
  //
  // The waveform comes first, built natively and cached with the project, so
  // it shows at once; the audio then decodes in the background for playback.
  useEffect(() => {
    if (project.status.type !== 'ready') return;
    let cancelled = false;
    (async () => {
      let waveformPeaks: WaveformPeaks | null = null;
      // Instant once built; a project imported before waveform.bin existed
      // builds it now, in a second or two.
      const job = `waveform:${project.id}`;
      activity.start({ id: job, label: 'Preparing the waveform', projectId: project.id, quietMs: 500 });
      try {
        waveformPeaks = await loadWaveform(project.id);
      } catch (e) {
        console.warn('Waveform data unavailable; the editor will analyse the audio itself:', e);
      } finally {
        activity.finish(job); // a failure isn't one: the editor falls back
      }
      let src: string | null = null;
      try {
        // The original, or the 16 kHz copy when there's none.
        src = convertFileSrc(await invoke<string>('get_playback_audio_path', { projectId: project.id }));
      } catch (e) {
        console.warn('Audio not available:', e);
      }
      if (cancelled) return;
      setPeaks(waveformPeaks);
      setAudioSrc(src);
    })();
    return () => { cancelled = true; };
  }, [project.id, project.status.type]);

  // ── Load persisted edit history once the transcript is available ─────────
  // Gated on `transcript` so the saved queue's fingerprint can be validated
  // against the current transcript before its positional indices are applied.
  useEffect(() => {
    if (!transcript || editsLoadStartedRef.current) return;
    editsLoadStartedRef.current = true;
    invoke<string | null>('load_edits', { projectId: project.id })
      .then((json) => {
        if (!json) return;
        try {
          const parsed = JSON.parse(json) as
            | EditAction[]
            | { v: number; fingerprint: string | null; actions: EditAction[] };

          // Legacy shape: a bare array with no fingerprint — apply as-is.
          if (Array.isArray(parsed)) {
            if (parsed.length > 0) setEditActions(parsed);
            return;
          }

          // Versioned shape: only apply if the transcript still matches.
          if (parsed.fingerprint != null
              && parsed.fingerprint !== transcriptFingerprint
              && parsed.fingerprint !== legacyFingerprint) {
            setEditsInvalidated(true); // stale — discard; the save effect re-stamps empty
            return;
          }
          if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
            setEditActions(parsed.actions);
          }
        } catch {
          // Corrupted — start fresh
        }
      })
      .catch((e) => console.warn('Could not load edits:', e))
      .finally(() => { editsLoadedRef.current = true; setEditsReady(true); });
  }, [transcript, transcriptFingerprint, legacyFingerprint, project.id]);

  // ── Persist edit history whenever it changes ──────────────────────────────
  useEffect(() => {
    // Don't save until the initial load has completed, to avoid stomping
    // saved edits with an empty array before we've read them.
    if (!editsLoadedRef.current) return;
    invoke('save_edits', {
      projectId: project.id,
      data: JSON.stringify({ v: 2, fingerprint: transcriptFingerprint, actions: editActions }),
    }).catch((e) => console.warn('Could not save edits:', e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editActions]);

  // ── Active word from current playback position ────────────────────────────
  // waveform always plays the original audio so currentMs is in original time.
  // Skip silence sentinels — they are visual-only and should not be highlighted.
  const activeWordId = useMemo(() => {
    if (enrichedWords.length === 0 || waveform.currentMs <= 0) return null;
    const idx = findActiveWordIndex(enrichedWords, waveform.currentMs);
    if (idx < 0) return null;
    return enrichedWords[idx].isSilence ? null : `w${idx}`;
  }, [enrichedWords, waveform.currentMs]);

  // ── Sync active-word waveform region ─────────────────────────────────────
  useEffect(() => {
    if (!activeWordId) {
      clearActiveWordRegion();
      return;
    }
    const idx  = parseInt(activeWordId.slice(1), 10);
    const word = enrichedWords[idx];
    if (word) setActiveWordRegion(word.startMs, word.endMs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWordId, clearActiveWordRegion, setActiveWordRegion]);

  // ── Selection made → seek to its start + disable loop if cleared ─────────
  useEffect(() => {
    if (selectionRange) {
      waveform.seek(selectionRange.startMs);
    } else {
      setIsLooping(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionRange]);

  // ── Loop the selection ────────────────────────────────────────────────────
  // (Cuts are skipped by the player itself, on the audio clock — see EditPlayer.)
  useEffect(() => {
    if (!waveform.isPlaying) return;
    if (isLooping && selectionRange && waveform.currentMs >= selectionRange.endMs) {
      waveformRef.current.seek(selectionRange.startMs);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waveform.currentMs]);

  // ── Sync selection → waveform region ─────────────────────────────────────
  useEffect(() => {
    if (!selectionRange) {
      clearSelectionRegion();
    } else {
      setSelectionRegion(selectionRange.startMs, selectionRange.endMs);
    }
  }, [selectionRange, setSelectionRegion, clearSelectionRegion]);

  // ── Sync selection → word highlight (DOM) ────────────────────────────────
  // Words wholly inside the selection are selected; words it only touches get
  // a lighter mark, so a tiny trim at a word's edge doesn't look like the word.
  useEffect(() => {
    document.querySelectorAll('.wave-word--selected, .wave-word--selected-part').forEach(
      (el) => el.classList.remove('wave-word--selected', 'wave-word--selected-part')
    );
    if (wordSelection) {
      for (const i of wordSelection.indices) document.querySelector(`[data-word-id="w${i}"]`)?.classList.add('wave-word--selected');
      return;
    }
    if (!selectionRange || enrichedWords.length === 0) return;
    enrichedWords.forEach((word, i) => {
      if (word.endMs > selectionRange.startMs && word.startMs < selectionRange.endMs) {
        const whole = word.startMs >= selectionRange.startMs - 1 && word.endMs <= selectionRange.endMs + 1;
        document.querySelector(`[data-word-id="w${i}"]`)
          ?.classList.add(whole ? 'wave-word--selected' : 'wave-word--selected-part');
      }
    });
  }, [selectionRange, wordSelection, enrichedWords, viewMode, textTokens, speakerLabels]);

  // ── Words touched by cuts drawn on the waveform ──────────────────────────
  // A range cut can swallow a word or trim part of one without the word being
  // deleted as text. The transcript shows that too: struck through when it's
  // (almost) all gone, a wavy underline when part of it is.
  const { fullCutWords, partCutWords } = useMemo(() => {
    const full = new Set<number>();
    const part = new Set<number>();
    const covered = new Map<number, number>();
    for (const r of rangeOps) {
      const s = adjustments.get(`rs:${r.id}`) ?? r.startMs;
      const e = adjustments.get(`re:${r.id}`) ?? r.endMs;
      enrichedWords.forEach((w, i) => {
        if (w.isSilence || deletedWords.has(i) || w.endMs <= s || w.startMs >= e) return;
        covered.set(i, (covered.get(i) ?? 0) + Math.min(w.endMs, e) - Math.max(w.startMs, s));
      });
    }
    covered.forEach((ms, i) => {
      const w = enrichedWords[i];
      if (ms >= 0.9 * (w.endMs - w.startMs)) full.add(i);
      else if (ms >= 10) part.add(i);
    });
    return { fullCutWords: full, partCutWords: part };
  }, [rangeOps, adjustments, enrichedWords, deletedWords]);

  useEffect(() => {
    document.querySelectorAll('.wave-word--cutaudio, .wave-word--partcut').forEach(
      (el) => el.classList.remove('wave-word--cutaudio', 'wave-word--partcut')
    );
    fullCutWords.forEach((i) => document.querySelector(`[data-word-id="w${i}"]`)?.classList.add('wave-word--cutaudio'));
    partCutWords.forEach((i) => document.querySelector(`[data-word-id="w${i}"]`)?.classList.add('wave-word--partcut'));
  }, [fullCutWords, partCutWords, enrichedWords, viewMode, textTokens, speakerLabels]);

  // ── Reference highlight (right-click) → waveform region + word marks ──────
  useEffect(() => {
    document.querySelectorAll('.wave-word--reference').forEach(
      (el) => el.classList.remove('wave-word--reference')
    );
    if (!reference) {
      clearReferenceRegion();
      return;
    }
    setReferenceRegion(reference.startMs, reference.endMs);
    reference.wordIndices.forEach((idx) => {
      document.querySelector(`[data-word-id="w${idx}"]`)?.classList.add('wave-word--reference');
    });
  }, [reference, enrichedWords, viewMode, textTokens, speakerLabels, waveform.durationMs, setReferenceRegion, clearReferenceRegion]);

  // ── DOM effect: mark deleted words ────────────────────────────────────────
  // Also re-run when the words change (e.g. re-alignment) or the view switches:
  // the transcript DOM is rebuilt then, dropping these classes.
  useEffect(() => {
    document.querySelectorAll('.wave-word--deleted').forEach(
      (el) => el.classList.remove('wave-word--deleted')
    );
    deletedWords.forEach((idx) => {
      document.querySelector(`[data-word-id="w${idx}"]`)?.classList.add('wave-word--deleted');
    });
  }, [deletedWords, enrichedWords, viewMode, textTokens, speakerLabels]);

  // ── Sync cuts → player + waveform ─────────────────────────────────────────
  // Non-destructive: the original audio is untouched; the player skips cuts
  // (crossfaded, as exported) and the waveform shows them as red regions whose
  // edges can be dragged. Audio is only re-rendered at export time.
  useEffect(() => {
    setCuts(currentOps);
  }, [currentOps, setCuts]);
  useEffect(() => {
    setInserts(addedPauses);
  }, [addedPauses, setInserts]);

  // A cut edge dragged on the waveform → an undoable adjustment of that edge.
  const handleCutResize = useCallback((index: number, startMs: number, endMs: number) => {
    const op = currentOpsRef.current[index];
    if (!op) return;
    const now = Date.now();
    const nudges: EditAction[] = [];
    if (op.startKey && Math.abs(startMs - op.startMs) > 1) {
      nudges.push({ id: `${now}-s-${Math.random()}`, wordIndices: [], adjust: { key: op.startKey, ms: Math.round(startMs) },
        label: `Cut start → ${fmtPrecise(startMs)}`, createdAt: now });
    }
    if (op.endKey && Math.abs(endMs - op.endMs) > 1) {
      nudges.push({ id: `${now}-e-${Math.random()}`, wordIndices: [], adjust: { key: op.endKey, ms: Math.round(endMs) },
        label: `Cut end → ${fmtPrecise(endMs)}`, createdAt: now });
    }
    if (nudges.length > 0) {
      redoRef.current = [];
      setEditActions((prev) => [...prev, ...nudges]);
    }
  }, []);

  // ── Keep a sync ref to selectionRange so deleteSelection always reads latest
  const selectionRangeRef = useRef(selectionRange);
  selectionRangeRef.current = selectionRange;
  const wordSelectionSet = useMemo(() => (wordSelection ? new Set(wordSelection.indices) : null), [wordSelection]);
  const wordSelectionRef = useRef(wordSelection);
  wordSelectionRef.current = wordSelection;
  // A new range selection replaces a word selection.
  useEffect(() => { if (selectionRange) setWordSelection(null); }, [selectionRange]);
  const referenceRef      = useRef(reference);
  referenceRef.current    = reference;
  const enrichedWordsRef  = useRef(enrichedWords);
  enrichedWordsRef.current = enrichedWords;
  const speakerOfWordRef  = useRef(speakerOfWord);
  speakerOfWordRef.current = speakerOfWord;
  /** The one speaker who says all these words, if there is one. */
  const speakerOf = (indices: number[]) => {
    const labels = speakerOfWordRef.current;
    if (!labels || indices.length === 0) return undefined;
    const ids = new Set(indices.map((i) => labels.of[i]).filter((s) => s !== null && s !== undefined));
    if (ids.size !== 1) return undefined;
    const id = [...ids][0] as number;
    return { id, name: labels.names[id] ?? `Speaker ${id + 1}` };
  };
  const deletedWordsRef   = useRef(deletedWords);
  deletedWordsRef.current = deletedWords;

  // ── Right-click → a context menu, and nothing else ─────────────────────────
  // Like any context menu, opening it changes nothing: no highlight, no zoom,
  // no scrolling. Marking the passage in the other view is a menu item
  // ("Show in timeline" / "Show in transcript").

  // Transcript: right-clicking inside the selection means the whole selection,
  // otherwise the word (or, from a Segments timestamp, the segment).
  const handleTranscriptContextMenu = useCallback(({ wordIndices, pauseId, clientX, clientY }: TranscriptContextEvent) => {
    const words = enrichedWordsRef.current;
    if (pauseId) {
      const p = addedPausesRef.current.find((x) => x.id === pauseId);
      if (!p) return;
      setContextMenu({ kind: 'pause', source: 'transcript', x: clientX, y: clientY, startMs: p.atMs, endMs: p.atMs,
        wordIndices: [], title: `Added pause (+${fmtSeconds(p.ms)})`, allDeleted: false, pauseId });
      return;
    }
    let indices = wordIndices.filter((i) => words[i]);
    if (indices.length === 0) return;
    const sel = selectionRangeRef.current;
    if (sel && indices.length === 1) {
      const w = words[indices[0]];
      if (w.startMs < sel.endMs && w.endMs > sel.startMs) {
        const inSelection = words
          .map((x, i) => (x.endMs > sel.startMs && x.startMs < sel.endMs ? i : -1))
          .filter((i) => i >= 0);
        if (inSelection.length > 1) indices = inSelection;
      }
    }
    const first = words[indices[0]];
    const last  = words[indices[indices.length - 1]];
    setContextMenu({
      kind: 'words', source: 'transcript', x: clientX, y: clientY,
      startMs: first.startMs, endMs: last.endMs, wordIndices: indices,
      title:      indices.length > 1 ? `${indices.length} words` : first.isSilence ? 'Silence' : `"${first.text}"`,
      allDeleted: indices.every((i) => deletedWordsRef.current.has(i)),
      speaker:    speakerOf(indices),
      word:       indices.length === 1 && !first.isSilence ? { correctedFrom: first.correctedFrom } : undefined,
    });
  }, []);

  // Waveform: a cut, else the selection (if clicked inside it), else the word,
  // else the pause between words. A selection that isn't exactly whole words
  // is a range — its menu cuts exactly that, never the words it touches.
  const handleTimelineContextMenu = useCallback((ms: number, clientX: number, clientY: number) => {
    const words   = enrichedWordsRef.current;
    const deleted = deletedWordsRef.current;
    const overlapping = (a: number, b: number) =>
      words.map((w, i) => (w.endMs > a && w.startMs < b ? i : -1)).filter((i) => i >= 0);
    const open = (kind: WordContextMenuState['kind'], startMs: number, endMs: number, wordIndices: number[], title: string) => {
      setContextMenu({
        kind, source: 'timeline', x: clientX, y: clientY, startMs, endMs, wordIndices, title,
        allDeleted: wordIndices.length > 0 && wordIndices.every((i) => deleted.has(i)),
        speaker:    kind === 'words' ? speakerOf(wordIndices) : undefined,
        word:       kind === 'words' && wordIndices.length === 1 && !words[wordIndices[0]].isSilence
          ? { correctedFrom: words[wordIndices[0]].correctedFrom } : undefined,
      });
    };

    const op = currentOpsRef.current.find((o) => ms >= o.startMs && ms <= o.endMs);
    if (op) {
      open('cut', op.startMs, op.endMs, overlapping(op.startMs, op.endMs), 'Cut');
      return;
    }
    const sel = selectionRangeRef.current;
    if (sel && ms >= sel.startMs && ms <= sel.endMs) {
      const idx   = overlapping(sel.startMs, sel.endMs);
      const exact = idx.length > 0
        && Math.abs(words[idx[0]].startMs - sel.startMs) <= 1
        && Math.abs(words[idx[idx.length - 1]].endMs - sel.endMs) <= 1;
      if (exact) open('words', sel.startMs, sel.endMs, idx, idx.length > 1 ? `${idx.length} words` : `"${words[idx[0]].text}"`);
      else open('range', sel.startMs, sel.endMs, idx, 'Selection');
      return;
    }
    const wi = findActiveWordIndex(words, ms);
    if (wi >= 0) {
      const w = words[wi];
      open('words', w.startMs, w.endMs, [wi], w.isSilence ? 'Silence' : `"${w.text}"`);
      return;
    }
    let next = 0;
    while (next < words.length && words[next].startMs <= ms) next++;
    const gapStart = next > 0 ? words[next - 1].endMs : 0;
    const gapEnd   = next < words.length ? words[next].startMs : waveformRef.current.durationMs;
    if (gapEnd - gapStart > 20) open('range', gapStart, gapEnd, [], 'Pause');
  }, []);

  // ── Snap to words (optional) ──────────────────────────────────────────────
  // Off by default: the waveform is for exact trims, so a selection is exactly
  // what you drag. Turned on (toolbar), an edge within SNAP_PX of a word edge
  // lands on it; hold ⌥ while dragging to place it freely anyway.
  const SNAP_PX = 6;
  const [snapToWords, setSnapToWords] = useState<boolean>(() => {
    try { return localStorage.getItem('wave.snapToWords') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('wave.snapToWords', snapToWords ? '1' : '0'); } catch { /* storage unavailable */ }
  }, [snapToWords]);
  const snapRef = useRef(snapToWords);
  snapRef.current = snapToWords;
  const wordEdges = useMemo(() => {
    const edges = new Set<number>();
    for (const w of enrichedWords) { edges.add(w.startMs); edges.add(w.endMs); }
    return Float64Array.from(edges).sort();
  }, [enrichedWords]);
  const wordEdgesRef = useRef(wordEdges);
  wordEdgesRef.current = wordEdges;

  const handleTimelineSelection = useCallback((range: SelectionRange | null, free = false) => {
    if (!range) {
      setSelectionRange(null);
      setWordSelection(null);
      return;
    }
    let { startMs, endMs } = range;
    const view = waveformRef.current.getView();
    if (snapRef.current && !free && view) {
      const tolerance = (SNAP_PX / view.pxPerSec) * 1000;
      const snap = (ms: number) => {
        const edge = nearestValue(wordEdgesRef.current, ms);
        return edge !== null && Math.abs(edge - ms) <= tolerance ? edge : ms;
      };
      startMs = snap(startMs);
      endMs   = snap(endMs);
    }
    if (endMs - startMs < 1) return;
    setSelectionRange((prev) =>
      prev && Math.abs(prev.startMs - startMs) < 0.5 && Math.abs(prev.endMs - endMs) < 0.5
        ? prev
        : { startMs, endMs });
  }, []);

  // ── Hovering the waveform underlines the word there in the transcript ──────
  const hoverIdxRef = useRef(-1);
  const handleTimelineHover = useCallback((ms: number | null) => {
    const words = enrichedWordsRef.current;
    const idx = ms === null ? -1 : findActiveWordIndex(words, ms);
    if (idx === hoverIdxRef.current) return;
    hoverIdxRef.current = idx;
    document.querySelector('.wave-word--hover')?.classList.remove('wave-word--hover');
    if (idx >= 0 && !words[idx].isSilence) {
      document.querySelector(`[data-word-id="w${idx}"]`)?.classList.add('wave-word--hover');
    }
  }, []);

  // ── Double-click on the waveform → select the word there, or the pause ────
  // Selecting a pause exactly makes it easy to cut or shorten (drag its edges).
  const selectAtMs = useCallback((ms: number) => {
    const words = enrichedWordsRef.current;
    if (words.length === 0) return;
    const idx = findActiveWordIndex(words, ms);
    if (idx >= 0) {
      setSelectionRange({ startMs: words[idx].startMs, endMs: words[idx].endMs });
      return;
    }
    let next = 0;
    while (next < words.length && words[next].startMs <= ms) next++;
    const gapStart = next > 0 ? words[next - 1].endMs : 0;
    const gapEnd   = next < words.length ? words[next].startMs : waveformRef.current.durationMs;
    if (gapEnd - gapStart > 20) setSelectionRange({ startMs: gapStart, endMs: gapEnd });
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Assign synchronously during render (same as waveformRef) so the handler
  // always reads the latest version without a post-render effect.
  const deleteSelectionRef = useRef(deleteSelection);
  deleteSelectionRef.current = deleteSelection;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const shortcutsOpenRef = useRef(shortcutsOpen);
  shortcutsOpenRef.current = shortcutsOpen;
  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);
  // Filled in just before render (some of these are defined further down).
  const editRef = useRef({} as {
    previewCurrent:   () => void;
    jumpToCut:        (direction: 1 | -1) => void;
    correctSelection: () => boolean;
    undoLast:         () => void;
    redo:             () => void;
    stepWord:         (direction: 1 | -1, extend: boolean) => void;
  });

  // Keyboard handler uses waveformRef so it can have empty deps and NOT be
  // re-registered 60 times/second (waveform object reference changes every RAF
  // tick because currentMs is part of spread state).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // The shortcuts sheet is modal; it handles its own keys (Esc closes it).
      if (shortcutsOpenRef.current) return;
      // So is any other dialog (About, opened from the menu over the editor).
      if (e.target instanceof Element && e.target.closest('.cds--modal')) return;
      // Arrow keys belong to a focused control that navigates with them.
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target instanceof Element
          && e.target.closest('[role="tablist"], [role="menu"], [role="listbox"], [role="radiogroup"], [role="slider"], select')) return;
      const wf = waveformRef.current;
      switch (e.key) {
        case '?':
          e.preventDefault();
          setShortcutsOpen(true);
          break;
        case ' ':
          e.preventDefault();
          wf.toggle();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const dir = e.key === 'ArrowLeft' ? -1 : 1;
          const sel = selectionRangeRef.current;
          if (e.shiftKey && sel) {
            // Fine-tune the selection: ⇧←/→ moves its end, ⌥⇧←/→ its start,
            // 10 ms a press (1 ms with ⌘ too).
            const step = (e.metaKey ? 1 : 10) * dir;
            setSelectionRange(e.altKey
              ? { startMs: Math.max(0, Math.min(sel.endMs - 1, sel.startMs + step)), endMs: sel.endMs }
              : { startMs: sel.startMs, endMs: Math.min(wf.durationMs, Math.max(sel.startMs + 1, sel.endMs + step)) });
            break;
          }
          wf.seek(wf.currentMs + 5000 * dir);
          break;
        }
        case 'j': case 'J':
          wf.setRate(Math.max(0.5, parseFloat((wf.rate - 0.25).toFixed(2))));
          break;
        case 'l': case 'L':
          wf.setRate(Math.min(2, parseFloat((wf.rate + 0.25).toFixed(2))));
          break;
        case 'Escape':
          setSelectionRange(null);
          setWordSelection(null);
          setReference(null);
          setCorrecting(null);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          deleteSelectionRef.current();
          break;
        case 'z': case 'Z':
          if (e.metaKey || e.ctrlKey) {
            // ⌘Z undoes the last edit (with its whole agent group), ⇧⌘Z redoes.
            e.preventDefault();
            if (e.shiftKey) editRef.current.redo();
            else editRef.current.undoLast();
            break;
          }
          e.preventDefault();
          if (e.shiftKey) {
            wf.setZoom(1);                       // ⇧Z: whole file
          } else {
            // Z: zoom to the selection, else to the right-click highlight;
            // pressing it again goes back to where you were.
            const r = selectionRangeRef.current ?? referenceRef.current;
            if (r) wf.zoomToRange(r.startMs, r.endMs, true);
          }
          break;
        case 'c': case 'C':
          // C: preview the selection as if cut (pre-roll, skip, post-roll).
          if (e.metaKey || e.ctrlKey || e.altKey) break; // leave ⌘C (copy) alone
          e.preventDefault();
          editRef.current.previewCurrent();
          break;
        case '[': case ']': case '{': case '}':
          // [ ] select the previous / next word; { } grow the selection by one.
          if (e.metaKey || e.ctrlKey || e.altKey) break;
          e.preventDefault();
          editRef.current.stepWord(e.key === '[' || e.key === '{' ? -1 : 1, e.key === '{' || e.key === '}');
          break;
        case 'Enter': {
          // ↩: correct the selected word (a selection of exactly one word).
          // Not while a button, link or menu has focus: Enter is theirs.
          if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) break;
          const focused = document.activeElement;
          if (focused && focused !== document.body
              && focused.closest('button, a, select, [role="button"], [role="menu"], [role="menuitem"], [role="tab"]')) break;
          if (editRef.current.correctSelection()) e.preventDefault();
          break;
        }
        case 'Tab': {
          // Tab / ⇧Tab: next / previous cut (2 s before it). Not while a
          // button or menu has focus, so keyboard navigation still works.
          const focused = document.activeElement;
          if (focused && focused !== document.body
              && focused.closest('button, a, input, select, textarea, [role="menu"], [role="menuitem"], [role="tab"]')) break;
          e.preventDefault();
          editRef.current.jumpToCut(e.shiftKey ? -1 : 1);
          break;
        }
        // Zoom: = / + to zoom in, - to zoom out, ⌘0 to reset. The focus is
        // the mouse if it's over the waveform, else the selection, else the playhead.
        case '=': case '+':
          e.preventDefault();
          wf.setZoom(wf.zoomLevel * 1.5);
          break;
        case '-':
          e.preventDefault();
          wf.setZoom(wf.zoomLevel / 1.5);
          break;
        case '0':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            wf.setZoom(1);
          }
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — all live values accessed via refs

  // ── Delete / undo actions ─────────────────────────────────────────────────
  // undoAction is stable (pure setState, no deps) — required for memo(EditorBody).
  // Undo and redo. An edit that's part of an agent's group goes with the whole
  // group. What's undone waits on the redo stack until a new edit is made.
  // editActionsRef runs ahead of renders, so quick repeated ⌘Zs each count.
  const editActionsRef = useRef(editActions);
  editActionsRef.current = editActions;
  const redoRef = useRef<EditAction[][]>([]);
  const undoAction = useCallback((id: string) => {
    const all = editActionsRef.current;
    const target = all.find((a) => a.id === id);
    if (!target) return;
    const gone = target.group ? all.filter((a) => a.group?.id === target.group!.id) : [target];
    const ids = new Set(gone.map((a) => a.id));
    redoRef.current.push(gone);
    editActionsRef.current = all.filter((a) => !ids.has(a.id));
    setEditActions((prev) => prev.filter((a) => !ids.has(a.id)));
  }, []);
  const undoLast = useCallback(() => {
    const last = editActionsRef.current[editActionsRef.current.length - 1];
    if (last) undoAction(last.id);
  }, [undoAction]);
  const redo = useCallback(() => {
    const batch = redoRef.current.pop();
    if (!batch) return;
    editActionsRef.current = [...editActionsRef.current, ...batch];
    setEditActions((prev) => [...prev, ...batch]);
  }, []);

  // The group the edits being made now belong to (an agent call, see `agentApi`).
  const agentGroupRef = useRef<EditAction['group'] | null>(null);

  /** A new edit. Built before it's queued, so it picks up the current group. */
  function newAction(fields: Omit<EditAction, 'id' | 'createdAt' | 'group'>): EditAction {
    redoRef.current = []; // a new edit ends what can be redone
    const group = agentGroupRef.current;
    return { id: `${Date.now()}-${Math.random()}`, createdAt: Date.now(), ...fields, ...(group ? { group } : {}) };
  }

  /** Cut these words (those not already cut) as one undoable edit. */
  function deleteWords(indices: number[], label?: string) {
    const fresh = indices.filter((i) => !deletedWords.has(i));
    if (fresh.length === 0) return;
    const action = newAction({ wordIndices: fresh, label: label ?? wordsLabel(enrichedWords, fresh) });
    setEditActions((prev) => [...prev, action]);
  }

  /** Select every word `speaker` says (merges included) that isn't cut yet. */
  function selectSpeaker(speaker: number) {
    const labels = speakerOfWord;
    if (!labels) return;
    const root = rootSpeaker(speaker, speakerAnalysis?.speakers ?? []);
    const indices = enrichedWords.flatMap((w, i) => (!w.isSilence && labels.of[i] === root && !deletedWords.has(i) ? [i] : []));
    setSelectionRange(null);
    setWordSelection(indices.length > 0 ? { indices, speaker: root, label: `Everything ${labels.names[root] ?? `Speaker ${root + 1}`} said` } : null);
  }

  /** Add `ms` of the room's own quiet at `atMs` (original time), as one edit. */
  function addPause(atMs: number, ms: number) {
    const tone = findRoomTone(energy, enrichedWords, atMs);
    const action = newAction({
      wordIndices: [],
      insert:      { atMs, ms, ...(tone ? { tone } : {}) },
      label:       `pause +${fmtSeconds(ms)} at ${fmtPrecise(atMs)}`,
    });
    setEditActions((prev) => [...prev, action]);
  }

  /** Add a pause after word `index`: in the middle of the gap to the next kept word, or at its end. */
  function addPauseAfter(index: number, ms: number) {
    const words = enrichedWords;
    const word = words[index];
    if (!word) return;
    let next = index + 1;
    while (next < words.length && (words[next].isSilence || deletedWords.has(next))) next++;
    const gapEnd = next < words.length ? words[next].startMs : word.endMs;
    addPause(gapEnd - word.endMs > 40 ? (word.endMs + gapEnd) / 2 : word.endMs, ms);
  }

  /** Add a pause at the playhead; inside a word, at its nearer edge. */
  function addPauseAtPlayhead(ms: number) {
    let at = waveformRef.current.currentMs;
    const inside = enrichedWords.find((w) => !w.isSilence && w.startMs < at && w.endMs > at);
    if (inside) at = at - inside.startMs < inside.endMs - at ? inside.startMs : inside.endMs;
    addPause(at, ms);
  }

  /** Shorten every long pause to the rhythm, as one edit. */
  function shortenLongPauses() {
    const r = RHYTHMS.find((x) => x.id === pauseRhythm) ?? RHYTHMS[1];
    const cuts = shortenPauses(pauseList, r);
    if (cuts.length === 0) return;
    const savedMs = cuts.reduce((sum, c) => sum + c.endMs - c.startMs, 0);
    agentGroupRef.current = {
      id:    `g${Date.now()}-${Math.random()}`,
      label: `Shortened ${cuts.length} ${cuts.length === 1 ? 'pause' : 'pauses'} (${r.label.toLowerCase()}, ${fmtSeconds(savedMs)} shorter)`,
    };
    try {
      cuts.forEach((c) => cutRange(c.startMs, c.endMs));
    } finally {
      agentGroupRef.current = null;
    }
  }

  /** Hear the shortened pauses before cutting: 20 s from the next one after the playhead. */
  function previewShortening() {
    const r = RHYTHMS.find((x) => x.id === pauseRhythm) ?? RHYTHMS[1];
    const cuts = shortenPauses(pauseList, r);
    if (cuts.length === 0) return;
    const now = waveformRef.current.currentMs;
    const first = cuts.find((c) => c.startMs >= now - 500) ?? cuts[0];
    const start = Math.max(0, first.startMs - 2500);
    waveformRef.current.playRange(start, start + 20_000, { extraCuts: cuts });
  }

  /** Cut exactly [startMs, endMs] of audio (a pause, a breath, a word's tail…). */
  function cutRange(startMs: number, endMs: number) {
    const durMs = endMs - startMs;
    if (durMs < 2) return; // ignore stray zero-width selections
    const action = newAction({
      wordIndices: [],
      range:       { startMs, endMs },
      label:       `cut ${durMs < 1000 ? `${Math.round(durMs)} ms` : fmtDur(durMs)} at ${fmtPrecise(startMs)}`,
    });
    setEditActions((prev) => [...prev, action]);
  }

  /**
   * Correct a misheard word, as an undoable edit. Typing what transcription
   * heard takes the word's corrections back off instead.
   */
  function correctWord(index: number, typed: string) {
    const word = enrichedWords[index];
    const text = typed.trim().replace(/\s+/g, ' ');
    if (!word || word.isSilence || !text || text === word.text) return;
    const heard = word.correctedFrom ?? word.text;
    if (text === heard) {
      revertCorrection(index);
      return;
    }
    const action = newAction({
      wordIndices: [],
      correction:  { index, text },
      label:       `"${heard}" → "${text}" at ${fmtMs(word.startMs)}`,
    });
    setEditActions((prev) => [...prev, action]);
  }

  /** Back to what transcription heard. */
  function revertCorrection(index: number) {
    redoRef.current = [];
    setEditActions((prev) => prev.filter((a) => a.correction?.index !== index));
  }

  /** ↩ on a selection of exactly one word: correct it. False if it isn't one. */
  function correctSelection(): boolean {
    const sr = selectionRangeRef.current;
    if (!sr || wordSelectionRef.current) return false;
    const words = wordsExactlyIn(sr);
    if (!words || words.length !== 1 || enrichedWords[words[0]].isSilence) return false;
    setCorrecting(words[0]);
    return true;
  }

  /**
   * Undo the effect of edits on these words / free-range cuts: take the words
   * out of the edits that cut them, drop the range cuts, and drop the edge
   * nudges that belonged to either.
   */
  function removeFromEdits(
    words:       ReadonlySet<number>,
    rangeIds:    ReadonlySet<string> = new Set(),
    fillerSpans: readonly { startMs: number; endMs: number }[] = [],
  ) {
    redoRef.current = [];
    const fillerKeys = new Set(fillerSpans.map((f) => String(Math.round(f.startMs))));
    const hitsFiller = (f: { startMs: number; endMs: number }) =>
      fillerSpans.some((s) => f.endMs > s.startMs && f.startMs < s.endMs);
    setEditActions((prev) => prev.flatMap((a) => {
      if (a.range) return rangeIds.has(a.id) ? [] : [a];
      if (a.adjust) {
        const side = a.adjust.key.slice(0, 2);
        const ref  = a.adjust.key.slice(3);
        if ((side === 'rs' || side === 're') && rangeIds.has(ref)) return [];
        if ((side === 'ws' || side === 'we') && words.has(Number(ref))) return [];
        if ((side === 'fs' || side === 'fe') && fillerKeys.has(ref)) return [];
        return [a];
      }
      const touchesWords   = a.wordIndices.some((i) => words.has(i));
      const touchesFillers = a.fillers?.some(hitsFiller) ?? false;
      if (!touchesWords && !touchesFillers) return [a];
      const restWords   = a.wordIndices.filter((i) => !words.has(i));
      const restFillers = (a.fillers ?? []).filter((f) => !hitsFiller(f));
      if (restWords.length === 0 && restFillers.length === 0) return [];
      return [{
        ...a,
        wordIndices: restWords,
        fillers:     restFillers.length > 0 ? restFillers : undefined,
        // A filler-removal edit keeps its "N fillers" label; a word edit is relabelled.
        label:       a.fillers ? fillersLabel(restWords.length + restFillers.length) : wordsLabel(enrichedWords, restWords),
      }];
    }));
  }

  /** Bring cut words back. */
  function restoreWords(indices: number[]) {
    removeFromEdits(new Set(indices));
  }

  /** Remove the cut covering [startMs, endMs]: its words and range cuts. */
  function restoreCut(startMs: number, endMs: number) {
    const words = new Set(enrichedWords
      .map((w, i) => (deletedWords.has(i) && w.endMs > startMs && w.startMs < endMs ? i : -1))
      .filter((i) => i >= 0));
    const rangeIds = new Set(rangeOps
      .filter((r) => {
        const s = adjustments.get(`rs:${r.id}`) ?? r.startMs;
        const e = adjustments.get(`re:${r.id}`) ?? r.endMs;
        return e > startMs && s < endMs;
      })
      .map((r) => r.id));
    const fillerSpans = fillerCuts.filter((f) => f.endMs > startMs && f.startMs < endMs);
    removeFromEdits(words, rangeIds, fillerSpans);
  }

  // ── Previewing edits ──────────────────────────────────────────────────────
  // Hear a cut in context before (or after) making it: a little before, the
  // join, a little after — as Audacity's "cut preview" and Hindenburg's
  // "rehearse edit" do.
  const PREVIEW_PRE_MS  = 2000;
  const PREVIEW_POST_MS = 1000;

  /** Preview [startMs, endMs] as it would sound cut (or as it is, if it already is). */
  function previewEdit(startMs: number, endMs: number) {
    const wf = waveformRef.current;
    const existing = currentOps.find((o) => startMs >= o.startMs - 1 && endMs <= o.endMs + 1);
    if (existing) {
      wf.playRange(Math.max(0, existing.startMs - PREVIEW_PRE_MS), existing.endMs + PREVIEW_POST_MS);
      return;
    }
    // Exactly what Delete would cut (see cutSelectionRange): whole words with
    // the usual padding and gentle edges, or else the range as drawn.
    const indices = wordsExactlyIn({ startMs, endMs })?.filter((i) => !deletedWords.has(i)) ?? [];
    let extraCuts: TimeOp[] = [{ startMs, endMs }];
    if (indices.length > 0) {
      const hypothetical = new Set(deletedWords);
      indices.forEach((i) => hypothetical.add(i));
      extraCuts = computeCutOps(enrichedWords, hypothetical, rangeOps, adjustments, energy, fillerCuts);
    }
    wf.playRange(Math.max(0, startMs - PREVIEW_PRE_MS), endMs + PREVIEW_POST_MS, { extraCuts });
  }

  /** C: preview the selection (or highlight), else the next cut from the playhead. */
  function previewCurrent() {
    const r = selectionRangeRef.current ?? referenceRef.current;
    if (r) {
      previewEdit(r.startMs, r.endMs);
      return;
    }
    const now = waveformRef.current.currentMs;
    const op  = currentOps.find((o) => o.endMs >= now);
    if (op) previewEdit(op.startMs, op.endMs);
  }

  /** Tab / ⇧Tab: move to 2 s before the next / previous cut and show it. */
  function jumpToCut(direction: 1 | -1) {
    const wf  = waveformRef.current;
    const now = wf.currentMs;
    const at  = (o: TimeOp) => Math.max(0, o.startMs - PREVIEW_PRE_MS);
    const op  = direction > 0
      ? currentOps.find((o) => at(o) > now + 50)
      : [...currentOps].reverse().find((o) => at(o) < now - 50);
    if (!op) return;
    wf.seek(at(op));
    wf.revealRange(op.startMs, op.endMs);
  }

  /** Scroll the transcript to these words. */
  function showInTranscript(indices: number[]) {
    if (indices.length === 0) return;
    document.querySelector(`[data-word-id="w${indices[0]}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /**
   * The words a range stands for, if it lines up exactly with word edges —
   * as text selections, double-clicked words and snapped drags do. Otherwise
   * null: the range is a precise piece of audio, not a set of words.
   */
  function wordsExactlyIn(range: SelectionRange): number[] | null {
    const indices = enrichedWords
      .map((w, i) => (w.endMs > range.startMs && w.startMs < range.endMs ? i : -1))
      .filter((i) => i >= 0);
    if (indices.length === 0) return null;
    const first = enrichedWords[indices[0]];
    const last  = enrichedWords[indices[indices.length - 1]];
    return Math.abs(first.startMs - range.startMs) <= 1 && Math.abs(last.endMs - range.endMs) <= 1 ? indices : null;
  }

  /**
   * Cut a selection. Whole words (exact word edges) are deleted as words, so
   * the transcript strikes them through. Anything else — a drag on the
   * waveform — is cut exactly as drawn: the waveform is for fine trims (the
   * tail of a word a text edit left behind, a breath), so it never grows a
   * selection to the words it touches.
   */
  function cutSelectionRange(range: SelectionRange) {
    const words = wordsExactlyIn(range);
    if (words) deleteWords(words);
    else cutRange(range.startMs, range.endMs);
  }

  function deleteSelection() {
    const ws = wordSelectionRef.current;
    if (ws) {
      deleteWords(ws.indices, `${ws.label.replace(/^Everything/, 'everything')} (${ws.indices.length} words)`);
      setWordSelection(null);
      return;
    }
    const sr = selectionRangeRef.current;
    if (!sr || sr.endMs - sr.startMs < 1) return;
    cutSelectionRange(sr);
    setSelectionRange(null);
  }

  // Stable: the menu listens for outside presses while it's open.
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  /** What each context-menu item does, for the passage the menu was opened on. */
  function menuActions(menu: WordContextMenuState | null): Omit<WordContextMenuActions, 'onClose'> {
    const wf = waveformRef.current;
    const run = (fn: (m: WordContextMenuState) => void) => () => {
      if (menu) fn(menu);
      setContextMenu(null);
    };
    return {
      onPlay:             run((m) => wf.playRange(m.startMs, m.endMs)),
      onPlayOriginal:     run((m) => wf.playRange(m.startMs, m.endMs, { ignoreCuts: true })),
      onPlayFrom:         run((m) => { wf.seek(m.startMs); wf.play(); }),
      onPreviewCut:       run((m) => previewEdit(m.startMs, m.endMs)),
      onSelect:           run((m) => setSelectionRange({ startMs: m.startMs, endMs: m.endMs })),
      onZoom:             run((m) => wf.zoomToRange(m.startMs, m.endMs)),
      // The only actions that mark a passage: outline it in the other view and bring it into view.
      onShowInTimeline:   run((m) => {
        setReference({ startMs: m.startMs, endMs: m.endMs, wordIndices: m.wordIndices });
        wf.revealRange(m.startMs, m.endMs);
      }),
      onShowInTranscript: run((m) => {
        setReference({ startMs: m.startMs, endMs: m.endMs, wordIndices: m.wordIndices });
        showInTranscript(m.wordIndices);
      }),
      onDelete:           run((m) => (m.kind === 'range' ? cutSelectionRange(m) : deleteWords(m.wordIndices))),
      onRestore:          run((m) => (m.kind === 'cut' ? restoreCut(m.startMs, m.endMs) : restoreWords(m.wordIndices))),
      onClearHighlight:   run(() => setReference(null)),
      onSelectSpeaker:    run((m) => { if (m.speaker) selectSpeaker(m.speaker.id); }),
      onCorrect:          run((m) => setCorrecting(m.wordIndices[0])),
      onRevertCorrection: run((m) => revertCorrection(m.wordIndices[0])),
      onAddPause:         (ms) => {
        if (menu && menu.wordIndices.length > 0) addPauseAfter(menu.wordIndices[menu.wordIndices.length - 1], ms);
        setContextMenu(null);
      },
      onRemovePause:      run((m) => { if (m.pauseId) undoAction(m.pauseId); }),
    };
  }

  function deleteAtMs(ms: number) {
    if (enrichedWords.length === 0) return;
    const idx = findActiveWordIndex(enrichedWords, ms);
    if (idx < 0 || deletedWords.has(idx)) return;
    const word = enrichedWords[idx];
    const action = newAction({ wordIndices: [idx], label: `"${word.text}" at ${fmtMs(word.startMs)}` });
    setEditActions((prev) => [...prev, action]);
  }

  // ── Word click → seek + select ───────────────────────────────────────────
  // Clicking a single word seeks to it AND selects it, so Delete/Backspace
  // can delete it immediately without needing a drag selection first.
  // useCallback + waveformRef keeps this stable for memo(EditorBody).
  const handleWordClick = useCallback((attrs: { id: string; startMs: number; endMs: number; text: string }) => {
    waveformRef.current.seek(attrs.startMs);
    if (attrs.id.startsWith('p')) { setSelectionRange(null); return; } // an added pause: just go there
    setSelectionRange({ startMs: attrs.startMs, endMs: attrs.endMs });
  }, []); // waveformRef and setSelectionRange are both stable

  // Callbacks go through a ref so they stay stable for memo(EditorBody).
  const speakerOpsRef = useRef({ selectSpeaker });
  speakerOpsRef.current = { selectSpeaker };
  const onSelectSpeaker = useCallback((id: number) => speakerOpsRef.current.selectSpeaker(id), []);

  // ── Speakers tool (inspector) ───────────────────────────────────────────────
  const speakerTool = useMemo<SpeakerToolProps>(() => ({
    modelReady: speakerModelReady,
    analysis:   speakerDetection.analysis,
    running:    speakerDetection.running,
    progress:   speakerDetection.progress,
    error:      speakerDetection.error,
    onDetect:   speakerDetection.detect,
    onRename:   speakerDetection.rename,
    onShow:     speakerDetection.setShow,
    onMerge:    speakerDetection.merge,
    onUnmerge:  speakerDetection.unmerge,
    onSelect:   onSelectSpeaker,
  }), [
    speakerModelReady, speakerDetection.analysis, speakerDetection.running, speakerDetection.progress,
    speakerDetection.error, speakerDetection.detect, speakerDetection.rename, speakerDetection.setShow,
    speakerDetection.merge, speakerDetection.unmerge, onSelectSpeaker,
  ]);

  // ── Speech enhancement tool (inspector) ─────────────────────────────────────
  const { setDraft: setEnhanceDraft } = enhance;
  // Before a first run, start from the clean-up if it's downloaded (DPDFNet,
  // else none), so an EQ or Enhance doesn't ask for a model the user didn't
  // choose. A run saved by an earlier version with Clear (which Wave no longer
  // has) starts the next one from the same: it still plays, and Apply changes
  // offers the way on. A choice made since is kept.
  useEffect(() => {
    const legacy = (m: string) => m !== 'none' && m !== 'dpdfnet';
    if (enhance.enhancement && !legacy(enhance.enhancement.options.models)) return;
    setEnhanceDraft((d) => (canRun(d, enhanceModels) ? d : { ...d, models: availableModels(enhanceModels) }));
  }, [enhance.enhancement, enhanceModels.dpdfnet]); // eslint-disable-line react-hooks/exhaustive-deps
  const onEnhanceDraft = useCallback((patch: Partial<EnhanceOptions>) => setEnhanceDraft((d) => ({ ...d, ...patch })), [setEnhanceDraft]);
  const enhanceTool = useMemo<EnhanceToolProps>(() => ({
    modelsReady: enhanceModels,
    enhancement: enhance.enhancement,
    draft:       enhance.draft,
    running:     enhance.running,
    step:        enhance.step,
    progress:    enhance.progress,
    error:       enhance.error,
    audioReady:  waveform.altReady,
    onDraft:     onEnhanceDraft,
    onRun:       enhance.run,
    onCancel:    enhance.cancel,
    onEnabled:   enhance.setEnabled,
    onRemove:    enhance.remove,
    previewFrom: () => selectionRangeRef.current?.startMs ?? waveformRef.current.currentMs,
    onPreview:   enhance.preview,
    pausePlayback: () => waveformRef.current.pause(),
  }), [
    enhanceModels.dpdfnet, // eslint-disable-line react-hooks/exhaustive-deps
    enhance.enhancement, enhance.draft, enhance.running, enhance.step, enhance.progress, enhance.error,
    waveform.altReady, onEnhanceDraft, enhance.run, enhance.cancel, enhance.setEnabled, enhance.remove, enhance.preview,
  ]);

  // ── Pauses tool (inspector) ─────────────────────────────────────────────────
  const [pauseRhythm, setPauseRhythm] = useState<Rhythm['id']>(() => {
    try {
      const saved = localStorage.getItem(RHYTHM_KEY);
      return RHYTHMS.find((r) => r.id === saved)?.id ?? 'natural';
    } catch {
      return 'natural';
    }
  });
  const onPauseRhythm = useCallback((id: Rhythm['id']) => {
    setPauseRhythm(id);
    try { localStorage.setItem(RHYTHM_KEY, id); } catch { /* not saved */ }
  }, []);
  // Pauses between kept words that no edit has touched; a change of speaker
  // counts as between sentences (detected speakers, shown or not).
  const pauseList = useMemo(
    () => findPauses(enrichedWords, (i) => deletedWords.has(i) || fullCutWords.has(i), currentOps, (i) => speakerOfWord?.of[i] ?? null),
    [enrichedWords, deletedWords, fullCutWords, currentOps, speakerOfWord],
  );
  const pauseOpsRef = useRef({ shortenLongPauses, previewShortening, addPauseAtPlayhead });
  pauseOpsRef.current = { shortenLongPauses, previewShortening, addPauseAtPlayhead };
  const onShortenPauses      = useCallback(() => pauseOpsRef.current.shortenLongPauses(), []);
  const onPreviewPauses      = useCallback(() => pauseOpsRef.current.previewShortening(), []);
  const onAddPauseAtPlayhead = useCallback((ms: number) => pauseOpsRef.current.addPauseAtPlayhead(ms), []);
  const addedTotal = useMemo(() => ({ count: addedPauses.length, ms: addedPauses.reduce((sum, p) => sum + p.ms, 0) }), [addedPauses]);
  const pauseTool = useMemo<PauseToolProps>(() => ({
    pauses:          pauseList,
    rhythm:          pauseRhythm,
    onRhythm:        onPauseRhythm,
    onShorten:       onShortenPauses,
    onPreview:       onPreviewPauses,
    added:           addedTotal,
    onAddAtPlayhead: onAddPauseAtPlayhead,
  }), [pauseList, pauseRhythm, onPauseRhythm, onShortenPauses, onPreviewPauses, addedTotal, onAddPauseAtPlayhead]);

  // ── Keyboard: word by word ([ ] { }) ────────────────────────────────────
  /**
   * Select the next or previous word (`extend`: grow the selection by it).
   * Starts from the selection when it's whole words, else from the word at
   * the playhead, and moves the playhead with it.
   */
  function stepWord(direction: 1 | -1, extend: boolean) {
    const words = enrichedWords;
    if (words.length === 0) return;
    const real = (i: number) => i >= 0 && i < words.length && !words[i].isSilence;
    const sel = selectionRangeRef.current;
    const inSel = sel ? wordsExactlyIn(sel)?.filter(real) ?? null : null;
    let from: number, to: number;
    if (inSel && inSel.length > 0) {
      from = inSel[0];
      to = inSel[inSel.length - 1];
    } else {
      const at = Math.max(0, findActiveWordIndex(words, waveformRef.current.currentMs));
      // Nothing selected: the first press selects the word at the playhead.
      let i = at;
      while (i < words.length && !real(i)) i++;
      if (!real(i)) return;
      from = to = i;
      if (!extend) {
        setWordSelection(null);
        setSelectionRange({ startMs: words[i].startMs, endMs: words[i].endMs });
        waveformRef.current.seek(words[i].startMs);
        document.querySelector(`[data-word-id="w${i}"]`)?.scrollIntoView({ block: 'nearest' });
        return;
      }
    }
    let next = direction === 1 ? to + 1 : from - 1;
    while (next >= 0 && next < words.length && !real(next)) next += direction;
    if (!real(next)) return;
    if (extend) {
      if (direction === 1) to = next; else from = next;
    } else {
      from = to = next;
    }
    setWordSelection(null);
    setSelectionRange({ startMs: words[from].startMs, endMs: words[to].endMs });
    if (!extend) waveformRef.current.seek(words[from].startMs);
    document.querySelector(`[data-word-id="w${direction === 1 ? to : from}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // ── Find (⌘F) ──────────────────────────────────────────────────────────────
  const [find, setFind] = useState<{ query: string; current: number; focus: number } | null>(null);
  const matches = useMemo(
    () => (find && find.query.trim() ? findPhrase(enrichedWords.map((w) => (w.isSilence ? '' : w.text)), find.query) : []),
    [find?.query, enrichedWords], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const findRef = useRef({ find, matches });
  findRef.current = { find, matches };
  /** Select match `n` (wrapping), in the text and the waveform. */
  const showMatch = useCallback((n: number, all = findRef.current.matches) => {
    const f = findRef.current.find;
    if (!f) return;
    if (all.length === 0) { setFind({ ...f, current: -1 }); return; }
    const i = ((n % all.length) + all.length) % all.length;
    const m = all[i];
    const words = enrichedWordsRef.current;
    setFind({ ...f, current: i });
    setWordSelection(null);
    setSelectionRange({ startMs: words[m.from].startMs, endMs: words[m.to].endMs });
    waveformRef.current.seek(words[m.from].startMs);
    document.querySelector(`[data-word-id="w${m.from}"]`)?.scrollIntoView({ block: 'center' });
  }, []);
  // Reopened, Find starts from the last search, as in Safari.
  const lastQueryRef = useRef('');
  const openFind = useCallback(() => setFind((f) => ({
    query: f?.query ?? lastQueryRef.current, current: f?.current ?? -1, focus: (f?.focus ?? 0) + 1,
  })), []);
  const closeFind = useCallback(() => {
    lastQueryRef.current = findRef.current.find?.query ?? lastQueryRef.current;
    setFind(null);
  }, []);
  const findStep = useCallback((step: 1 | -1) => {
    const { find: f } = findRef.current;
    if (!f) { openFind(); return; }
    showMatch(f.current < 0 ? (step === 1 ? 0 : -1) : f.current + step);
  }, [openFind, showMatch]);
  const findQuery = useCallback((query: string) => setFind((f) => ({ query, current: -1, focus: f?.focus ?? 0 })), []);
  const cutMatchRef = useRef<() => void>(() => undefined);
  cutMatchRef.current = () => {
    const { find: f, matches: all } = findRef.current;
    if (!f || f.current < 0 || !all[f.current]) return;
    const m = all[f.current];
    deleteWords(Array.from({ length: m.to - m.from + 1 }, (_, k) => m.from + k).filter((i) => !enrichedWords[i].isSilence));
    // The cut words still match (they're struck through), so move past them.
    showMatch(f.current + 1, all);
  };
  const cutMatch = useCallback(() => cutMatchRef.current(), []);

  // Every match is marked in the text (marks are redone after a rebuild).
  useEffect(() => {
    document.querySelectorAll('.wave-word--match').forEach((el) => el.classList.remove('wave-word--match'));
    for (const m of matches) {
      for (let i = m.from; i <= m.to; i++) document.querySelector(`[data-word-id="w${i}"]`)?.classList.add('wave-word--match');
    }
  }, [matches, viewMode, textTokens, speakerLabels]);

  // ── First time in the editor: a one-line hint, until dismissed ───────────
  const [hint, setHint] = useState(() => {
    try { return localStorage.getItem('wave.hint.editor') !== 'done'; } catch { return true; }
  });
  const dismissHint = useCallback(() => {
    setHint(false);
    try { localStorage.setItem('wave.hint.editor', 'done'); } catch { /* not kept */ }
  }, []);

  // Above the text. Memoised: EditorBody re-renders only when these change.
  const banner = useMemo(() => (
    <>
      {hint && (
        <InlineNotification
          kind="info"
          lowContrast
          className="wave-editor-hint"
          title="Edit the audio by editing the text."
          subtitle="Select words and press ⌫ to cut them · ↩ corrects a word · Right-click for more · ⌘F finds · ? lists every shortcut"
          onClose={() => { dismissHint(); return true; }}
        />
      )}
      {find && (
        <FindBar
          query={find.query}
          count={matches.length}
          current={find.current}
          focusRequest={find.focus}
          onQuery={findQuery}
          onNext={() => findStep(1)}
          onPrevious={() => findStep(-1)}
          onCut={cutMatch}
          onClose={closeFind}
        />
      )}
    </>
  ), [hint, find, matches.length, findQuery, findStep, cutMatch, closeFind, dismissHint]);

  // ── Menu bar commands (lib/commands.ts) ──────────────────────────────────
  useEffect(() => {
    const off = [
      onCommand('undo', () => { if (typing()) document.execCommand('undo'); else editRef.current.undoLast(); }),
      onCommand('redo', () => { if (typing()) document.execCommand('redo'); else editRef.current.redo(); }),
      onCommand('find', openFind),
      onCommand('find-next', () => findStep(1)),
      onCommand('find-previous', () => findStep(-1)),
      onCommand('view-flow', () => setViewMode('flow')),
      onCommand('view-segments', () => setViewMode('segments')),
      onCommand('shortcuts', () => setShortcutsOpen(true)),
    ];
    return () => off.forEach((fn) => fn());
  }, [openFind, findStep]);

  editRef.current = { previewCurrent, jumpToCut, correctSelection, undoLast, redo, stepWord };

  // ── AI agents ────────────────────────────────────────────────────────────
  // What agents may see and do here (lib/agent.ts; the tools are in
  // lib/agentTools.ts). Rebuilt every render, so a call always works on the
  // current state; registered once the transcript and saved edits are loaded.
  const settledRef = useRef<(() => void)[]>([]);
  useEffect(() => {
    const waiting = settledRef.current;
    settledRef.current = [];
    waiting.forEach((resolve) => resolve());
  }, [editActions, speakerAnalysis]);

  const agentApiRef = useRef<EditorAgentApi | null>(null);
  {
    // Word numbers (transcript positions) ↔ enrichedWords indices, which also hold pause markers.
    const indexOf: number[] = [];
    enrichedWords.forEach((w, i) => { if (!w.isSilence) indexOf.push(i); });
    const numberOf = new Map(indexOf.map((i, n) => [i, n]));
    const cutMs = currentOps.reduce((sum, op) => sum + Math.max(0, op.endMs - op.startMs), 0);
    const addedMs = addedPauses.reduce((sum, p) => sum + p.ms, 0);
    const durationMs = transcript?.durationMs ?? waveform.durationMs;
    agentApiRef.current = {
      projectId:  project.id,
      name:       projectName,
      language:   transcript?.language ?? 'unknown',
      durationMs,
      editedMs:   Math.max(0, durationMs - cutMs + addedMs),
      words: () => indexOf.map((i, n): AgentWord => {
        const w = enrichedWords[i];
        const speaker = speakerOfWord?.of[i];
        return {
          n, text: w.text, startMs: w.startMs, endMs: w.endMs, confidence: w.confidence,
          speaker:  speaker === null || speaker === undefined ? null : speakerOfWord!.names[speaker] ?? `Speaker ${speaker + 1}`,
          cut:      deletedWords.has(i) || fullCutWords.has(i),
          partCut:  partCutWords.has(i),
          ...(w.correctedFrom !== undefined ? { correctedFrom: w.correctedFrom } : {}),
        };
      }),
      speakers: () => (speakerAnalysis
        ? speakerAnalysis.speakers.filter((s) => s.mergedInto === null || s.mergedInto === undefined)
          .map((s) => ({ id: s.id, name: s.name, talkMs: s.talkMs }))
        : null),
      cuts:  () => currentOps.map((op) => ({ startMs: op.startMs, endMs: op.endMs })),
      edits: () => editActions,
      enhancement: () => ({
        exists:   enhance.enhancement !== null,
        on:       enhance.enhancement?.enabled ?? false,
        running:  enhance.running,
        progress: enhance.running ? enhance.progress : null,
        applied:  enhance.enhancement?.options ?? null,
        ready:    enhanceModels,
      }),
      enhance: (options) => {
        if (enhance.running) throw new Error('Speech enhancement is already running.');
        const needs = missing(options, enhanceModels);
        if (needs) throw new Error(`${needs.replace('to use this', 'first')} (Wave → Settings).`);
        if (!canRun(options, enhanceModels)) throw new Error('Nothing to do: choose a clean-up, an EQ preset or a loudness target.');
        enhance.runWith(options);
      },
      setEnhanced: (on) => {
        if (!enhance.enhancement) throw new Error('This project has no enhanced audio yet: run enhance_audio first.');
        enhance.setEnabled(on);
      },
      pauses: () => pauseList.map((p) => ({
        before: numberOf.get(p.before) ?? -1, after: numberOf.get(p.after) ?? -1,
        startMs: p.startMs, endMs: p.endMs, sentence: p.sentence,
      })),
      addedPauses: () => addedPauses.map((p) => ({ atMs: p.atMs, ms: p.ms })),
      group: (label, agent, make) => {
        agentGroupRef.current = { id: `g${Date.now()}-${Math.random()}`, label, agent };
        try {
          make({
            cutWords:      (ns) => deleteWords(ns.map((n) => indexOf[n]), label),
            cutTime:       (startMs, endMs) => cutRange(startMs, endMs),
            correct:       (n, text) => correctWord(indexOf[n], text),
            tightenPauses: (rhythm) => {
              const cuts = shortenPauses(pauseList, RHYTHMS.find((r) => r.id === rhythm) ?? RHYTHMS[1]);
              cuts.forEach((c) => cutRange(c.startMs, c.endMs));
              return { count: cuts.length, savedMs: cuts.reduce((sum, c) => sum + c.endMs - c.startMs, 0) };
            },
            addPause: (n, ms) => addPauseAfter(indexOf[n], ms),
          });
        } finally {
          agentGroupRef.current = null;
        }
      },
      restore: (ns) => restoreWords(ns.map((n) => indexOf[n])),
      undo: (editId) => {
        const target = editId
          ? editActions.find((a) => a.id === editId)
          : [...editActions].reverse().find((a) => a.group);
        if (!target) return null;
        undoAction(target.id);
        return target.group?.label ?? target.label;
      },
      renameSpeaker: (id, name) => speakerDetection.rename(id, name),
      analyze: () => {
        if (!speakerModelReady) throw new Error("Speaker detection isn't downloaded: it's in Wave → Settings.");
        if (speakerDetection.running) throw new Error('Speaker detection is already running.');
        speakerDetection.detect();
      },
      exportText: (format) => (format === 'txt' ? toPlainText(exportWords)
        : format === 'srt' ? toSRT(exportWords)
        : format === 'vtt' ? toVTT(exportWords)
        : toJSON(exportWords, transcript?.language ?? 'unknown', Math.max(0, durationMs - cutMs + addedMs))),
      exportAudio: (destPath, enhanced, format) => invoke<void>('export_audio', {
        projectId: project.id,
        ops:       currentOps.map((op) => ({ startMs: op.startMs, endMs: op.endMs })),
        inserts:   addedPauses.map(insertOp),
        destPath,
        enhanced,
        format,
      }),
      // After the next render that takes the edits in (or soon, if nothing changed).
      settled: () => new Promise<void>((resolve) => {
        settledRef.current.push(resolve);
        window.setTimeout(resolve, 300);
      }),
    };
  }
  const agentReady = transcript !== null && editsReady;
  useEffect(() => {
    if (!agentReady) return;
    return registerEditor(project.id, () => agentApiRef.current!);
  }, [agentReady, project.id]);

  return (
    <div className="wave-editor">
      <EditorTopBar
        project={{ ...project, name: projectName }}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onBack={onBack}
        onRename={(name) => { setProjectName(name); onRename?.(project.id, name); }}
        onShowShortcuts={showShortcuts}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {editsInvalidated && (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 16px',
            background: 'rgba(232,160,32,0.12)',
            borderBottom: '1px solid rgba(232,160,32,0.4)',
            color: '#f4f4f4', fontSize: 13,
          }}
        >
          <span style={{ flex: 1 }}>
            This project was re-transcribed since your cuts were saved, so they no longer
            line up with the transcript and were cleared.
          </span>
          <button
            onClick={() => setEditsInvalidated(false)}
            style={{ background: 'none', border: 'none', color: '#8ab4f8', cursor: 'pointer', font: 'inherit', padding: 0 }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="wave-editor-body">
        <EditorBody
          project={project}
          viewMode={viewMode}
          onWordClick={handleWordClick}
          onSelectionChange={setSelectionRange}
          onContextMenu={handleTranscriptContextMenu}
          editActions={editActions}
          onUndoAction={undoAction}
          alignerReady={alignerReady}
          onRealign={realign}
          activeWordId={activeWordId}
          transcript={transcript}
          loading={loading}
          error={error}
          enrichedWords={enrichedWords}
          currentOps={currentOps}
          textTokens={textTokens}
          enhanceTool={enhanceTool}
          speakerTool={speakerTool}
          pauseTool={pauseTool}
          addedPauses={addedPauses}
          speakerLabels={speakerLabels}
          exportWords={exportWords}
          banner={banner}
          onRetry={onRetry}
        />
      </div>

      <WaveformTimeline
        waveform={waveform}
        onSelectionChange={handleTimelineSelection}
        isLooping={isLooping}
        hasSelection={selectionRange !== null}
        onLoopToggle={() => setIsLooping((v) => !v)}
        onDeleteAtMs={deleteAtMs}
        onCutResize={handleCutResize}
        onDoubleClickAt={selectAtMs}
        onContextMenuAt={handleTimelineContextMenu}
        onHoverAt={handleTimelineHover}
        words={enrichedWords}
        deletedWordIndices={deletedWords}
        selectionRange={selectionRange}
        referenceRange={reference}
        snapToWords={snapToWords}
        onSnapToggle={() => setSnapToWords((v) => !v)}
        partCutWordIndices={partCutWords}
        fullCutWordIndices={fullCutWords}
        speakerTurns={turns}
        speakerNames={speakerLabels?.names}
        selectedWordIndices={wordSelectionSet}
        selectedSpeaker={wordSelection?.speaker ?? null}
        selectionLabel={wordSelection ? `${wordSelection.label} · ${wordSelection.indices.length} words` : null}
        panelHeight={waveformHeight}
        onPanelHeightChange={setWaveformHeight}
      />

      <WordContextMenu
        menu={contextMenu}
        hasHighlight={reference !== null}
        onClose={closeContextMenu}
        {...menuActions(contextMenu)}
      />

      {correcting !== null && enrichedWords[correcting] && (
        <WordCorrection
          key={correcting}
          index={correcting}
          text={enrichedWords[correcting].text}
          heard={enrichedWords[correcting].correctedFrom ?? enrichedWords[correcting].text}
          onSave={(text) => { correctWord(correcting, text); setCorrecting(null); }}
          onCancel={() => setCorrecting(null)}
        />
      )}
    </div>
  );
}
