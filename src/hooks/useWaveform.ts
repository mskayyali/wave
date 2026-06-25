import { useCallback, useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import { invoke } from '@tauri-apps/api/core';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WaveformState {
  isPlaying:        boolean;
  currentMs:        number;
  durationMs:       number;
  rate:             number;
  waveLoading:      boolean;
  /** Set when WaveSurfer fails to decode the audio source. */
  waveError:        boolean;
  /** Current zoom multiplier (1 = fit-to-width, >1 = zoomed in). */
  zoomLevel:        number;
  /** ScrollLeft of WaveSurfer's inner wrapper — updated every RAF tick. */
  wrapperScrollLeft: number;
}

const INITIAL: WaveformState = {
  isPlaying: false, currentMs: 0, durationMs: 0, rate: 1,
  waveLoading: false, waveError: false, zoomLevel: 1, wrapperScrollLeft: 0,
};

// Minimal shape we need from a region reference
type WsRegion = { remove: () => void };

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWaveform(audioSrc: string | null, projectId: string | null) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const wsRef         = useRef<WaveSurfer | null>(null);
  const regionsRef    = useRef<RegionsPlugin | null>(null);
  const rafRef        = useRef<number>(0);

  // Individual region refs — avoids nuking all regions at once
  const activeWordRegionRef  = useRef<WsRegion | null>(null);
  const selectionRegionRef   = useRef<WsRegion | null>(null);
  const deletedRegionsRef    = useRef<WsRegion[]>([]);
  const skipPeaksSaveRef     = useRef(false);

  const [state, setState] = useState<WaveformState>(INITIAL);

  // ── Create / recreate WaveSurfer when source changes ─────────────────────
  useEffect(() => {
    if (!audioSrc) {
      setState(INITIAL);
      return;
    }

    zoomLevelRef.current = 1;
    setState((s) => ({ ...s, waveLoading: true, currentMs: 0, durationMs: 0, waveError: false, zoomLevel: 1, wrapperScrollLeft: 0 }));

    let destroyed = false;

    async function init() {
      let peaks: number[][] | undefined;
      try {
        if (projectId) {
          const cached = await invoke<string | null>('load_peaks', { projectId });
          if (cached) peaks = JSON.parse(cached) as number[][];
        }
      } catch {
        // Non-critical
      }

      if (destroyed || !containerRef.current) return;

      const regions = RegionsPlugin.create();
      regionsRef.current = regions;

      const ws = WaveSurfer.create({
        container:     containerRef.current,
        url:           audioSrc!,
        peaks,
        // Traditional DAW-style filled waveform — no bars.
        // barWidth/barGap/barRadius are intentionally omitted so WaveSurfer
        // renders a continuous filled shape (Audacity / Logic Pro aesthetic)
        // rather than a bar-graph / equaliser look.
        waveColor:     '#484848',
        progressColor: 'rgba(232, 160, 32, 0.55)',
        cursorColor:   '#e8a020',
        cursorWidth:   1,
        // 'auto' lets WaveSurfer fill its container's CSS height; the container
        // height is controlled externally so the panel can be resized by the user.
        height:        'auto',
        normalize:     true,
        interact:      false, // Pointer interaction handled by overlay
        plugins:       [regions],
      });

      wsRef.current = ws;

      ws.on('ready', async (duration) => {
        setState((s) => ({ ...s, durationMs: duration * 1000, waveLoading: false }));
        const skip = skipPeaksSaveRef.current;
        skipPeaksSaveRef.current = false; // reset after first ready
        if (projectId && !peaks && !skip) {
          try {
            const computed = ws.exportPeaks({ maxLength: 8000, precision: 5 });
            await invoke('save_peaks', { projectId, data: JSON.stringify(computed) });
          } catch {
            // Non-critical
          }
        }
      });

      ws.on('play',   () => setState((s) => ({ ...s, isPlaying: true })));
      ws.on('pause',  () => setState((s) => ({ ...s, isPlaying: false })));
      ws.on('finish', () => setState((s) => ({ ...s, isPlaying: false })));
      ws.on('error',  (e) => { console.warn('WaveSurfer error:', e); setState((s) => ({ ...s, waveLoading: false, waveError: true })); });
    }

    init();

    return () => {
      destroyed = true;
      activeWordRegionRef.current = null;
      selectionRegionRef.current  = null;
      deletedRegionsRef.current   = [];
      if (wsRef.current) {
        wsRef.current.destroy();
        wsRef.current  = null;
        regionsRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSrc, projectId]);

  // Tracks the current zoom level so setZoom can read it without stale closure.
  const zoomLevelRef = useRef(1);

  // Used to batch rapid zoom requests (trackpad pinch fires 20-60 events/frame)
  // into a single ws.zoom() call per animation frame, preventing the waveform
  // canvas from being re-rendered dozens of times per frame.
  const pendingZoomRef = useRef<number | null>(null);
  const zoomRafRef    = useRef<number>(0);

  // ── RAF loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    function tick() {
      const ws = wsRef.current;
      if (ws) {
        const ms         = ws.getCurrentTime() * 1000;
        // Use ws.getScroll() which correctly reads from the inner .scroll
        // container (overflow-x: auto), not from .wrapper (which never scrolls).
        const scrollLeft = ws.getScroll?.() ?? 0;
        setState((s) => {
          const msChanged     = Math.abs(ms - s.currentMs) > 1;
          const scrollChanged = scrollLeft !== s.wrapperScrollLeft;
          if (msChanged || scrollChanged) {
            return { ...s, currentMs: ms, wrapperScrollLeft: scrollLeft };
          }
          return s;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  // ── Controls ──────────────────────────────────────────────────────────────
  const play   = useCallback(() => { wsRef.current?.play(); }, []);
  const pause  = useCallback(() => { wsRef.current?.pause(); }, []);
  const toggle = useCallback(() => { wsRef.current?.playPause(); }, []);

  const seek = useCallback((ms: number) => {
    const ws = wsRef.current;
    if (!ws) return;
    const d = ws.getDuration();
    if (d > 0) {
      ws.seekTo(Math.max(0, Math.min(ms / 1000 / d, 1)));
      setState((s) => ({ ...s, currentMs: Math.max(0, Math.min(ms, d * 1000)) }));
    }
  }, []);

  const setRate = useCallback((r: number) => {
    wsRef.current?.setPlaybackRate(r, true);
    setState((s) => ({ ...s, rate: r }));
  }, []);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  // minPxPerSec at level=1 is containerWidth/durationSecs — waveform exactly
  // fills the container.  At level>1 the canvas overflows and the wrapper
  // element scrolls horizontally.
  //
  // PERFORMANCE: ws.zoom() triggers a full canvas re-render which is expensive.
  // Trackpad pinch fires 20-60 wheel events per animation frame, so calling
  // ws.zoom() synchronously on each one would re-render the canvas 20-60×/frame.
  // Instead we update zoomLevel state immediately (responsive label) and defer
  // ws.zoom() to the next animation frame, coalescing all events in the batch.
  const setZoom = useCallback((level: number) => {
    const maxZoom = getMaxZoom();
    const clamped = Math.max(1, Math.min(maxZoom, level));
    zoomLevelRef.current  = clamped;
    pendingZoomRef.current = clamped;

    // State update is cheap — just a number; do it immediately for the label.
    setState((s) => ({ ...s, zoomLevel: clamped }));

    // Cancel any pending zoom RAF and re-schedule so only the final level
    // in this batch of wheel events actually re-renders the canvas.
    cancelAnimationFrame(zoomRafRef.current);
    zoomRafRef.current = requestAnimationFrame(() => {
      const pending   = pendingZoomRef.current;
      if (pending === null) return;
      pendingZoomRef.current = null;

      const ws        = wsRef.current;
      const container = containerRef.current;
      if (!ws || !container) return;
      const dur = ws.getDuration();
      if (dur <= 0) return;

      // Save position before zooming — ws.zoom() may reset the visual cursor.
      const currentTime = ws.getCurrentTime();
      const scrollPos   = ws.getScroll?.() ?? 0;

      ws.zoom((container.clientWidth / dur) * pending);

      // Restore cursor and scroll position after the zoom redraws.
      // Use a nested rAF so WaveSurfer's internal canvas flush completes first.
      requestAnimationFrame(() => {
        if (wsRef.current !== ws) return; // instance swapped out, bail
        if (currentTime > 0) ws.seekTo(Math.min(currentTime / ws.getDuration(), 1));
        if (scrollPos   > 0) ws.setScroll?.(scrollPos);
      });
    });
  }, []);

  /**
   * Compute the maximum meaningful zoom level for the current audio.
   *
   * A fixed cap (e.g. 32×) breaks for long recordings: at 32× on a 10-minute
   * file the canvas is only ~43 px/sec, making a 200 ms word chip ~8 px wide
   * — unreadable.  Instead we compute the zoom that yields a target pixel
   * density per second, so word chips are always legible at max zoom regardless
   * of recording length.
   *
   * Target: 400 px/sec at max zoom ≈ 80 px for a 200 ms word (comfortable).
   * Floor: 32× so short files still get reasonable zoom range.
   */
  const getMaxZoom = useCallback((): number => {
    const ws        = wsRef.current;
    const container = containerRef.current;
    if (!ws || !container) return 32;
    const dur = ws.getDuration();
    if (dur <= 0 || container.clientWidth <= 0) return 32;
    const TARGET_PX_PER_SEC = 400;
    return Math.max(32, Math.ceil((TARGET_PX_PER_SEC * dur) / container.clientWidth));
  }, []);

  /**
   * Get the current horizontal scroll position of WaveSurfer's scroll container.
   * Uses ws.getScroll() which correctly targets the inner .scroll div.
   */
  const getWsScroll = useCallback((): number => {
    return wsRef.current?.getScroll?.() ?? 0;
  }, []);

  /**
   * Set the horizontal scroll position of WaveSurfer's scroll container.
   * Uses ws.setScroll() which correctly targets the inner .scroll div.
   */
  const setWsScroll = useCallback((pixels: number): void => {
    wsRef.current?.setScroll?.(pixels);
  }, []);

  // ── Active-word region ────────────────────────────────────────────────────
  const setActiveWordRegion = useCallback((startMs: number, endMs: number) => {
    const r = regionsRef.current;
    if (!r) return;
    activeWordRegionRef.current?.remove();
    activeWordRegionRef.current = r.addRegion({
      start:  startMs / 1000,
      end:    endMs / 1000,
      color:  'rgba(232, 160, 32, 0.10)',
      drag:   false,
      resize: false,
    });
  }, []);

  const clearActiveWordRegion = useCallback(() => {
    activeWordRegionRef.current?.remove();
    activeWordRegionRef.current = null;
  }, []);

  // ── Selection region ──────────────────────────────────────────────────────
  const setSelectionRegion = useCallback((startMs: number, endMs: number) => {
    const r = regionsRef.current;
    if (!r) return;
    selectionRegionRef.current?.remove();
    selectionRegionRef.current = r.addRegion({
      start:  startMs / 1000,
      end:    endMs / 1000,
      color:  'rgba(100, 149, 237, 0.22)',
      drag:   false,
      resize: false,
    });
  }, []);

  const clearSelectionRegion = useCallback(() => {
    selectionRegionRef.current?.remove();
    selectionRegionRef.current = null;
  }, []);

  // ── Deleted-word regions (visual overlay on waveform) ─────────────────────
  // Marks removed segments with a distinct colour so the user sees what has
  // been cut without the audio actually being spliced.  Playback skips over
  // these regions at the EditorPage level.
  const setDeletedRegions = useCallback(
    (ops: ReadonlyArray<{ startMs: number; endMs: number }>) => {
      const r = regionsRef.current;
      // Remove previous deleted-region markers
      deletedRegionsRef.current.forEach((reg) => { try { reg.remove(); } catch { /* already removed */ } });
      deletedRegionsRef.current = [];
      if (!r) return;
      for (const op of ops) {
        try {
          const reg = r.addRegion({
            start:  op.startMs / 1000,
            end:    op.endMs   / 1000,
            color:  'rgba(255, 80, 80, 0.18)',
            drag:   false,
            resize: false,
          });
          deletedRegionsRef.current.push(reg);
        } catch { /* region plugin may not be ready */ }
      }
    },
    [],
  );

  const reloadAudio = useCallback((src: string) => {
    if (!containerRef.current) return;

    // Destroy the existing WaveSurfer instance completely before loading new
    // audio. Simply calling ws.load() on the same instance can leave stale
    // internal state (MediaElement reference, Web Audio nodes) that causes
    // garbled playback or the old audio to bleed through.
    if (wsRef.current) {
      wsRef.current.destroy();
      wsRef.current      = null;
      regionsRef.current = null;
    }
    activeWordRegionRef.current = null;
    selectionRegionRef.current  = null;
    deletedRegionsRef.current   = [];
    skipPeaksSaveRef.current    = true; // don't overwrite peaks.json with preview peaks
    setState((s) => ({ ...s, waveLoading: true, currentMs: 0, isPlaying: false }));

    // Recreate WaveSurfer with the new source. No peaks are passed so WaveSurfer
    // decodes the audio fresh — this is intentional for preview files.
    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    const ws = WaveSurfer.create({
      container:     containerRef.current!,
      url:           src,
      waveColor:     '#484848',
      progressColor: 'rgba(232, 160, 32, 0.55)',
      cursorColor:   '#e8a020',
      cursorWidth:   1,
      height:        'auto',
      normalize:     true,
      interact:      false,
      plugins:       [regions],
    });

    wsRef.current = ws;

    ws.on('ready', () => {
      setState((s) => ({ ...s, durationMs: ws.getDuration() * 1000, waveLoading: false }));
      // Never save peaks for preview audio — it has different content from audio_16k.wav
    });
    ws.on('play',   () => setState((s) => ({ ...s, isPlaying: true })));
    ws.on('pause',  () => setState((s) => ({ ...s, isPlaying: false })));
    ws.on('finish', () => setState((s) => ({ ...s, isPlaying: false })));
    ws.on('error',  (e) => {
      console.warn('WaveSurfer reload error:', e);
      setState((s) => ({ ...s, waveLoading: false }));
    });
  }, []);

  // ── Force WaveSurfer to redraw at the current zoom ───────────────────────
  // Called after the waveform panel is resized so WaveSurfer picks up the
  // new container height.  WaveSurfer's height:'auto' ResizeObserver watches
  // width but not height, so we nudge it by re-issuing the current zoom call.
  const forceRedraw = useCallback(() => {
    const ws        = wsRef.current;
    const container = containerRef.current;
    if (!ws || !container) return;
    const dur = ws.getDuration();
    if (dur <= 0) return;
    ws.zoom((container.clientWidth / dur) * zoomLevelRef.current);
  }, []);

  return {
    containerRef,
    ...state,
    play, pause, toggle, seek, setRate,
    setZoom, getMaxZoom, getWsScroll, setWsScroll,
    setActiveWordRegion, clearActiveWordRegion,
    setSelectionRegion, clearSelectionRegion,
    setDeletedRegions,
    reloadAudio,
    forceRedraw,
  };
}
