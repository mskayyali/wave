// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Speed selector ───────────────────────────────────────────────────────────

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

// ─── Component ────────────────────────────────────────────────────────────────

interface PlaybackControlsProps {
  isPlaying: boolean;
  /** The audio is decoded; until then a press plays as soon as it is. */
  ready?:    boolean;
  currentMs: number;
  durationMs: number;
  rate: number;
  onToggle:     () => void;
  onSeek:       (ms: number) => void;
  onRateChange: (r: number) => void;
}

export function PlaybackControls({
  isPlaying, ready = true, currentMs, durationMs, rate,
  onToggle, onSeek, onRateChange,
}: PlaybackControlsProps) {
  return (
    <div className="wave-playback">
      {/* Seek back */}
      <button
        className="wave-playback__seek-btn"
        onClick={() => onSeek(currentMs - 5000)}
        title="Back 5 seconds  (←)"
        aria-label="Back 5 seconds"
      >
        −5s
      </button>

      {/* Play / Pause */}
      <button
        className={`wave-playback__play-btn${ready ? '' : ' wave-playback__play-btn--waiting'}`}
        onClick={onToggle}
        title={!ready ? 'Preparing audio… (plays as soon as it is ready)' : isPlaying ? 'Pause  (Space)' : 'Play  (Space)'}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        aria-busy={!ready}
      >
        {isPlaying ? (
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
            <rect x="3" y="2" width="4" height="14" rx="1" />
            <rect x="11" y="2" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
            <path d="M5 3.5l10 5.5-10 5.5V3.5z" />
          </svg>
        )}
      </button>

      {/* Seek forward */}
      <button
        className="wave-playback__seek-btn"
        onClick={() => onSeek(currentMs + 5000)}
        title="Forward 5 seconds  (→)"
        aria-label="Forward 5 seconds"
      >
        +5s
      </button>

      {/* Time display */}
      <div className="wave-playback__time" aria-live="off">
        <span className="wave-playback__current">{fmtTime(currentMs)}</span>
        <span className="wave-playback__sep">/</span>
        <span className="wave-playback__total">{fmtTime(durationMs)}</span>
      </div>

      {/* Speed selector */}
      <div className="wave-playback__speeds" role="group" aria-label="Playback speed">
        {RATES.map((r) => (
          <button
            key={r}
            className={`wave-playback__speed-btn${r === rate ? ' wave-playback__speed-btn--active' : ''}`}
            aria-pressed={r === rate}
            onClick={() => onRateChange(r)}
            title={`${r}× speed`}
          >
            {r}×
          </button>
        ))}
      </div>
    </div>
  );
}
