import { useRef, useCallback, useState, useEffect } from 'react';
import { Select_01 as CursorIcon, Cut, Repeat, ZoomIn, ZoomOut } from '@carbon/icons-react';
import { PlaybackControls } from './PlaybackControls';
import type { useWaveform } from '../../hooks/useWaveform';
import type { EnrichedWord } from '../../hooks/useTranscript';

type Tool = 'cursor' | 'blade';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Format a millisecond duration as a compact string ("0.3s", "1.2s", "42s"). */
function fmtDur(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
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
  selectionRange:     { startMs: number; endMs: number } | null;
  durationMs:         number;
  zoomLevel:          number;
  wrapperScrollLeft:  number;
  onWordClick:        (word: EnrichedWord, index: number) => void;
}

function WaveWordTrack({
  words, deletedWordIndices, selectionRange,
  durationMs, zoomLevel, wrapperScrollLeft, onWordClick,
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
        const isDeleted  = deletedWordIndices.has(i);
        const isSelected = selectionRange != null &&
                           w.startMs < selectionRange.endMs &&
                           w.endMs   > selectionRange.startMs;

        const cls = [
          'wave-word-chip',
          w.isSilence ? 'wave-word-chip--silence' : '',
          isDeleted   ? 'wave-word-chip--deleted'  : '',
          isSelected && !isDeleted ? 'wave-word-chip--selected' : '',
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
            title={w.isSilence ? `${fmtDur(w.endMs - w.startMs)} silence` : w.text}
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

  return (
    <div ref={outerRef} className="wave-word-track" aria-hidden>
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
  onSelectionChange:  (range: { startMs: number; endMs: number } | null) => void;
  isLooping:          boolean;
  hasSelection:       boolean;
  onLoopToggle:       () => void;
  onDeleteAtMs?:      (ms: number) => void;
  /** Enriched transcript words — used for the word track and snap-to-word. */
  words?:             EnrichedWord[];
  /** Indices into `words[]` that have been deleted (shown with red tint). */
  deletedWordIndices?: ReadonlySet<number>;
  /** Current selection range (highlighted in the word track). */
  selectionRange?:    { startMs: number; endMs: number } | null;
  /** Total height of the waveform panel in pixels. */
  panelHeight?:       number;
  /** Called when the user drags the resize handle to a new height. */
  onPanelHeightChange?: (h: number) => void;
}

export function WaveformTimeline({
  waveform, onSelectionChange, isLooping, hasSelection, onLoopToggle,
  onDeleteAtMs, words = [], deletedWordIndices = new Set(), selectionRange = null,
  panelHeight = 240, onPanelHeightChange,
}: WaveformTimelineProps) {
  const [activeTool, setActiveTool] = useState<Tool>('cursor');
  const dragRef        = useRef<{ startX: number; startMs: number } | null>(null);
  const resizeDragRef  = useRef<{ startY: number; startH: number } | null>(null);
  const overlayRef     = useRef<HTMLDivElement>(null);
  const timelineRef    = useRef<HTMLDivElement>(null);

  const {
    containerRef, isPlaying, currentMs, durationMs, rate, waveLoading,
    toggle, seek, setRate, setSelectionRegion, clearSelectionRegion,
    zoomLevel, wrapperScrollLeft, setZoom, getWsScroll, setWsScroll,
    forceRedraw,
  } = waveform;

  // ── xToMs ─────────────────────────────────────────────────────────────────
  // Convert a clientX to a timestamp, reading scroll live from the DOM (not
  // stale state) so accuracy is maintained during fast scrolling.
  const xToMs = useCallback((clientX: number): number => {
    const el = overlayRef.current;
    if (!el || durationMs <= 0) return 0;
    const rect       = el.getBoundingClientRect();
    const localX     = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const scrollLeft = getWsScroll();
    const totalPx    = rect.width * zoomLevelRef.current;
    return Math.max(0, Math.min((scrollLeft + localX) / totalPx, 1)) * durationMs;
  }, [durationMs, getWsScroll]);

  // ── Waveform pointer handlers ─────────────────────────────────────────────
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (activeTool !== 'cursor' && activeTool !== 'blade') return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startMs: xToMs(e.clientX) };
  }, [activeTool, xToMs]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(e.clientX - drag.startX) < 4) return;
    const ms    = xToMs(e.clientX);
    const start = Math.min(drag.startMs, ms);
    const end   = Math.max(drag.startMs, ms);
    if (end - start > 10) setSelectionRegion(start, end);
  }, [xToMs, setSelectionRegion]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    const moved = Math.abs(e.clientX - drag.startX);

    if (activeTool === 'blade' && moved < 6) {
      // Use startMs captured at pointerDown — more accurate than recalculating at
      // pointerUp where scroll/zoom may have changed since the click began.
      onDeleteAtMs?.(drag.startMs);
      return;
    }

    if (moved < 6) {
      // For a tap/click, use the position measured at pointerDown.
      // Recalculating xToMs(e.clientX) here can return wrong results if a
      // pending zoom RAF fired between pointerDown and pointerUp, resetting
      // the WaveSurfer scroll position before we read it.
      seek(drag.startMs);
      clearSelectionRegion();
      onSelectionChange(null);
    } else {
      // Drag selection: use exact time positions — no word snapping.
      // Snapping is only applied when a word chip or transcript word is
      // explicitly clicked, giving users pixel-accurate control for editing
      // silence gaps, cutting mid-word, or working with inexact transcriptions.
      const rawEnd   = xToMs(e.clientX);
      const startMs  = Math.min(drag.startMs, rawEnd);
      const endMs    = Math.max(drag.startMs, rawEnd);
      if (endMs - startMs > 10) {
        onSelectionChange({ startMs, endMs });
      }
    }
  }, [xToMs, seek, clearSelectionRegion, onSelectionChange, activeTool, onDeleteAtMs]);

  // ── Wheel / pinch — registered on the whole timeline div ─────────────────
  // Attaching to the outer container (not just the overlay) means zoom and
  // scroll work when hovering over the ruler, word track, or toolbar too.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey) {
        // Trackpad pinch or Ctrl+scroll → zoom.
        const delta = -e.deltaY * 0.005;
        setZoom(zoomLevelRef.current * (1 + delta));
      } else {
        // Two-finger swipe → horizontal scroll.
        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        setWsScroll(getWsScroll() + dx);
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setZoom, setWsScroll, getWsScroll]);

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
          onClick={() => setZoom(zoomLevel / 1.5)}
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
          onClick={() => setZoom(zoomLevel * 1.5)}
        >
          <ZoomIn size={14} />
        </button>

        {zoomLevel > 1.01 && (
          <button
            className="wave-tool-btn wave-tool-btn--text"
            title="Reset zoom  (⌘0)"
            onClick={() => setZoom(1)}
          >
            1×
          </button>
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
        selectionRange={selectionRange}
        durationMs={durationMs}
        zoomLevel={zoomLevel}
        wrapperScrollLeft={wrapperScrollLeft}
        onWordClick={handleWordChipClick}
      />

      {/* ── Waveform canvas + overlay ────────────────────────────────────── */}
      <div className="wave-waveform-wrapper">
        <div
          ref={containerRef}
          className="wave-waveform-canvas"
          data-loading={waveLoading || undefined}
        />

        <div
          ref={overlayRef}
          className={`wave-waveform-overlay wave-waveform-overlay--${activeTool}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
      </div>

      {/* ── Playback controls ────────────────────────────────────────────── */}
      <div className="wave-timeline-controls">
        <PlaybackControls
          isPlaying={isPlaying}
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
