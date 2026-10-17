import type { TranscriptWord } from '../hooks/useTranscript';

/** A word to export, with its speaker's name when speakers are shown. */
export type ExportWord = TranscriptWord & { speaker?: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PARA_GAP_MS = 1500; // gap ≥ 1.5 s → new paragraph

/** Group word array into paragraphs on silence gaps and speaker turns. */
function groupIntoParagraphs(words: ExportWord[]): ExportWord[][] {
  if (words.length === 0) return [];
  const paras: ExportWord[][] = [];
  let current: ExportWord[] = [words[0]];
  for (let i = 1; i < words.length; i++) {
    if (words[i].startMs - words[i - 1].endMs >= PARA_GAP_MS || words[i].speaker !== words[i - 1].speaker) {
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

interface Cue { words: ExportWord[]; startMs: number; endMs: number }

function buildCues(words: ExportWord[]): Cue[] {
  if (words.length === 0) return [];
  const cues: Cue[] = [];
  let current: ExportWord[] = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const gap = words[i].startMs - words[i - 1].endMs;
    if (current.length >= MAX_WORDS || gap >= CUE_GAP_MS || words[i].speaker !== words[i - 1].speaker) {
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

export function toPlainText(words: ExportWord[]): string {
  let lastSpeaker: string | undefined;
  return groupIntoParagraphs(words)
    .map((para) => {
      const text = para.map((w) => w.text).join(' ');
      const speaker = para[0].speaker;
      const label = speaker && speaker !== lastSpeaker ? `${speaker}: ` : '';
      lastSpeaker = speaker;
      return label + text;
    })
    .join('\n\n');
}

/** A cue's text, with "Name: " in front when the speaker changes. */
function cueText(cue: Cue, previous: Cue | undefined): string {
  const text = cue.words.map((w) => w.text).join(' ');
  const speaker = cue.words[0].speaker;
  return speaker && speaker !== previous?.words[0].speaker ? `${speaker}: ${text}` : text;
}

export function toSRT(words: ExportWord[]): string {
  return buildCues(words)
    .map((cue, i, cues) => `${i + 1}\n${toSRTTime(cue.startMs)} --> ${toSRTTime(cue.endMs)}\n${cueText(cue, cues[i - 1])}`)
    .join('\n\n');
}

/** WebVTT marks the speaker with a voice span: `<v Name>text`. */
export function toVTT(words: ExportWord[]): string {
  const body = buildCues(words)
    .map((cue) => {
      const text = cue.words.map((w) => w.text).join(' ');
      const speaker = cue.words[0].speaker;
      return `${toVTTTime(cue.startMs)} --> ${toVTTTime(cue.endMs)}\n${speaker ? `<v ${speaker.replace(/>/g, '')}>${text}` : text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}`;
}

export function toJSON(words: ExportWord[], language: string, durationMs: number): string {
  return JSON.stringify({ language, durationMs, words }, null, 2);
}
