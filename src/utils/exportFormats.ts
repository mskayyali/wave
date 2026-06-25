import type { TranscriptWord } from '../hooks/useTranscript';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PARA_GAP_MS = 1500; // gap ≥ 1.5 s → new paragraph

/** Group word array into paragraphs based on silence gaps. */
function groupIntoParagraphs(words: TranscriptWord[]): TranscriptWord[][] {
  if (words.length === 0) return [];
  const paras: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    if (words[i].startMs - words[i - 1].endMs >= PARA_GAP_MS) {
      paras.push(current);
      current = [];
    }
    current.push(words[i]);
  }
  paras.push(current);
  return paras;
}

/** Milliseconds → SRT timestamp: 00:01:23,456 */
function toSRTTime(ms: number): string {
  const h  = Math.floor(ms / 3_600_000);
  const m  = Math.floor((ms % 3_600_000) / 60_000);
  const s  = Math.floor((ms % 60_000) / 1_000);
  const cs = ms % 1_000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(cs)}`;
}

/** Milliseconds → VTT timestamp: 00:01:23.456 */
function toVTTTime(ms: number): string {
  return toSRTTime(ms).replace(',', '.');
}

function pad2(n: number) { return String(n).padStart(2, '0'); }
function pad3(n: number) { return String(n).padStart(3, '0'); }

// ─── Group words into subtitle cues (≤ MAX_WORDS or gap ≥ CUE_GAP_MS) ───────

const CUE_GAP_MS  = 800;
const MAX_WORDS   = 12;

interface Cue { words: TranscriptWord[]; startMs: number; endMs: number }

function buildCues(words: TranscriptWord[]): Cue[] {
  if (words.length === 0) return [];
  const cues: Cue[] = [];
  let current: TranscriptWord[] = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startMs - words[i - 1].endMs;
    if (current.length >= MAX_WORDS || gap >= CUE_GAP_MS) {
      cues.push({
        words:   current,
        startMs: current[0].startMs,
        endMs:   current[current.length - 1].endMs,
      });
      current = [];
    }
    current.push(words[i]);
  }
  if (current.length > 0) {
    cues.push({
      words:   current,
      startMs: current[0].startMs,
      endMs:   current[current.length - 1].endMs,
    });
  }
  return cues;
}

// ─── Exported generators ──────────────────────────────────────────────────────

export function toPlainText(words: TranscriptWord[]): string {
  return groupIntoParagraphs(words)
    .map((para) => para.map((w) => w.text).join(' '))
    .join('\n\n');
}

export function toSRT(words: TranscriptWord[]): string {
  return buildCues(words)
    .map((cue, i) =>
      `${i + 1}\n${toSRTTime(cue.startMs)} --> ${toSRTTime(cue.endMs)}\n` +
      cue.words.map((w) => w.text).join(' ')
    )
    .join('\n\n');
}

export function toVTT(words: TranscriptWord[]): string {
  const body = buildCues(words)
    .map((cue) =>
      `${toVTTTime(cue.startMs)} --> ${toVTTTime(cue.endMs)}\n` +
      cue.words.map((w) => w.text).join(' ')
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}`;
}

export function toJSON(words: TranscriptWord[], language: string, durationMs: number): string {
  return JSON.stringify({ language, durationMs, words }, null, 2);
}
