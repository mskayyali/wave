import { useCallback, useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin, { type Region, type RegionParams } from 'wavesurfer.js/plugins/regions';
import HoverPlugin from 'wavesurfer.js/plugins/hover';
import { EditPlayer, type CutRange, type InsertedPause, type PlayRangeOptions } from '../lib/editPlayer';
import { analyzeAudio } from '../lib/audioAnalysis';
import { activity } from '../lib/activity';
import type { WaveformPeaks } from '../lib/waveformData';

/** The background decode of the audio for playback (an activity). */
const PLAYBACK_JOB = 'playback';

// ─── Types ────────────────────────────────────────────────────────────────────

type RegionsInstance = ReturnType<typeof RegionsPlugin.create>;

export interface WaveformState {
  isPlaying:        boolean;
  currentMs:        number;
  durationMs:       number;
  rate:             number;
  waveLoading:      boolean;
  /** The audio is decoded and can play (the waveform can show before). */
  audioReady:       boolean;
  /** Set when the audio can't be fetched or decoded. */
  waveError:        boolean;
  /** Current zoom multiplier (1 = fit-to-width, >1 = zoomed in). */
  zoomLevel:        number;
  /** ScrollLeft of WaveSurfer's scroll container. */
  wrapperScrollLeft: number;
}

/** Waveform interactions, supplied by the timeline (kept in a ref, so always current). */
export interface WaveformHandlers {
  /** A selection was drawn or resized on the waveform. `free`: ⌥ was held (don't snap). */
  onSelectionChange?: (range: { startMs: number; endMs: number }, free: boolean) => void;
  /** The selection is being drawn or resized (fires continuously during the drag). */
  onSelectionLive?: (range: { startMs: number; endMs: number }) => void;
  /** An edge of cut `index` (into the last setCuts list) was dragged. */
  onCutResize?: (index: number, startMs: number, endMs: number) => void;
  /** A plain click at `ms` (WaveSurfer has already moved the playhead there). */
  onClick?: (ms: number) => void;
  /** A double-click at `ms`. */
  onDoubleClick?: (ms: number) => void;
  /** Whether a drag should draw a selection (false for the blade tool). */
  canSelect?: () => boolean;
  /** Right-click at `ms`. */
  onContextMenu?: (ms: number, clientX: number, clientY: number) => void;
  /** The mouse moved over `ms`, or left the waveform (null). */
  onHover?: (ms: number | null) => void;
}

const INITIAL: WaveformState = {
  isPlaying: false, currentMs: 0, durationMs: 0, rate: 1,
  waveLoading: false, audioReady: false, waveError: false, zoomLevel: 1, wrapperScrollLeft: 0,
};

const WAVE_COLOR        = '#5a5a5a';
const ACTIVE_WORD_COLOR = 'rgba(232, 160, 32, 0.10)';
const SELECTION_COLOR   = 'rgba(100, 149, 237, 0.30)';
const CUT_COLOR         = 'rgba(255, 80, 80, 0.20)';
/** An added pause: a marker where it goes, in green as additions are. */
const PAUSE_COLOR       = 'rgba(66, 190, 101, 0.9)';
const REFERENCE_COLOR   = 'rgba(190, 149, 255, 0.14)';
/** Deepest useful zoom: the drawing envelope has 1 ms resolution. */
const MAX_PX_PER_SEC    = 1000;
/** A revealed range narrower than this (px) gets zoomed in on. */
const MIN_REVEAL_PX     = 36;
/** A press that moves less than this is a click (seek), not a selection. */
const DRAG_THRESHOLD_PX = 3;
/** Dragging within this of the view's edge scrolls it. */
const EDGE_SCROLL_PX    = 24;

/** Where a zoom keeps its focus: a time, or 'auto' (pointer → selection → playhead → centre). */
export type ZoomAnchor = number | 'auto';

/** The selection region: edges resizable; dragging inside it draws a new one. */
const selectionParams = (startMs: number, endMs: number): RegionParams => ({
  start: startMs / 1000, end: endMs / 1000, color: SELECTION_COLOR, drag: false, resize: true,
});

/**
 * Turn following the playhead on or off. Flipped in place: setOptions() would
 * redraw the whole waveform, and the renderer reads this flag every frame.
 */
function setFollow(ws: WaveSurfer, on: boolean) {
  ws.options.autoScroll = on;
  const renderer = ws.getRenderer() as unknown as { options?: { autoScroll?: boolean } };
  if (renderer.options) renderer.options.autoScroll = on;
}

function formatHoverTime(seconds: number): string {
  const m  = Math.floor(seconds / 60);
  const s  = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
//
// Decodes the audio once and shares it between:
//  • EditPlayer — gapless playback of the edited timeline (cuts skipped with
//    the export crossfade, exact on the audio clock), driven by wavesurfer.js
//    through its `media` option;
//  • the waveform — drawn from a 1 ms max/min envelope, so it stays accurate
//    down to 1000 px/s instead of smearing at high zoom;
//  • `energy` — 10 ms RMS frames for placing cut edges at quiet points.
//
// Interaction: click to seek (wavesurfer), drag to draw a selection (our own
// handler — exact to the pointer), drag a selection's or cut's edge to adjust
// it (Regions plugin handles).

export interface WaveformSources {
  /**
   * The waveform built natively (waveform.rs): drawn at once, while `audioSrc`
   * decodes in the background for playback. Without it, the audio is decoded
   * and analysed here first, which takes seconds for a long compressed file.
   */
  peaks?:  WaveformPeaks | null;
  /**
   * Another version of the same audio on the same timeline (the enhanced one).
   * It's decoded in the background; while `useAlt` is on it plays and is drawn
   * instead, switching in place without losing position or zoom. Energy (used
   * to ease cut edges) always comes from the original, so edits don't move
   * when switching.
   */
  altSrc?: string | null;
  useAlt?: boolean;
}

export function useWaveform(audioSrc: string | null, { peaks = null, altSrc = null, useAlt = false }: WaveformSources = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef        = useRef<WaveSurfer | null>(null);
  const regionsRef   = useRef<RegionsInstance | null>(null);
  const playerRef    = useRef<EditPlayer | null>(null);
  const rafRef       = useRef<number>(0);
  const handlers     = useRef<WaveformHandlers>({});

  const activeWordRegionRef = useRef<Region | null>(null);
  const selectionRegionRef  = useRef<Region | null>(null);
  const referenceRegionRef  = useRef<Region | null>(null);
  const cutRegionsRef       = useRef<Region[]>([]);
  const cutsRef             = useRef<CutRange[]>([]);
  const pauseRegionsRef     = useRef<Region[]>([]);
  const pausesRef           = useRef<InsertedPause[]>([]);
  /** True while we add regions ourselves, to tell them apart from drawn ones. */
  const addingRef           = useRef(false);
  const zoomLevelRef        = useRef(1);
  const pendingZoomRef      = useRef<{ level: number; anchor: ZoomAnchor } | null>(null);
  const zoomRafRef          = useRef<number>(0);
  /** Time under the mouse while it's over the waveform (for pointer-anchored zoom). */
  const pointerMsRef        = useRef<number | null>(null);
  /** ⌥ is held: selections aren't snapped to words. */
  const altHeldRef          = useRef(false);
  /** The view saved by a zoom-to-range, so a second press can go back to it. */
  const zoomBackRef         = useRef<{ level: number; scroll: number; applied: { level: number; scroll: number } } | null>(null);
  /** Following the playhead is paused because the user scrolled away from it. */
  const followPausedRef     = useRef(false);

  const [state,  setState]  = useState<WaveformState>(INITIAL);
  const [energy, setEnergy] = useState<Float32Array | null>(null);

  /** The decoded `audioSrc` and `altSrc`, with their drawing envelopes. */
  const ctxRef     = useRef<AudioContext | null>(null);
  const mainRef    = useRef<{ buffer: AudioBuffer | null; envelope: Float32Array; duration: number } | null>(null);
  const altRef     = useRef<{ buffer: AudioBuffer; envelope: Float32Array } | null>(null);
  const shownRef   = useRef<AudioBuffer | null>(null);
  /** Bumped when `audioSrc` finishes loading (a new AudioContext and player). */
  const [mainVersion, setMainVersion] = useState(0);
  const [altReady,    setAltReady]    = useState(false);
  /** Bumped when the original's audio is decoded (after the waveform, with `peaks`). */
  const [mainAudio,   setMainAudio]   = useState(0);
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;

  const addRegion = useCallback((options: RegionParams): Region | null => {
    const regions = regionsRef.current;
    if (!regions) return null;
    addingRef.current = true;
    try {
      return regions.addRegion(options);
    } finally {
      addingRef.current = false;
    }
  }, []);

  /** A marker per added pause, labelled with its length ("+0.5 s"). */
  const renderPauseRegions = useCallback(() => {
    pauseRegionsRef.current.forEach((r) => r.remove());
    pauseRegionsRef.current = [];
    pausesRef.current.forEach((p, i) => {
      const label = document.createElement('span');
      label.className = 'wave-pause-marker';
      label.textContent = `+${(p.ms / 1000).toFixed(p.ms % 1000 === 0 ? 0 : p.ms % 100 === 0 ? 1 : 2)} s`;
      const region = addRegion({ id: `pause:${i}`, start: p.atMs / 1000, color: PAUSE_COLOR, drag: false, resize: false, content: label });
      if (region) pauseRegionsRef.current.push(region);
    });
  }, [addRegion]);

  const renderCutRegions = useCallback(() => {
    cutRegionsRef.current.forEach((r) => r.remove());
    cutRegionsRef.current = [];
    cutsRef.current.forEach((cut, i) => {
      const region = addRegion({
        id:        `cut:${i}`,
        start:     cut.startMs / 1000,
        end:       cut.endMs / 1000,
        color:     CUT_COLOR,
        drag:      false,
        resize:    true,
        minLength: 0.01,
      });
      if (region) cutRegionsRef.current.push(region);
    });
  }, [addRegion]);

  // ── Load: decode once, then build the player and the waveform ─────────────
  useEffect(() => {
    if (!audioSrc) {
      setState(INITIAL);
      return;
    }

    let cancelled = false;
    let ws: WaveSurfer | null = null;
    let player: EditPlayer | null = null;
    let detachPointer = () => {};
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    zoomLevelRef.current = 1;
    setState((s) => ({ ...s, waveLoading: true, audioReady: false, waveError: false, currentMs: 0, durationMs: 0, zoomLevel: 1, wrapperScrollLeft: 0 }));

    const decode = async () => {
      const response = await fetch(audioSrc);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return ctx.decodeAudioData(await response.arrayBuffer());
    };

    (async () => {
      try {
        // With precomputed peaks the waveform comes first and the audio after;
        // without, the audio is decoded and analysed here before anything shows.
        const pre = peaksRef.current;
        let buffer: AudioBuffer | null = null;
        let analysis: { envelope: Float32Array; energy: Float32Array };
        let durationSec: number;
        if (pre) {
          analysis    = pre;
          durationSec = pre.durationSec;
        } else {
          buffer = await decode();
          if (cancelled) return;
          analysis    = analyzeAudio(buffer);
          durationSec = buffer.duration;
        }
        if (cancelled || !containerRef.current) return;

        player = new EditPlayer(ctx, buffer, durationSec);
        player.setCuts(cutsRef.current);
        player.setInserts(pausesRef.current);
        const regions = RegionsPlugin.create();
        ws = WaveSurfer.create({
          container:     containerRef.current,
          media:         player as unknown as HTMLMediaElement,
          peaks:         [analysis.envelope],
          duration:      durationSec,
          // Traditional filled waveform (Audacity / Logic look) — no bars. No
          // "played" tint, as in Audition/Audacity: colour marks selections and
          // cuts, and the playhead alone marks position.
          waveColor:     WAVE_COLOR,
          progressColor: WAVE_COLOR,
          cursorColor:   '#e8a020',
          cursorWidth:   1,
          // 'auto' fills the container's CSS height; the panel is resizable.
          height:        'auto',
          normalize:     true,
          interact:      true,
          // Follow the playhead a page at a time (Premiere's default) rather
          // than scrolling continuously; paused while the user scrolls away.
          autoScroll:    true,
          autoCenter:    false,
          plugins: [
            regions,
            HoverPlugin.create({
              lineColor:         'rgba(255, 255, 255, 0.35)',
              lineWidth:         1,
              labelBackground:   '#262626',
              labelColor:        '#f4f4f4',
              labelSize:         '11px',
              formatTimeCallback: formatHoverTime,
            }),
          ],
        });

        wsRef.current      = ws;
        regionsRef.current = regions;
        playerRef.current  = player;
        setEnergy(analysis.energy);

        const basePxPerSec = () => (containerRef.current?.clientWidth ?? 1) / durationSec;
        ws.on('play',   () => {
          followPausedRef.current = false;
          if (wsRef.current) setFollow(wsRef.current, true);
          setState((s) => ({ ...s, isPlaying: true }));
        });
        ws.on('pause',  () => setState((s) => ({ ...s, isPlaying: false })));
        ws.on('finish', () => setState((s) => ({ ...s, isPlaying: false })));
        ws.on('zoom',   (pxPerSec) => {
          const level = pxPerSec > 0 ? Math.max(1, pxPerSec / basePxPerSec()) : 1;
          zoomLevelRef.current = level;
          setState((s) => ({ ...s, zoomLevel: level }));
        });
        ws.on('scroll', (_start, _end, scrollLeft) => setState((s) => ({ ...s, wrapperScrollLeft: scrollLeft })));
        ws.on('interaction', (time) => handlers.current.onClick?.(time * 1000));
        ws.on('dblclick', (relativeX) => handlers.current.onDoubleClick?.(relativeX * durationSec * 1000));

        // Resizing the selection's or a cut's edge (the Regions plugin's handles).
        const rangeOf = (region: Region) => ({ startMs: region.start * 1000, endMs: region.end * 1000 });
        regions.on('region-update', (region) => {
          if (region === selectionRegionRef.current) handlers.current.onSelectionLive?.(rangeOf(region));
        });
        regions.on('region-updated', (region) => {
          if (region === selectionRegionRef.current) {
            handlers.current.onSelectionChange?.(rangeOf(region), altHeldRef.current);
          } else if (region.id.startsWith('cut:')) {
            handlers.current.onCutResize?.(Number(region.id.slice(4)), region.start * 1000, region.end * 1000);
          }
        });

        // Track the time under the mouse (keyboard zoom centres on it; the
        // transcript underlines the word there) and right-clicks.
        const container = containerRef.current;
        const msAt = (clientX: number) => {
          const rect = container.getBoundingClientRect();
          const pxPerSec = Math.max(rect.width / durationSec, ws?.options.minPxPerSec ?? 0);
          return (((ws?.getScroll() ?? 0) + clientX - rect.left) / pxPerSec) * 1000;
        };
        const onPointerMove = (e: PointerEvent) => {
          pointerMsRef.current = msAt(e.clientX);
          handlers.current.onHover?.(pointerMsRef.current);
        };
        const onPointerLeave = () => {
          pointerMsRef.current = null;
          handlers.current.onHover?.(null);
        };
        const onContextMenu = (e: MouseEvent) => {
          if (!handlers.current.onContextMenu) return;
          e.preventDefault();
          handlers.current.onContextMenu(msAt(e.clientX), e.clientX, e.clientY);
        };

        // ── Drawing a selection ───────────────────────────────────────────
        // Done here, not with the Regions plugin's drag selection: that one
        // starts every selection 5 px wide (~350 ms at 10× zoom) and lets the
        // browser's text selection run alongside — in WebKit that highlights
        // the whole window. Here a drag draws exactly [press, pointer], to the
        // millisecond at any zoom; a press that barely moves is a click (seek).
        const durationMs = durationSec * 1000;
        const clampMs = (ms: number) => Math.max(0, Math.min(durationMs, ms));
        let drag: { pointerId: number; downX: number; anchorMs: number; startMs: number; endMs: number; active: boolean } | null = null;
        let swallowClick = false;

        const onDragMove = (e: PointerEvent) => {
          if (!drag || e.pointerId !== drag.pointerId) return;
          if (!drag.active) {
            if (Math.abs(e.clientX - drag.downX) <= DRAG_THRESHOLD_PX) return;
            drag.active = true;
          }
          e.preventDefault();
          const rect = container.getBoundingClientRect();
          if (ws && e.clientX > rect.right - EDGE_SCROLL_PX) {
            ws.setScroll(ws.getScroll() + (e.clientX - (rect.right - EDGE_SCROLL_PX)));
          } else if (ws && e.clientX < rect.left + EDGE_SCROLL_PX) {
            ws.setScroll(Math.max(0, ws.getScroll() - (rect.left + EDGE_SCROLL_PX - e.clientX)));
          }
          const ms = clampMs(msAt(e.clientX));
          drag.startMs = Math.min(drag.anchorMs, ms);
          drag.endMs   = Math.max(drag.anchorMs, ms);
          const existing = selectionRegionRef.current;
          if (existing) existing.setOptions({ start: drag.startMs / 1000, end: drag.endMs / 1000 });
          else selectionRegionRef.current = addRegion(selectionParams(drag.startMs, drag.endMs));
          handlers.current.onSelectionLive?.({ startMs: drag.startMs, endMs: drag.endMs });
        };
        const onDragEnd = (e: PointerEvent) => {
          if (!drag || e.pointerId !== drag.pointerId) return;
          window.removeEventListener('pointermove', onDragMove);
          window.removeEventListener('pointerup', onDragEnd);
          window.removeEventListener('pointercancel', onDragEnd);
          const done = drag;
          drag = null;
          if (!done.active) return;
          // The click that ends a drag isn't a seek.
          swallowClick = true;
          setTimeout(() => { swallowClick = false; }, 0);
          handlers.current.onSelectionChange?.({ startMs: done.startMs, endMs: done.endMs }, altHeldRef.current);
        };
        const onPointerDown = (e: PointerEvent) => {
          if (e.button !== 0 || handlers.current.canSelect?.() === false) return;
          // Pressing a region's edge resizes that region instead.
          const onHandle = e.composedPath().some((el) =>
            el instanceof Element && (el.getAttribute('part') ?? '').includes('region-handle'));
          if (onHandle) return;
          window.getSelection()?.removeAllRanges();
          const anchorMs = clampMs(msAt(e.clientX));
          drag = { pointerId: e.pointerId, downX: e.clientX, anchorMs, startMs: anchorMs, endMs: anchorMs, active: false };
          window.addEventListener('pointermove', onDragMove);
          window.addEventListener('pointerup', onDragEnd);
          window.addEventListener('pointercancel', onDragEnd);
        };
        // Keep a press on the waveform from starting the browser's text selection.
        const onMouseDown = (e: MouseEvent) => { if (e.button === 0) e.preventDefault(); };
        // Capture phase on the host runs before wavesurfer's own click handler.
        const onClickCapture = (e: MouseEvent) => {
          if (!swallowClick) return;
          swallowClick = false;
          e.stopPropagation();
          e.preventDefault();
        };

        container.addEventListener('pointermove', onPointerMove);
        container.addEventListener('pointerleave', onPointerLeave);
        container.addEventListener('contextmenu', onContextMenu);
        container.addEventListener('pointerdown', onPointerDown);
        container.addEventListener('mousedown', onMouseDown);
        container.addEventListener('click', onClickCapture, true);
        detachPointer = () => {
          container.removeEventListener('pointermove', onPointerMove);
          container.removeEventListener('pointerleave', onPointerLeave);
          container.removeEventListener('contextmenu', onContextMenu);
          container.removeEventListener('pointerdown', onPointerDown);
          container.removeEventListener('mousedown', onMouseDown);
          container.removeEventListener('click', onClickCapture, true);
          window.removeEventListener('pointermove', onDragMove);
          window.removeEventListener('pointerup', onDragEnd);
          window.removeEventListener('pointercancel', onDragEnd);
        };

        renderCutRegions();
        renderPauseRegions();
        mainRef.current  = { buffer, envelope: analysis.envelope, duration: durationSec };
        shownRef.current = buffer;
        setMainVersion((v) => v + 1);
        setState((s) => ({ ...s, durationMs: durationSec * 1000, waveLoading: false, audioReady: buffer !== null }));

        if (!buffer) {
          // The waveform is up; now the audio, for playback. WebKit decodes a
          // long MP3 in several seconds, so it shows as an activity meanwhile.
          activity.start({ id: PLAYBACK_JOB, label: 'Preparing playback', quietMs: 800 });
          let decoded: AudioBuffer;
          try {
            decoded = await decode();
          } finally {
            activity.finish(PLAYBACK_JOB); // a failure falls back to the 16 kHz copy (EditorPage)
          }
          if (cancelled || !mainRef.current) return;
          mainRef.current = { ...mainRef.current, buffer: decoded };
          setMainAudio((v) => v + 1);
          setState((s) => ({ ...s, audioReady: true }));
        }
      } catch (e) {
        if (cancelled) return;
        console.warn('Waveform: could not load audio:', e);
        setState((s) => ({ ...s, waveLoading: false, waveError: true }));
      }
    })();

    return () => {
      cancelled = true;
      activity.dismiss(PLAYBACK_JOB);
      cancelAnimationFrame(zoomRafRef.current);
      detachPointer();
      pointerMsRef.current        = null;
      activeWordRegionRef.current = null;
      selectionRegionRef.current  = null;
      referenceRegionRef.current  = null;
      cutRegionsRef.current       = [];
      pauseRegionsRef.current     = [];
      ws?.destroy();
      player?.destroy();
      ctx.close().catch(() => undefined);
      wsRef.current      = null;
      regionsRef.current = null;
      playerRef.current  = null;
      ctxRef.current     = null;
      mainRef.current    = null;
      shownRef.current   = null;
      setEnergy(null);
    };
  }, [audioSrc, renderCutRegions]);

  // ── The alternative version: decode it once the main audio is up ──────────
  useEffect(() => {
    altRef.current = null;
    setAltReady(false);
    const ctx = ctxRef.current;
    if (!altSrc || !ctx || mainVersion === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(altSrc);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        if (cancelled) return;
        altRef.current = { buffer, envelope: analyzeAudio(buffer).envelope };
        setAltReady(true);
      } catch (e) {
        if (!cancelled) console.warn('Waveform: could not load the alternative audio:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [altSrc, mainVersion]);

  // ── Switch between them in place ──────────────────────────────────────────
  useEffect(() => {
    const player = playerRef.current;
    const ws     = wsRef.current;
    const main   = mainRef.current;
    if (!player || !ws || !main) return;
    const target = useAlt && altReady && altRef.current ? altRef.current : main;
    if (shownRef.current === target.buffer) return;
    // Drawn from the original's peaks until it's switched; the player takes
    // whichever audio is there (null until the original is decoded).
    const redraw = shownRef.current !== null || target !== main;
    shownRef.current = target.buffer;
    player.setBuffer(target.buffer);
    if (redraw) ws.setOptions({ peaks: [target.envelope], duration: main.duration });
  }, [useAlt, altReady, mainVersion, mainAudio]);

  // ── Playhead (UI only — the audio itself is scheduled on the audio clock) ──
  useEffect(() => {
    function tick() {
      const ws = wsRef.current;
      if (ws) {
        const ms = ws.getCurrentTime() * 1000;
        setState((s) => (Math.abs(ms - s.currentMs) > 1 ? { ...s, currentMs: ms } : s));
        // Following was paused by a manual scroll: resume once the playhead
        // is back in view, so the page-turns pick up from there.
        if (followPausedRef.current && ws.isPlaying()) {
          const width = containerRef.current?.clientWidth ?? 0;
          const pxPerSec = Math.max(width / Math.max(ws.getDuration(), 1e-3), ws.options.minPxPerSec || 0);
          const x = (ms / 1000) * pxPerSec - ws.getScroll();
          if (x >= 0 && x <= width) {
            followPausedRef.current = false;
            setFollow(ws, true);
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── ⌥ held → selections aren't snapped to words ───────────────────────────
  useEffect(() => {
    const track = (e: KeyboardEvent | PointerEvent) => { altHeldRef.current = e.altKey; };
    const reset = () => { altHeldRef.current = false; };
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('pointerdown', track, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
      window.removeEventListener('pointerdown', track, true);
      window.removeEventListener('blur', reset);
    };
  }, []);

  /** Stop following the playhead until it's back in view (or playback restarts). */
  const pauseFollow = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || !ws.isPlaying()) return;
    followPausedRef.current = true;
    setFollow(ws, false);
  }, []);

  // ── Transport ──────────────────────────────────────────────────────────────
  const play   = useCallback(() => { void wsRef.current?.play(); }, []);
  const pause  = useCallback(() => { wsRef.current?.pause(); }, []);
  const toggle = useCallback(() => { void wsRef.current?.playPause(); }, []);

  const seek = useCallback((ms: number) => {
    const ws = wsRef.current;
    if (!ws) return;
    const clamped = Math.max(0, Math.min(ms, ws.getDuration() * 1000));
    ws.setTime(clamped / 1000);
    setState((s) => ({ ...s, currentMs: clamped }));
  }, []);

  const setRate = useCallback((r: number) => {
    wsRef.current?.setPlaybackRate(r, true);
    setState((s) => ({ ...s, rate: r }));
  }, []);

  // ── Zoom (anchored, coalesced per frame) ───────────────────────────────────
  const getMaxZoom = useCallback((): number => {
    const ws = wsRef.current;
    const width = containerRef.current?.clientWidth ?? 0;
    const dur = ws?.getDuration() ?? 0;
    if (!ws || dur <= 0 || width <= 0) return 32;
    return Math.max(32, Math.ceil((MAX_PX_PER_SEC * dur) / width));
  }, []);

  /** The visible window (ms) and the current scale, or null before load. */
  const getView = useCallback(() => {
    const ws    = wsRef.current;
    const width = containerRef.current?.clientWidth ?? 0;
    const dur   = ws?.getDuration() ?? 0;
    if (!ws || dur <= 0 || width <= 0) return null;
    const pxPerSec = Math.max(width / dur, ws.options.minPxPerSec || 0);
    const scroll   = ws.getScroll();
    return {
      width, dur, pxPerSec, scroll,
      startMs: (scroll / pxPerSec) * 1000,
      endMs:   ((scroll + width) / pxPerSec) * 1000,
    };
  }, []);

  /**
   * Context-aware zoom focus: the time under the mouse when it's over the
   * waveform, else the selection if it's on screen, else the playhead if it's
   * on screen, else the middle of the view.
   */
  const resolveAnchor = useCallback((anchor: ZoomAnchor, view: NonNullable<ReturnType<typeof getView>>): number => {
    if (typeof anchor === 'number') return anchor;
    if (pointerMsRef.current !== null) return pointerMsRef.current;
    const sel = selectionRegionRef.current;
    if (sel) {
      const a = sel.start * 1000;
      const b = sel.end * 1000;
      if (b > view.startMs && a < view.endMs) return (Math.max(a, view.startMs) + Math.min(b, view.endMs)) / 2;
    }
    const playMs = (wsRef.current?.getCurrentTime() ?? 0) * 1000;
    if (playMs >= view.startMs && playMs <= view.endMs) return playMs;
    return (view.startMs + view.endMs) / 2;
  }, []);

  /**
   * Zoom to `level`, keeping the anchor at the same spot on screen (see
   * resolveAnchor; pinch/wheel pass the mouse position explicitly). Trackpad
   * pinches fire dozens of events per frame, so only the last request in a
   * frame redraws the canvas.
   */
  const setZoom = useCallback((level: number, anchor: ZoomAnchor = 'auto') => {
    const clamped = Math.max(1, Math.min(getMaxZoom(), level));
    zoomLevelRef.current = clamped;
    setState((s) => ({ ...s, zoomLevel: clamped }));
    pendingZoomRef.current = {
      level:  clamped,
      anchor: anchor !== 'auto' ? anchor : (pendingZoomRef.current?.anchor ?? 'auto'),
    };

    cancelAnimationFrame(zoomRafRef.current);
    zoomRafRef.current = requestAnimationFrame(() => {
      const pending = pendingZoomRef.current;
      const ws      = wsRef.current;
      const view    = getView();
      pendingZoomRef.current = null;
      if (!pending || !ws || !view) return;

      const anchorMs = resolveAnchor(pending.anchor, view);
      const screenX  = (anchorMs / 1000) * view.pxPerSec - view.scroll;
      const newPx    = (view.width / view.dur) * pending.level;
      pauseFollow(); // resumes by itself if the playhead stays in view
      ws.zoom(newPx);
      ws.setScroll(Math.max(0, (anchorMs / 1000) * newPx - screenX));
    });
  }, [getMaxZoom, getView, pauseFollow, resolveAnchor]);

  /** Set the zoom level and scroll position at once (immediate, no anchor). */
  const applyView = useCallback((level: number, scroll: number) => {
    const ws   = wsRef.current;
    const view = getView();
    if (!ws || !view) return;
    cancelAnimationFrame(zoomRafRef.current);
    pendingZoomRef.current = null;
    pauseFollow();
    const clamped = Math.max(1, Math.min(getMaxZoom(), level));
    zoomLevelRef.current = clamped;
    setState((s) => ({ ...s, zoomLevel: clamped }));
    ws.zoom((view.width / view.dur) * clamped);
    ws.setScroll(Math.max(0, scroll));
  }, [getMaxZoom, getView, pauseFollow]);

  /** Zoom so that `windowMs` of audio fills the view, centred on `centerMs`. */
  const showWindow = useCallback((centerMs: number, windowMs: number) => {
    const view = getView();
    if (!view) return;
    const basePx = view.width / view.dur;
    const level  = Math.max(1, Math.min(getMaxZoom(), view.width / (Math.max(10, windowMs) / 1000) / basePx));
    applyView(level, (centerMs / 1000) * basePx * level - view.width / 2);
  }, [applyView, getMaxZoom, getView]);

  /**
   * Zoom to fit [startMs, endMs] with a little room either side. With
   * `toggle`, doing it again straight away returns to the previous view
   * (Audacity's zoom toggle).
   */
  const zoomToRange = useCallback((startMs: number, endMs: number, toggle = false) => {
    const ws   = wsRef.current;
    const view = getView();
    if (!ws || !view) return;
    const back = zoomBackRef.current;
    if (toggle && back
        && Math.abs(zoomLevelRef.current - back.applied.level) < 0.01
        && Math.abs(view.scroll - back.applied.scroll) < 2) {
      zoomBackRef.current = null;
      applyView(back.level, back.scroll);
      return;
    }
    const saved = { level: zoomLevelRef.current, scroll: view.scroll };
    showWindow((startMs + endMs) / 2, (endMs - startMs) / 0.8);
    zoomBackRef.current = { ...saved, applied: { level: zoomLevelRef.current, scroll: ws.getScroll() } };
  }, [applyView, getView, showWindow]);

  /**
   * Bring [startMs, endMs] into view without losing your place more than
   * needed: zoom in if it would be too thin to see (showing a few seconds of
   * context around it), zoom out if it doesn't fit, otherwise just scroll.
   */
  const revealRange = useCallback((startMs: number, endMs: number) => {
    const ws   = wsRef.current;
    const view = getView();
    if (!ws || !view) return;
    const spanMs  = endMs - startMs;
    const widthPx = (spanMs / 1000) * view.pxPerSec;
    if (widthPx < MIN_REVEAL_PX) {
      showWindow((startMs + endMs) / 2, Math.max(4000, spanMs / 0.6));
    } else if (widthPx > view.width * 0.9) {
      zoomToRange(startMs, endMs);
    } else if (startMs < view.startMs || endMs > view.endMs) {
      pauseFollow();
      ws.setScroll(Math.max(0, (((startMs + endMs) / 2) / 1000) * view.pxPerSec - view.width / 2));
    }
  }, [getView, pauseFollow, showWindow, zoomToRange]);

  const getWsScroll = useCallback((): number => wsRef.current?.getScroll() ?? 0, []);
  /** A manual scroll — also pauses following the playhead, so it isn't yanked back. */
  const setWsScroll = useCallback((pixels: number) => {
    pauseFollow();
    wsRef.current?.setScroll(pixels);
  }, [pauseFollow]);

  /** Re-render at the current zoom (the canvas watches width, not height). */
  const forceRedraw = useCallback(() => {
    const ws = wsRef.current;
    const width = containerRef.current?.clientWidth ?? 0;
    const dur = ws?.getDuration() ?? 0;
    if (!ws || dur <= 0 || width <= 0) return;
    ws.zoom((width / dur) * zoomLevelRef.current);
  }, []);

  // ── Regions ────────────────────────────────────────────────────────────────
  const setActiveWordRegion = useCallback((startMs: number, endMs: number) => {
    const existing = activeWordRegionRef.current;
    if (existing) {
      existing.setOptions({ start: startMs / 1000, end: endMs / 1000 });
      return;
    }
    const region = addRegion({ start: startMs / 1000, end: endMs / 1000, color: ACTIVE_WORD_COLOR, drag: false, resize: false });
    // A highlight only — let clicks and drags pass through to the waveform.
    if (region?.element) region.element.style.pointerEvents = 'none';
    activeWordRegionRef.current = region;
  }, [addRegion]);

  const clearActiveWordRegion = useCallback(() => {
    activeWordRegionRef.current?.remove();
    activeWordRegionRef.current = null;
  }, []);

  const setSelectionRegion = useCallback((startMs: number, endMs: number) => {
    const existing = selectionRegionRef.current;
    if (existing) {
      existing.setOptions({ start: startMs / 1000, end: endMs / 1000 });
      return;
    }
    selectionRegionRef.current = addRegion(selectionParams(startMs, endMs));
  }, [addRegion]);

  const clearSelectionRegion = useCallback(() => {
    selectionRegionRef.current?.remove();
    selectionRegionRef.current = null;
  }, []);

  /** A highlight that marks a word or passage for reference (not a selection). */
  const setReferenceRegion = useCallback((startMs: number, endMs: number) => {
    const existing = referenceRegionRef.current;
    if (existing) {
      existing.setOptions({ start: startMs / 1000, end: endMs / 1000 });
      return;
    }
    const region = addRegion({ id: 'reference', start: startMs / 1000, end: endMs / 1000, color: REFERENCE_COLOR, drag: false, resize: false });
    if (region?.element) {
      region.element.style.pointerEvents = 'none';
      region.element.style.boxShadow     = 'inset 0 0 0 1px rgba(190, 149, 255, 0.85)';
    }
    referenceRegionRef.current = region;
  }, [addRegion]);

  const clearReferenceRegion = useCallback(() => {
    referenceRegionRef.current?.remove();
    referenceRegionRef.current = null;
  }, []);

  /** Play [startMs, endMs] once and stop there (see PlayRangeOptions). */
  const playRange = useCallback((startMs: number, endMs: number, options?: PlayRangeOptions) => {
    void playerRef.current?.playRange(startMs / 1000, endMs / 1000, options);
  }, []);

  /** Cut ranges for playback (skipped, crossfaded) and display (draggable edges). */
  const setCuts = useCallback((cuts: CutRange[]) => {
    cutsRef.current = cuts;
    playerRef.current?.setCuts(cuts);
    renderCutRegions();
  }, [renderCutRegions]);

  /** Added pauses for playback (room tone) and display (markers). */
  const setInserts = useCallback((pauses: InsertedPause[]) => {
    pausesRef.current = pauses;
    playerRef.current?.setInserts(pauses);
    renderPauseRegions();
  }, [renderPauseRegions]);

  return {
    containerRef,
    ...state,
    energy,
    /** `altSrc` is decoded and can be switched to instantly. */
    altReady,
    handlers,
    play, pause, toggle, seek, setRate, playRange,
    setZoom, getMaxZoom, getWsScroll, setWsScroll, forceRedraw,
    getView, zoomToRange, revealRange,
    setActiveWordRegion, clearActiveWordRegion,
    setSelectionRegion, clearSelectionRegion,
    setReferenceRegion, clearReferenceRegion,
    setCuts, setInserts,
  };
}
