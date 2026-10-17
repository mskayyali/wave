import { useRef, useCallback, useState, useEffect } from 'react';
import { Select_01 as CursorIcon, Cut, Repeat, TextSelection, ZoomIn, ZoomOut, ZoomArea } from '@carbon/icons-react';
import { PlaybackControls } from './PlaybackControls';
import type { useWaveform } from '../../hooks/useWaveform';
import type { EnrichedWord } from '../../hooks/useTranscript';
import { speakerColor, type SpeakerTurn } from '../../lib/speakers';

type Tool = 'cursor' | 'blade';

const EMPTY_SET: ReadonlySet<number> = new Set();
const EMPTY_TURNS: SpeakerTurn[] = [];

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Format a millisecond duration as a compact string ("0.3s", "1.2s", "42s"). */
function fmtDur(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** Position to the millisecond: "5:35.123". */
function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
}

/** Selection length: "84 ms", "1.250s", "12.3s", "1:07.4". */
function fmtLength(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(3)}s`;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

// ─── Time ruler ───────────────────────────────────────────────────────────────

const NICE_STEPS_MS = [
  500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000,
];

function rulerStepMs(durationMs: number, zoomLevel: number): number {
  const visibleMs = durationMs / zoomLevel;
  const target    = visibleMs / 7;
  return NICE_STEPS_MS.find((s) => s >= target) ?? NICE_STEPS_MS[NICE_STEPS_MS.length - 1];
}

function fmtRuler(ms: number): string {
  const totalSecs = ms / 1000;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  // Show sub-second precision when zoomed in enough (step < 1s)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
  if (ms % 1000 !== 0) return `${m}:${String(Math.floor(s)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0').slice(0, 2)}`;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

interface WaveformRulerProps {
  durationMs:        number;
  currentMs:         number;
  zoomLevel:         number;
  wrapperScrollLeft: number;
}

function WaveformRuler({ durationMs, currentMs, zoomLevel, wrapperScrollLeft }: WaveformRulerProps) {
  if (durationMs <= 0) return null;

  const step = rulerStepMs(durationMs, zoomLevel);
  const ticks: number[] = [];
  for (let t = 0; t < durationMs; t += step) ticks.push(t);

  const cursorPct     = Math.min((currentMs / durationMs) * 100, 100);
  const totalWidthPct = zoomLevel * 100;

  return (
    <div className="wave-ruler" aria-hidden>
      <div
        className="wave-ruler__inner"
        style={{ width: `${totalWidthPct}%`, transform: `translateX(-${wrapperScrollLeft}px)` }}
      >
        {ticks.map((t) => (
          <div
            key={t}
            className="wave-ruler__tick"
            style={{ left: `${(t / durationMs) * 100}%` }}
          >
            <span className="wave-ruler__label">{fmtRuler(t)}</span>
          </div>
        ))}
        <div className="wave-ruler__playhead" style={{ left: `${cursorPct}%` }} />
      </div>
    </div>
  );
}

// ─── Word track ───────────────────────────────────────────────────────────────
//
// Sits between the time ruler and the waveform canvas.  Each word is rendered
// as an absolutely-positioned chip whose left/width correspond exactly to its
// audio timestamps.  Gaps between words (< 3 s, not covered by a silence
// sentinel) are shown as lightweight duration badges.
//
// Scroll sync uses the same `translateX(-scrollLeft)` trick as WaveformRuler:
// an inner div expands to `zoomLevel × 100%` and is translated with the scroll
// position from state.  This keeps the word positions perfectly aligned with
// the waveform canvas below at every zoom and scroll level.
//
// Virtualization: binary search finds the first visible word; the loop stops
// as soon as words fall outside the visible time window.  At zoom=1 with
// many words, chips narrower than MIN_CHIP_PX are skipped immediately.

const MIN_CHIP_PX  = 4;   // don't render chips narrower than this
const MIN_GAP_PX   = 22;  // don't render a gap badge in less than this width
const MIN_GAP_MS   = 60;  // don't badge gaps shorter than this

interface WaveWordTrackProps {
  words:              EnrichedWord[];
  deletedWordIndices: ReadonlySet<number>;
  partCutWordIndices: ReadonlySet<number>;
  fullCutWordIndices: ReadonlySet<number>;
  selectionRange:     { startMs: number; endMs: number } | null;
  referenceRange:     { startMs: number; endMs: number } | null;
  durationMs:         number;
  zoomLevel:          number;
  wrapperScrollLeft:  number;
  onWordClick:        (word: EnrichedWord, index: number) => void;
  /** Right-click on a word chip: the same menu as on the waveform at that word. */
  onContextMenuAt?:   (ms: number, clientX: number, clientY: number) => void;
  /** Who has the floor when: a coloured strip along the bottom of the lane. */
  speakerTurns:       SpeakerTurn[];
  speakerNames?:      Record<number, string>;
  /** Words selected individually (everything one speaker said). */
  selectedWordIndices: ReadonlySet<number> | null;
  /** The speaker those words belong to; their turns are emphasised. */
  selectedSpeaker:    number | null;
}

function WaveWordTrack({
  words, deletedWordIndices, partCutWordIndices, fullCutWordIndices, selectionRange, referenceRange,
  durationMs, zoomLevel, wrapperScrollLeft, onWordClick, onContextMenuAt, speakerTurns, speakerNames, selectedWordIndices, selectedSpeaker,
}: WaveWordTrackProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [contW, setContW] = useState(0);

  // Measure the outer container width; re-measure on resize.
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    setContW(el.clientWidth);
    const obs = new ResizeObserver(() => setContW(el.clientWidth));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Nothing to show until we have geometry and data.
  const ready = contW > 0 && durationMs > 0 && words.length > 0;

  // ── Build visible chips ─────────────────────────────────────────────────
  // Computed inline every render — the binary-search + small loop over
  // visible words is cheap enough that a useMemo with wrapperScrollLeft as
  // a dep (60 fps during scroll) would cost more in bookkeeping than the
  // computation itself.

  const chips: React.ReactNode[] = [];

  if (ready) {
    const pxPerMs    = (contW * zoomLevel) / durationMs;
    const visStartMs = wrapperScrollLeft / pxPerMs;
    const visEndMs   = (wrapperScrollLeft + contW) / pxPerMs;

    // Binary search: first word whose endMs is past the left viewport edge.
    let lo = 0;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].endMs <= visStartMs) lo = mid + 1;
      else hi = mid;
    }

    for (let i = lo; i < words.length; i++) {
      const w      = words[i];
      if (w.startMs > visEndMs) break;           // past the right edge → done

      const chipPx = (w.endMs - w.startMs) * pxPerMs;
      if (chipPx >= MIN_CHIP_PX) {
        // Cut as a word, or swallowed whole by a cut drawn on the waveform.
        const isDeleted  = deletedWordIndices.has(i) || fullCutWordIndices.has(i);
        const isPartCut  = !isDeleted && partCutWordIndices.has(i);
        const touched    = selectionRange != null &&
                           w.startMs < selectionRange.endMs &&
                           w.endMs   > selectionRange.startMs;
        const isSelected = (selectedWordIndices?.has(i) ?? false) || (touched &&
                           w.startMs >= selectionRange.startMs - 1 &&
                           w.endMs   <= selectionRange.endMs + 1);
        const isSelPart  = touched && !isSelected;
        const isReference = referenceRange != null &&
                            w.startMs >= referenceRange.startMs &&
                            w.endMs   <= referenceRange.endMs;

        const cls = [
          'wave-word-chip',
          w.isSilence ? 'wave-word-chip--silence' : '',
          isDeleted   ? 'wave-word-chip--deleted'  : '',
          isPartCut   ? 'wave-word-chip--partcut'  : '',
          isSelected && !isDeleted ? 'wave-word-chip--selected' : '',
          isSelPart  && !isDeleted ? 'wave-word-chip--selected-part' : '',
          isReference ? 'wave-word-chip--reference' : '',
          w.correctedFrom !== undefined ? 'wave-word-chip--corrected' : '',
        ].filter(Boolean).join(' ');

        // Silence chips show their duration; real word chips show the text.
        const label = w.isSilence ? fmtDur(w.endMs - w.startMs) : w.text;

        chips.push(
          <div
            key={`w${i}`}
            className={cls}
            style={{
              left:  `${(w.startMs / durationMs) * 100}%`,
              width: `${((w.endMs - w.startMs) / durationMs) * 100}%`,
            }}
            data-ms={(w.startMs + w.endMs) / 2}
            title={w.isSilence ? `${fmtDur(w.endMs - w.startMs)} silence`
              : w.correctedFrom !== undefined ? `${w.text} · corrected from "${w.correctedFrom}"` : w.text}
            onClick={() => onWordClick(w, i)}
          >
            {label}
          </div>
        );
      }

      // ── Gap badge between consecutive real words ─────────────────────────
      // Silence sentinels already cover their gap visually, so only add a
      // badge between two consecutive non-silence words.
      if (!w.isSilence && i + 1 < words.length) {
        const next   = words[i + 1];
        const gapMs  = next.startMs - w.endMs;
        const gapPx  = gapMs * pxPerMs;
        const gapEnd = next.startMs;

        if (
          !next.isSilence &&          // silence sentinel already fills this
          gapMs  >= MIN_GAP_MS &&
          gapPx  >= MIN_GAP_PX &&
          w.endMs   < visEndMs &&      // gap is at least partially visible
          gapEnd    > visStartMs
        ) {
          chips.push(
            <div
              key={`g${i}`}
              className="wave-gap-chip"
              style={{
                left:  `${(w.endMs / durationMs) * 100}%`,
                width: `${(gapMs   / durationMs) * 100}%`,
              }}
            >
              {fmtDur(gapMs)}
            </div>
          );
        }
      }
    }
  }

  // Speaker turns in view, as a strip under the chips.
  if (ready && speakerTurns.length > 0) {
    const pxPerMs  = (contW * zoomLevel) / durationMs;
    const visStart = wrapperScrollLeft / pxPerMs;
    const visEnd   = (wrapperScrollLeft + contW) / pxPerMs;
    let lo = 0, hi = speakerTurns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (speakerTurns[mid].endMs <= visStart) lo = mid + 1; else hi = mid;
    }
    for (let t = lo; t < speakerTurns.length && speakerTurns[t].startMs <= visEnd; t++) {
      const turn = speakerTurns[t];
      const dimmed = selectedSpeaker !== null && turn.speaker !== selectedSpeaker;
      chips.push(
        <div
          key={`s${t}`}
          className={`wave-speaker-turn${dimmed ? ' wave-speaker-turn--dimmed' : ''}`}
          style={{
            left:       `${(turn.startMs / durationMs) * 100}%`,
            width:      `${((turn.endMs - turn.startMs) / durationMs) * 100}%`,
            background: speakerColor(turn.speaker),
          }}
          title={speakerNames?.[turn.speaker] ?? `Speaker ${turn.speaker + 1}`}
        />
      );
    }
  }

  return (
    <div
      ref={outerRef}
      className="wave-word-track"
      aria-hidden
      onContextMenu={(e) => {
        const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-ms]');
        if (!chip || !onContextMenuAt) return;
        e.preventDefault();
        onContextMenuAt(Number(chip.dataset.ms), e.clientX, e.clientY);
      }}
    >
      {ready && (
        <div
          className="wave-word-track__inner"
          style={{
            width:     `${zoomLevel * 100}%`,
            transform: `translateX(-${wrapperScrollLeft}px)`,
          }}
        >
          {chips}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface WaveformTimelineProps {
  waveform:           ReturnType<typeof useWaveform>;
  /** `free`: drawn with ⌥ held, so it shouldn't snap to word edges. */
  onSelectionChange:  (range: { startMs: number; endMs: number } | null, free?: boolean) => void;
  isLooping:          boolean;
  hasSelection:       boolean;
  onLoopToggle:       () => void;
  onDeleteAtMs?:      (ms: number) => void;
  /** An edge of cut `index` was dragged on the waveform. */
  onCutResize?:       (index: number, startMs: number, endMs: number) => void;
  /** Double-click on the waveform at `ms`. */
  onDoubleClickAt?:   (ms: number) => void;
  /** Right-click on the waveform at `ms`. */
  onContextMenuAt?:   (ms: number, clientX: number, clientY: number) => void;
  /** The mouse is over `ms` on the waveform (null when it leaves). */
  onHoverAt?:         (ms: number | null) => void;
  /** Passage marked for reference from the transcript (outlined). */
  referenceRange?:    { startMs: number; endMs: number } | null;
  /** Drawn selections snap to word edges (off by default: the waveform is for exact edits). */
  snapToWords?:       boolean;
  onSnapToggle?:      () => void;
  /** Words partly / entirely inside a cut made on the waveform (not deleted as words). */
  partCutWordIndices?: ReadonlySet<number>;
  fullCutWordIndices?: ReadonlySet<number>;
  /** Enriched transcript words — drawn in the word track above the waveform. */
  words?:             EnrichedWord[];
  /** Indices into `words[]` that have been deleted (shown with red tint). */
  deletedWordIndices?: ReadonlySet<number>;
  /** Current selection range (highlighted in the word track). */
  selectionRange?:    { startMs: number; endMs: number } | null;
  /** Speaker turns for the strip under the word lane (empty when hidden). */
  speakerTurns?:      SpeakerTurn[];
  speakerNames?:      Record<number, string>;
  /** Words selected individually (everything one speaker said), and their speaker. */
  selectedWordIndices?: ReadonlySet<number> | null;
  selectedSpeaker?:   number | null;
  /** Readout for a selection that isn't one stretch of audio. */
  selectionLabel?:    string | null;
  /** Total height of the waveform panel in pixels. */
  panelHeight?:       number;
  /** Called when the user drags the resize handle to a new height. */
  onPanelHeightChange?: (h: number) => void;
}

export function WaveformTimeline({
  waveform, onSelectionChange, isLooping, hasSelection, onLoopToggle,
  onDeleteAtMs, onCutResize, onDoubleClickAt, onContextMenuAt, onHoverAt,
  words = [], deletedWordIndices = new Set(), selectionRange = null,
  referenceRange = null, snapToWords = false, onSnapToggle,
  partCutWordIndices = EMPTY_SET, fullCutWordIndices = EMPTY_SET,
  speakerTurns = EMPTY_TURNS, speakerNames, selectedWordIndices = null, selectedSpeaker = null, selectionLabel = null,
  panelHeight = 240, onPanelHeightChange,
}: WaveformTimelineProps) {
  const [activeTool, setActiveTool] = useState<Tool>('cursor');
  /** The selection while it's being drawn or resized (for the readout). */
  const [liveSelection, setLiveSelection] = useState<{ startMs: number; endMs: number } | null>(null);
  const resizeDragRef  = useRef<{ startY: number; startH: number } | null>(null);
  const timelineRef    = useRef<HTMLDivElement>(null);

  const {
    containerRef, isPlaying, currentMs, durationMs, rate, waveLoading,
    toggle, seek, setRate, handlers,
    zoomLevel, wrapperScrollLeft, setZoom, getWsScroll, setWsScroll,
    forceRedraw, zoomToRange,
  } = waveform;

  // ── Waveform interactions (wavesurfer.js handles the pointer itself) ──────
  //  • click        → seek (cursor tool also clears the selection; blade cuts the word)
  //  • double-click → select the word there, or the pause between words
  //  • drag         → draw a selection (edges snap to words; ⌥ for free); drag its edges to adjust it
  //  • drag a red cut's edge → nudge that cut boundary
  //  • right-click  → menu for the cut / selection / word / pause there
  handlers.current = {
    onClick: (ms) => {
      if (activeTool === 'blade') onDeleteAtMs?.(ms);
      else onSelectionChange(null);
    },
    onDoubleClick: (ms) => {
      if (activeTool === 'cursor') onDoubleClickAt?.(ms);
    },
    canSelect: () => activeTool === 'cursor',
    onSelectionChange: (range, free) => {
      setLiveSelection(null);
      if (range.endMs - range.startMs >= 1) onSelectionChange(range, free);
    },
    onSelectionLive: setLiveSelection,
    onCutResize,
    onContextMenu: onContextMenuAt,
    onHover: onHoverAt,
  };
  const zoomTarget = selectionRange ?? referenceRange;
  const readout    = liveSelection ?? selectionRange;

  // ── Wheel / pinch — registered on the whole timeline div ─────────────────
  // Attaching to the outer container (not just the overlay) means zoom and
  // scroll work when hovering over the ruler, word track, or toolbar too.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey) {
        // Trackpad pinch or Ctrl+scroll → zoom, keeping the time under the
        // cursor fixed (as Audition and Audacity do).
        const canvas = containerRef.current;
        let anchorMs: number | null = null;
        if (canvas && durationMs > 0) {
          const rect     = canvas.getBoundingClientRect();
          const pxPerSec = (rect.width * zoomLevelRef.current) / (durationMs / 1000);
          anchorMs = ((getWsScroll() + (e.clientX - rect.left)) / pxPerSec) * 1000;
        }
        const delta = -e.deltaY * 0.005;
        setZoom(zoomLevelRef.current * (1 + delta), anchorMs ?? 'auto');
      } else {
        // Two-finger swipe → horizontal scroll.
        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        setWsScroll(getWsScroll() + dx);
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setZoom, setWsScroll, getWsScroll, containerRef, durationMs]);

  const zoomLevelRef = useRef(zoomLevel);
  zoomLevelRef.current = zoomLevel;

  // ── Resize handle (drag to change panel height) ───────────────────────────
  // Dragging the handle UP increases panel height (panel anchored at bottom,
  // so upward drag expands it into the editor-body area).
  //
  // WaveSurfer's height:'auto' ResizeObserver watches width only, not height.
  // We batch forceRedraw() calls with a RAF so the canvas re-renders at most
  // once per frame during drag, and once more on release to ensure it's exact.
  const resizeRedrawRafRef = useRef<number>(0);

  const handleResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeDragRef.current = { startY: e.clientY, startH: panelHeight };
  }, [panelHeight]);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeDragRef.current) return;
    const delta = resizeDragRef.current.startY - e.clientY; // up = positive
    const newH  = Math.max(140, Math.min(600, resizeDragRef.current.startH + delta));
    onPanelHeightChange?.(newH);

    // Redraw waveform once per frame while resizing so canvas tracks the height.
    cancelAnimationFrame(resizeRedrawRafRef.current);
    resizeRedrawRafRef.current = requestAnimationFrame(() => { forceRedraw(); });
  }, [onPanelHeightChange, forceRedraw]);

  const handleResizeUp = useCallback(() => {
    resizeDragRef.current = null;
    // Final redraw after the last layout pass completes.
    cancelAnimationFrame(resizeRedrawRafRef.current);
    resizeRedrawRafRef.current = requestAnimationFrame(() => { forceRedraw(); });
  }, [forceRedraw]);

  // ── Word track click → seek + select ─────────────────────────────────────
  const handleWordChipClick = useCallback((word: EnrichedWord) => {
    // onSelectionChange causes EditorPage's effect to seek to startMs,
    // so we don't need a separate seek() call here.
    onSelectionChange({ startMs: word.startMs, endMs: word.endMs });
  }, [onSelectionChange]);

  return (
    <div ref={timelineRef} className="wave-timeline" style={{ height: panelHeight }}>
      {/* ── Resize handle (drag up/down to expand/shrink the panel) ─────── */}
      <div
        className="wave-resize-handle"
        onPointerDown={handleResizeDown}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeUp}
        title="Drag to resize"
      />
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="wave-waveform-toolbar">
        {(['cursor', 'blade'] as const).map((tool) => (
          <button
            key={tool}
            className={`wave-tool-btn${activeTool === tool ? ' wave-tool-btn--active' : ''}`}
            title={tool === 'cursor' ? 'Cursor (select)' : 'Blade (cut)'}
            onClick={() => setActiveTool(tool)}
          >
            {tool === 'cursor' ? <CursorIcon size={14} /> : <Cut size={14} />}
          </button>
        ))}

        <button
          className={`wave-tool-btn${snapToWords ? ' wave-tool-btn--active' : ''}`}
          title={snapToWords
            ? 'Snap to words: on — selection edges near a word edge land on it (⌥ to place freely)'
            : 'Snap to words: off — selections are exactly what you drag'}
          onClick={onSnapToggle}
          aria-pressed={snapToWords}
        >
          <TextSelection size={14} />
        </button>

        <div className="wave-tool-divider" />

        <button
          className={`wave-tool-btn${isLooping ? ' wave-tool-btn--active' : ''}${!hasSelection ? ' wave-tool-btn--disabled' : ''}`}
          title={hasSelection ? (isLooping ? 'Loop on — click to disable' : 'Loop selection') : 'Make a selection to enable loop'}
          onClick={hasSelection ? onLoopToggle : undefined}
          aria-pressed={isLooping}
        >
          <Repeat size={14} />
        </button>

        <div className="wave-tool-divider" />

        <button
          className="wave-tool-btn"
          title="Zoom out  (−)"
          onClick={() => setZoom(zoomLevelRef.current / 1.5)}
          disabled={zoomLevel <= 1}
        >
          <ZoomOut size={14} />
        </button>

        {zoomLevel > 1.01 && (
          <span className="wave-zoom-label" title="Current zoom level">
            {zoomLevel.toFixed(1)}×
          </span>
        )}

        <button
          className="wave-tool-btn"
          title="Zoom in  (+)"
          onClick={() => setZoom(zoomLevelRef.current * 1.5)}
        >
          <ZoomIn size={14} />
        </button>

        <button
          className={`wave-tool-btn${zoomTarget ? '' : ' wave-tool-btn--disabled'}`}
          title={zoomTarget ? 'Zoom to selection  (Z)' : 'Select something to zoom to it'}
          onClick={zoomTarget ? () => zoomToRange(zoomTarget.startMs, zoomTarget.endMs) : undefined}
        >
          <ZoomArea size={14} />
        </button>

        {zoomLevel > 1.01 && (
          <button
            className="wave-tool-btn wave-tool-btn--text"
            title="Whole file  (⇧Z)"
            onClick={() => setZoom(1)}
          >
            1×
          </button>
        )}

        {selectionLabel && !readout && (
          <span className="wave-selection-readout" title="⌫ deletes these words as one edit · Esc clears">
            {selectionLabel}
          </span>
        )}
        {readout && (
          <span
            className="wave-selection-readout"
            title={'Selection: start – end (length).\n'
              + '⇧←/→ moves its end, ⌥⇧←/→ its start (10 ms; add ⌘ for 1 ms).\n'
              + 'C previews it cut; ⌫ cuts exactly this.'}
          >
            {fmtClock(readout.startMs)} – {fmtClock(readout.endMs)}
            <span className="wave-selection-readout__len">{fmtLength(readout.endMs - readout.startMs)}</span>
          </span>
        )}
      </div>

      {/* ── Time ruler ──────────────────────────────────────────────────── */}
      <WaveformRuler
        durationMs={durationMs}
        currentMs={currentMs}
        zoomLevel={zoomLevel}
        wrapperScrollLeft={wrapperScrollLeft}
      />

      {/* ── Word track ──────────────────────────────────────────────────── */}
      <WaveWordTrack
        words={words}
        deletedWordIndices={deletedWordIndices}
        partCutWordIndices={partCutWordIndices}
        fullCutWordIndices={fullCutWordIndices}
        selectionRange={selectionRange}
        referenceRange={referenceRange}
        durationMs={durationMs}
        zoomLevel={zoomLevel}
        wrapperScrollLeft={wrapperScrollLeft}
        onWordClick={handleWordChipClick}
        onContextMenuAt={onContextMenuAt}
        speakerTurns={speakerTurns}
        speakerNames={speakerNames}
        selectedWordIndices={selectedWordIndices}
        selectedSpeaker={selectedSpeaker}
      />

      {/* ── Waveform canvas + overlay ────────────────────────────────────── */}
      <div className="wave-waveform-wrapper">
        <div
          ref={containerRef}
          className={`wave-waveform-canvas wave-waveform-canvas--${activeTool}`}
          data-loading={waveLoading || undefined}
        />
      </div>

      {/* ── Playback controls ────────────────────────────────────────────── */}
      <div className="wave-timeline-controls">
        <PlaybackControls
          isPlaying={isPlaying}
          ready={waveform.audioReady}
          currentMs={currentMs}
          durationMs={durationMs}
          rate={rate}
          onToggle={toggle}
          onSeek={seek}
          onRateChange={setRate}
        />
      </div>
    </div>
  );
}
