import { useEffect, useRef, useState } from 'react';
import type { InsertedPause } from '../../lib/editPlan';
import { pauseLengthLabel } from '../../lib/pauseOptions';

/** A separate overlay keeps pause controls outside WaveSurfer's shadow DOM.
 * Markers identify added audio at a source insertion point, not a source cut. */
export function PauseMarkers({ pauses, durationMs, zoomLevel, scrollLeft, onOpen }: {
  pauses: (InsertedPause & { id: string })[]; durationMs: number; zoomLevel: number; scrollLeft: number;
  onOpen: (id: string, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    setWidth(el.clientWidth); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const rows: number[] = [];
  return <div ref={ref} className="wave-pause-overlay">
    {width > 0 && durationMs > 0 && [...pauses].sort((a, b) => a.atMs - b.atMs).map(pause => {
      const x = pause.atMs / durationMs * width * zoomLevel - scrollLeft;
      if (x < -1 || x > width + 1) return null;
      const left = Math.max(4, Math.min(width - 92, x + 4));
      let row = rows.findIndex(end => end + 4 <= left);
      if (row < 0) row = rows.length;
      rows[row] = left + 88;
      return <div key={pause.id} className="wave-pause-overlay__marker" style={{ left: x }}>
        <button className="wave-pause-pill" data-pause-id={pause.id}
          style={{ left: left - x, top: 5 + row * 25 }}
          aria-label={`Added pause ${pauseLengthLabel(pause.ms)}; change length`}
          title="Added pause — click to change its length"
          onClick={event => { const box = event.currentTarget.getBoundingClientRect(); onOpen(pause.id, box.left, box.bottom); }}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onOpen(pause.id, event.clientX, event.clientY); }}>
          +{pauseLengthLabel(pause.ms)} ▾
        </button>
      </div>;
    })}
  </div>;
}
