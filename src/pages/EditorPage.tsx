import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineLoading } from '@carbon/react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { EditorTopBar } from '../components/editor/EditorTopBar';
import { TranscriptEditor } from '../components/editor/TranscriptEditor';
import { SegmentsView } from '../components/editor/SegmentsView';
import { InspectorPanel } from '../components/editor/InspectorPanel';
import { WaveformTimeline } from '../components/editor/WaveformTimeline';
import { useTranscript } from '../hooks/useTranscript';
import { useWaveform } from '../hooks/useWaveform';
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
  wordIndices: number[];  // indices into enrichedWords[]
  label:       string;    // human-readable "2 words (0:12–0:18)"
  createdAt:   number;
}

// ─── Silence enrichment ───────────────────────────────────────────────────────

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

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────
// Note: time-domain conversion helpers (toPreviewMs / toOriginalMs) live here
// when export is implemented.  The waveform always plays the original audio so
// no conversion is needed during playback — all timestamps are in original time.

type TimeOp = { startMs: number; endMs: number };

// ─── Editor body ──────────────────────────────────────────────────────────────

interface EditorBodyProps {
  project:           Project;
  viewMode:          ViewMode;
  onWordClick:       (attrs: { id: string; startMs: number; endMs: number; text: string }) => void;
  onSelectionChange: (range: SelectionRange | null) => void;
  activeWordId:      string | null;
  transcript:        ReturnType<typeof useTranscript>['transcript'];
  loading:           boolean;
  error:             string | null;
  editActions:       EditAction[];
  onUndoAction:      (id: string) => void;
  enrichedWords:     EnrichedWord[];
  filteredWords:     EnrichedWord[];
  currentOps:        TimeOp[];
}

// Wrapped in memo so it only re-renders when props actually change.
// During audio playback the parent (EditorPage) re-renders ~60fps as currentMs
// updates; without memo, TipTap and InspectorPanel would re-render 60fps too.
// The only prop that legitimately changes during playback is activeWordId
// (at word boundaries, ~once per 300-500ms), so memo cuts re-renders by ~100×.
const EditorBody = memo(function EditorBody({
  project, viewMode, onWordClick, onSelectionChange, activeWordId, transcript, loading, error,
  editActions, onUndoAction, enrichedWords, filteredWords, currentOps,
}: EditorBodyProps) {
  if (loading) {
    return (
      <div className="wave-editor-loading">
        <InlineLoading description="Loading transcript…" status="active" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="wave-editor-loading">
        <p className="wave-editor-loading__error">Failed to load transcript: {error}</p>
      </div>
    );
  }
  if (!transcript) {
    return (
      <div className="wave-editor-loading">
        <p className="wave-editor-loading__hint">
          {project.status.type === 'transcribing'
            ? 'Transcription in progress…'
            : project.status.type === 'readyToTranscribe'
            ? 'Audio imported — transcription will start automatically.'
            : 'No transcript available for this project.'}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="wave-editor-scroll">
        {viewMode === 'flow' ? (
          <TranscriptEditor
            words={enrichedWords}
            activeWordId={activeWordId}
            onWordClick={onWordClick}
            onSelectionChange={onSelectionChange}
          />
        ) : (
          <SegmentsView
            words={enrichedWords}
            activeWordId={activeWordId}
            onWordClick={onWordClick}
            onSelectionChange={onSelectionChange}
          />
        )}
      </div>

      <InspectorPanel
        transcript={transcript}
        projectName={project.name}
        projectId={project.id}
        filteredWords={filteredWords}
        currentOps={currentOps}
        editActions={editActions}
        onUndoAction={onUndoAction}
      />
    </>
  );
}); // end memo(EditorBody)

// ─── Page ─────────────────────────────────────────────────────────────────────

interface EditorPageProps {
  project:   Project;
  onBack:    () => void;
  onRename?: (id: string, name: string) => void;
}

export function EditorPage({ project, onBack, onRename }: EditorPageProps) {
  const [viewMode,        setViewMode]       = useState<ViewMode>('flow');
  const [audioSrc,        setAudioSrc]       = useState<string | null>(null);
  const [selectionRange,  setSelectionRange] = useState<SelectionRange | null>(null);
  const [isLooping,       setIsLooping]      = useState(false);
  const [editActions,     setEditActions]    = useState<EditAction[]>([]);
  const [waveformHeight,  setWaveformHeight] = useState(240);
  // Local override of the project name so it updates instantly after rename.
  const [projectName, setProjectName] = useState(project.name);
  // True once the initial edit history has been loaded from disk.
  // We use this to avoid immediately overwriting the saved file before loading.
  const editsLoadedRef = useRef(false);

  const { transcript, loading, error } = useTranscript(project.id);
  const waveform = useWaveform(audioSrc, project.id);

  // Destructure stable callbacks to keep effect deps clean
  const {
    setActiveWordRegion, clearActiveWordRegion,
    setSelectionRegion,  clearSelectionRegion,
    setDeletedRegions,
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
  const enrichedWords = useMemo<EnrichedWord[]>(
    () => transcript ? enrichWithSilences(transcript.words) : [],
    [transcript]
  );

  // Words kept for export: deleted entries removed, silence sentinels removed
  // (they are internal editing helpers, not real transcript content).
  const filteredWords = useMemo<EnrichedWord[]>(
    () => enrichedWords.filter((w, i) => !deletedWords.has(i) && !w.isSilence),
    [enrichedWords, deletedWords]
  );

  // ── Merged cut ops (original-time ranges) ─────────────────────────────────
  // Silence entries are cut exactly at their boundaries — they represent real
  // silence, no Whisper imprecision to absorb.  Real words get ±60 ms boundary
  // expansion to absorb Whisper's centisecond-resolution timestamp estimates.
  const TRIM_PAD_MS = 60;

  const currentOps = useMemo<TimeOp[]>(() => {
    if (enrichedWords.length === 0 || deletedWords.size === 0) return [];
    const allIndices = [...deletedWords].sort((a, b) => a - b);

    const rawOps: TimeOp[] = allIndices.map((idx) => {
      const word = enrichedWords[idx];
      if (!word) return null as unknown as TimeOp;

      // Silence sentinels: cut exactly, no expansion needed.
      if (word.isSilence) {
        return { startMs: word.startMs, endMs: word.endMs };
      }

      const prevWord = idx > 0 ? enrichedWords[idx - 1] : null;
      const nextWord = idx < enrichedWords.length - 1 ? enrichedWords[idx + 1] : null;

      // Gap to previous kept word (skip expansion if neighbour is a silence sentinel).
      const gapBefore = prevWord && !deletedWords.has(idx - 1) && !prevWord.isSilence
        ? word.startMs - prevWord.endMs
        : TRIM_PAD_MS;
      const expandStart = Math.min(TRIM_PAD_MS, Math.max(0, gapBefore));

      const gapAfter = nextWord && !deletedWords.has(idx + 1) && !nextWord.isSilence
        ? nextWord.startMs - word.endMs
        : TRIM_PAD_MS;
      const expandEnd = Math.min(TRIM_PAD_MS, Math.max(0, gapAfter));

      return {
        startMs: word.startMs - expandStart,
        endMs:   word.endMs   + expandEnd,
      };
    }).filter(Boolean) as TimeOp[];

    // Merge overlapping / adjacent ops (≤ 10 ms gap).
    const ops: TimeOp[] = [];
    for (const op of rawOps) {
      const last = ops[ops.length - 1];
      if (last && op.startMs <= last.endMs + 10) {
        last.endMs = Math.max(last.endMs, op.endMs);
      } else {
        ops.push({ startMs: op.startMs, endMs: op.endMs });
      }
    }
    return ops;
  }, [deletedWords, enrichedWords]);
  currentOpsRef.current = currentOps; // keep ref in sync with latest memo result

  // ── Load audio asset URL ──────────────────────────────────────────────────
  // Prefer the original stereo file for playback quality.  The 16 kHz mono
  // WAV is kept strictly for Whisper — playing it causes a 1-channel signal
  // that macOS routes to the left output only.
  // If WaveSurfer can't decode the original (unsupported codec in WKWebView)
  // it will emit an error and we fall back to the 16 kHz WAV.
  useEffect(() => {
    if (project.status.type !== 'ready') return;
    invoke<string>('get_playback_audio_path', { projectId: project.id })
      .then((fsPath) => setAudioSrc(convertFileSrc(fsPath)))
      .catch(() =>
        // Fallback: original unavailable, use the 16 kHz WAV
        invoke<string>('get_audio_path', { projectId: project.id })
          .then((fsPath) => setAudioSrc(convertFileSrc(fsPath)))
          .catch((e) => console.warn('Audio not available:', e))
      );
  }, [project.id, project.status.type]);

  // ── Load persisted edit history on mount ─────────────────────────────────
  useEffect(() => {
    invoke<string | null>('load_edits', { projectId: project.id })
      .then((json) => {
        if (json) {
          try {
            const saved = JSON.parse(json) as EditAction[];
            if (Array.isArray(saved) && saved.length > 0) {
              setEditActions(saved);
            }
          } catch {
            // Corrupted or old format — start fresh
          }
        }
      })
      .catch((e) => console.warn('Could not load edits:', e))
      .finally(() => { editsLoadedRef.current = true; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // ── Persist edit history whenever it changes ──────────────────────────────
  useEffect(() => {
    // Don't save until the initial load has completed, to avoid stomping
    // saved edits with an empty array before we've read them.
    if (!editsLoadedRef.current) return;
    invoke('save_edits', {
      projectId: project.id,
      data: JSON.stringify(editActions),
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

  // ── Playback position watcher: skip deleted regions + loop ────────────────
  // The waveform always plays the original audio file.  Deleted segments are
  // handled by seeking past them the moment playback enters their range.
  // This runs every RAF tick (~60 fps) via the currentMs state.
  useEffect(() => {
    if (!waveform.isPlaying) return;

    // Skip over any deleted region the playhead has entered.
    for (const op of currentOpsRef.current) {
      if (waveform.currentMs >= op.startMs && waveform.currentMs < op.endMs) {
        waveformRef.current.seek(op.endMs);
        return; // re-evaluate on next tick
      }
    }

    // Loop: wrap back to selection start when we pass the selection end.
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
  useEffect(() => {
    document.querySelectorAll('.wave-word--selected').forEach(
      (el) => el.classList.remove('wave-word--selected')
    );
    if (!selectionRange || enrichedWords.length === 0) return;
    enrichedWords.forEach((word, i) => {
      if (word.endMs > selectionRange.startMs && word.startMs < selectionRange.endMs) {
        document.querySelector(`[data-word-id="w${i}"]`)?.classList.add('wave-word--selected');
      }
    });
  }, [selectionRange, enrichedWords]);

  // ── DOM effect: mark deleted words ────────────────────────────────────────
  useEffect(() => {
    document.querySelectorAll('.wave-word--deleted').forEach(
      (el) => el.classList.remove('wave-word--deleted')
    );
    deletedWords.forEach((idx) => {
      document.querySelector(`[data-word-id="w${idx}"]`)?.classList.add('wave-word--deleted');
    });
  }, [deletedWords]);

  // ── Sync deleted regions → waveform visual overlay ───────────────────────
  // Non-destructive: the original audio stays loaded in WaveSurfer; deleted
  // segments are shown as red regions and skipped during playback.
  // No audio file is re-generated here — that happens only at export time.
  useEffect(() => {
    setDeletedRegions(currentOps);
  }, [currentOps, setDeletedRegions]);

  // ── Keep a sync ref to selectionRange so deleteSelection always reads latest
  const selectionRangeRef = useRef(selectionRange);
  selectionRangeRef.current = selectionRange;

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  // Assign synchronously during render (same as waveformRef) so the handler
  // always reads the latest version without a post-render effect.
  const deleteSelectionRef = useRef(deleteSelection);
  deleteSelectionRef.current = deleteSelection;

  // Keyboard handler uses waveformRef so it can have empty deps and NOT be
  // re-registered 60 times/second (waveform object reference changes every RAF
  // tick because currentMs is part of spread state).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const wf = waveformRef.current;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          wf.toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          wf.seek(wf.currentMs - 5000);
          break;
        case 'ArrowRight':
          e.preventDefault();
          wf.seek(wf.currentMs + 5000);
          break;
        case 'j': case 'J':
          wf.setRate(Math.max(0.5, parseFloat((wf.rate - 0.25).toFixed(2))));
          break;
        case 'l': case 'L':
          wf.setRate(Math.min(2, parseFloat((wf.rate + 0.25).toFixed(2))));
          break;
        case 'Escape':
          setSelectionRange(null);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          deleteSelectionRef.current();
          break;
        case 'z':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            setEditActions((prev) => prev.slice(0, -1));
          }
          break;
        // Zoom: = / + to zoom in, - to zoom out, 0 to reset
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
  const undoAction = useCallback((id: string) => {
    setEditActions((prev) => prev.filter((a) => a.id !== id));
  }, []);

  function deleteSelection() {
    const sr = selectionRangeRef.current;
    if (!sr || enrichedWords.length === 0) return;
    const indices = enrichedWords
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => w.endMs > sr.startMs && w.startMs < sr.endMs)
      .map(({ i }) => i)
      .filter((i) => !deletedWords.has(i));
    if (indices.length === 0) return;
    const first = enrichedWords[indices[0]];
    const last  = enrichedWords[indices[indices.length - 1]];
    // Label: if all selected items are silence sentinels, say "silence at …"
    const label = indices.length === 1 && first.isSilence
      ? `silence at ${fmtMs(first.startMs)}`
      : indices.length === 1
      ? `"${first.text}" at ${fmtMs(first.startMs)}`
      : `${indices.length} words (${fmtMs(first.startMs)}–${fmtMs(last.endMs)})`;
    setEditActions((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, wordIndices: indices, label, createdAt: Date.now() }]);
    setSelectionRange(null);
  }

  function deleteAtMs(ms: number) {
    if (enrichedWords.length === 0) return;
    const idx = findActiveWordIndex(enrichedWords, ms);
    if (idx < 0 || deletedWords.has(idx)) return;
    const word = enrichedWords[idx];
    setEditActions((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, wordIndices: [idx], label: `"${word.text}" at ${fmtMs(word.startMs)}`, createdAt: Date.now() }]);
  }

  // ── Word click → seek + select ───────────────────────────────────────────
  // Clicking a single word seeks to it AND selects it, so Delete/Backspace
  // can delete it immediately without needing a drag selection first.
  // useCallback + waveformRef keeps this stable for memo(EditorBody).
  const handleWordClick = useCallback((attrs: { id: string; startMs: number; endMs: number; text: string }) => {
    waveformRef.current.seek(attrs.startMs);
    setSelectionRange({ startMs: attrs.startMs, endMs: attrs.endMs });
  }, []); // waveformRef and setSelectionRange are both stable

  return (
    <div className="wave-editor">
      <EditorTopBar
        project={{ ...project, name: projectName }}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onBack={onBack}
        onRename={(name) => { setProjectName(name); onRename?.(project.id, name); }}
      />

      <div className="wave-editor-body">
        <EditorBody
          project={project}
          viewMode={viewMode}
          onWordClick={handleWordClick}
          onSelectionChange={setSelectionRange}
          editActions={editActions}
          onUndoAction={undoAction}
          activeWordId={activeWordId}
          transcript={transcript}
          loading={loading}
          error={error}
          enrichedWords={enrichedWords}
          filteredWords={filteredWords}
          currentOps={currentOps}
        />
      </div>

      <WaveformTimeline
        waveform={waveform}
        onSelectionChange={setSelectionRange}
        isLooping={isLooping}
        hasSelection={selectionRange !== null}
        onLoopToggle={() => setIsLooping((v) => !v)}
        onDeleteAtMs={deleteAtMs}
        words={enrichedWords}
        deletedWordIndices={deletedWords}
        selectionRange={selectionRange}
        panelHeight={waveformHeight}
        onPanelHeightChange={setWaveformHeight}
      />
    </div>
  );
}
