import { Fragment, useEffect, useMemo } from 'react';
import type { EnrichedWord } from '../../hooks/useTranscript';
import type { TranscriptContextEvent } from './TranscriptEditor';
import { speakerColor, type SpeakerLabels } from '../../lib/speakers';
import { LOW_CONFIDENCE, correctedTitle, lowConfidenceTitle } from './WordNode';
import { followWord } from '../../lib/followWord';

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
  /** Speaker of the cue's words, when speakers are shown. */
  speaker: number | null;
}

function buildCues(words: EnrichedWord[], speakers: SpeakerLabels | null): Cue[] {
  if (words.length === 0) return [];
  const cues: Cue[] = [];
  let current: CueWord[] = [];

  let currentSpeaker: number | null = null;
  const flush = () => {
    if (current.length > 0) { cues.push({ startMs: current[0].startMs, words: current, speaker: currentSpeaker }); current = []; }
  };

  for (let i = 0; i < words.length; i++) {
    const w    = words[i];
    const prev = words[i - 1];

    if (w.isSilence) {
      // Silence always gets its own cue — flush whatever precedes it, push silence, flush again
      flush();
      cues.push({ startMs: w.startMs, words: [{ text: w.text, wordIndex: i, startMs: w.startMs, confidence: w.confidence, isSilence: true }], speaker: null });
      continue;
    }

    // Regular word: split on gap or cue length (skip gap check after a silence entry)
    const gapFromPrev = prev && !prev.isSilence ? w.startMs - prev.endMs : 0;
    const speaker = speakers?.of[i] ?? null;
    const newSpeaker = current.length > 0 && speaker !== null && currentSpeaker !== null && speaker !== currentSpeaker;
    if (current.length > 0 && (current.length >= MAX_WORDS || gapFromPrev >= CUE_GAP_MS || newSpeaker)) {
      flush();
    }
    if (current.length === 0) currentSpeaker = speaker;

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
  /** Right-click on a word, or on a segment's timestamp (the whole segment). */
  onContextMenu?:     (e: TranscriptContextEvent) => void;
  /** Who says each word: segments split at turns and show the speaker. */
  speakers?:          SpeakerLabels | null;
}

export function SegmentsView({ words, activeWordId, onWordClick, onSelectionChange, onContextMenu, speakers = null }: SegmentsViewProps) {
  const cues = useMemo(() => buildCues(words, speakers), [words, speakers]);
  // The speaker each cue continues (silences carry the previous one), so a
  // name shows only where the speaker changes.
  const turnSpeakers = useMemo(() => {
    let current: number | null = null;
    return cues.map((cue) => (current = cue.speaker ?? current));
  }, [cues]);

  // ── DOM-based highlight ───────────────────────────────────────────────────
  useEffect(() => {
    const prev = document.querySelector('.wave-segments .wave-word--active');
    prev?.classList.remove('wave-word--active');

    if (activeWordId) {
      const el = document.querySelector<HTMLElement>(`.wave-segments [data-word-id="${activeWordId}"]`);
      if (el) {
        el.classList.add('wave-word--active');
        followWord(el);
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
            <div
              className="wave-segment__ts"
              title="Right-click to show this segment in the timeline"
              onContextMenu={(e) => {
                if (!onContextMenu) return;
                e.preventDefault();
                onContextMenu({ wordIndices: cue.words.map((w) => w.wordIndex), clientX: e.clientX, clientY: e.clientY });
              }}
            >
              {fmtTimestamp(cue.startMs)}
            </div>
          )}
          <div className="wave-segment__text">
            {speakers && cue.speaker !== null && cue.speaker !== turnSpeakers[ci - 1] && (
              <span className="wave-segment__speaker" style={{ ['--speaker-color' as string]: speakerColor(cue.speaker) }}>
                {speakers.names[cue.speaker] ?? `Speaker ${cue.speaker + 1}`}
              </span>
            )}
            {cue.words.map((w, wi) => {
              const from  = words[w.wordIndex].correctedFrom;
              const isLow = !w.isSilence && from === undefined && w.confidence < LOW_CONFIDENCE;
              const cls = [
                'wave-word',
                w.isSilence ? 'wave-word--silence' : from !== undefined ? 'wave-word--corrected' : isLow ? 'wave-word--low' : '',
              ].filter(Boolean).join(' ');
              return (
                <Fragment key={w.wordIndex}>
                  {wi > 0 && ' '}
                  <span
                    className={cls}
                    data-word-id={`w${w.wordIndex}`}
                    data-start-ms={w.startMs}
                    title={from !== undefined ? correctedTitle(from) : isLow ? lowConfidenceTitle(w.confidence) : undefined}
                    onClick={() =>
                      onWordClick?.({
                        id:      `w${w.wordIndex}`,
                        startMs: w.startMs,
                        endMs:   words[w.wordIndex].endMs,
                        text:    w.text,
                      })
                    }
                    onContextMenu={(e) => {
                      if (!onContextMenu) return;
                      e.preventDefault();
                      onContextMenu({ wordIndices: [w.wordIndex], clientX: e.clientX, clientY: e.clientY });
                    }}
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
