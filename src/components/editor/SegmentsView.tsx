import { Fragment, useEffect, useMemo } from 'react';
import type { EnrichedWord } from '../../hooks/useTranscript';

// ─── Cue building ─────────────────────────────────────────────────────────────

const CUE_GAP_MS = 800;
const MAX_WORDS  = 12;

interface CueWord {
  text:       string;
  wordIndex:  number; // index into enrichedWords[] → id = `w${wordIndex}`
  startMs:    number;
  confidence: number;
  isSilence:  boolean;
}

interface Cue {
  startMs: number;
  words:   CueWord[];
}

function buildCues(words: EnrichedWord[]): Cue[] {
  if (words.length === 0) return [];
  const cues: Cue[] = [];
  let current: CueWord[] = [];

  const flush = () => {
    if (current.length > 0) { cues.push({ startMs: current[0].startMs, words: current }); current = []; }
  };

  for (let i = 0; i < words.length; i++) {
    const w    = words[i];
    const prev = words[i - 1];

    if (w.isSilence) {
      // Silence always gets its own cue — flush whatever precedes it, push silence, flush again
      flush();
      cues.push({ startMs: w.startMs, words: [{ text: w.text, wordIndex: i, startMs: w.startMs, confidence: w.confidence, isSilence: true }] });
      continue;
    }

    // Regular word: split on gap or cue length (skip gap check after a silence entry)
    const gapFromPrev = prev && !prev.isSilence ? w.startMs - prev.endMs : 0;
    if (current.length > 0 && (current.length >= MAX_WORDS || gapFromPrev >= CUE_GAP_MS)) {
      flush();
    }

    current.push({ text: w.text, wordIndex: i, startMs: w.startMs, confidence: w.confidence, isSilence: false });
  }

  flush();
  return cues;
}

function fmtTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface SegmentsViewProps {
  words:              EnrichedWord[];
  activeWordId:       string | null;
  onWordClick?:       (attrs: { id: string; startMs: number; endMs: number; text: string }) => void;
  onSelectionChange?: (range: { startMs: number; endMs: number } | null) => void;
}

export function SegmentsView({ words, activeWordId, onWordClick, onSelectionChange }: SegmentsViewProps) {
  const cues = useMemo(() => buildCues(words), [words]);

  // ── DOM-based highlight ───────────────────────────────────────────────────
  useEffect(() => {
    const prev = document.querySelector('.wave-segments .wave-word--active');
    prev?.classList.remove('wave-word--active');

    if (activeWordId) {
      const el = document.querySelector<HTMLElement>(`.wave-segments [data-word-id="${activeWordId}"]`);
      if (el) {
        el.classList.add('wave-word--active');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [activeWordId]);

  function handleMouseUp() {
    if (!onSelectionChange) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { onSelectionChange(null); return; }
    try {
      const fragment = sel.getRangeAt(0).cloneContents();
      let startMs = Infinity, endMs = -Infinity, found = false;
      fragment.querySelectorAll<HTMLElement>('[data-word-id]').forEach((el) => {
        const idx  = parseInt((el.getAttribute('data-word-id') ?? '').slice(1), 10);
        const word = words[idx];
        if (!word) return;
        startMs = Math.min(startMs, word.startMs);
        endMs   = Math.max(endMs, word.endMs);
        found   = true;
      });
      onSelectionChange(found ? { startMs, endMs } : null);
    } catch { onSelectionChange(null); }
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div className="wave-segments" onMouseUp={handleMouseUp}>
      {cues.map((cue, ci) => (
        <div key={ci} className={`wave-segment${cue.words[0]?.isSilence ? ' wave-segment--silence' : ''}`}>
          {!cue.words[0]?.isSilence && (
            <div className="wave-segment__ts">{fmtTimestamp(cue.startMs)}</div>
          )}
          <div className="wave-segment__text">
            {cue.words.map((w, wi) => {
              const cls = [
                'wave-word',
                w.isSilence
                  ? 'wave-word--silence'
                  : w.confidence < 0.6 ? 'wave-word--low'
                  : w.confidence < 0.8 ? 'wave-word--mid'
                  : '',
              ].filter(Boolean).join(' ');
              return (
                <Fragment key={w.wordIndex}>
                  {wi > 0 && ' '}
                  <span
                    className={cls}
                    data-word-id={`w${w.wordIndex}`}
                    data-start-ms={w.startMs}
                    onClick={() =>
                      onWordClick?.({
                        id:      `w${w.wordIndex}`,
                        startMs: w.startMs,
                        endMs:   words[w.wordIndex].endMs,
                        text:    w.text,
                      })
                    }
                  >
                    {w.text}
                  </span>
                </Fragment>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
