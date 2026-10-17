// Pauses, read from the transcript: where they are, which ones run long, and
// how to shorten them (the Pauses tool); room tone for pauses added by hand;
// and where a moment of the original lands once cuts and added pauses apply
// (for subtitles that match the exported audio).

import type { EnrichedWord } from '../hooks/useTranscript';
import { ENERGY_FRAME_MS } from './audioAnalysis';

export interface Pause {
  /** The kept words either side (indices into enrichedWords). */
  before:   number;
  after:    number;
  startMs:  number;
  endMs:    number;
  /** Between sentences (the word before ends one, or the speaker changes). */
  sentence: boolean;
}

/** How long a pause may stay, between sentences and within one (ms). */
export interface Rhythm {
  id:       'tight' | 'natural' | 'relaxed';
  label:    string;
  sentence: number;
  within:   number;
}

export const RHYTHMS: Rhythm[] = [
  { id: 'tight',   label: 'Tight',   sentence: 500,  within: 300 },
  { id: 'natural', label: 'Natural', sentence: 750,  within: 450 },
  { id: 'relaxed', label: 'Relaxed', sentence: 1000, within: 600 },
];

/** Leave pauses this close to the limit alone: not worth a cut. */
const SLACK_MS = 100;

const ENDS_SENTENCE = /[.?!…]["'”’)\]]*$/;

/**
 * The pauses between kept words that no edit has touched yet, in order.
 * `cut(i)`: word i is cut; `cuts`: the cut ranges (original time, sorted).
 */
export function findPauses(
  words:     EnrichedWord[],
  cut:       (i: number) => boolean,
  cuts:      { startMs: number; endMs: number }[],
  speakerOf: (i: number) => number | null,
): Pause[] {
  const kept: number[] = [];
  words.forEach((w, i) => { if (!w.isSilence && !cut(i)) kept.push(i); });
  const out: Pause[] = [];
  let c = 0;
  for (let k = 1; k < kept.length; k++) {
    const a = words[kept[k - 1]], b = words[kept[k]];
    const startMs = a.endMs, endMs = b.startMs;
    if (endMs - startMs < 150) continue;
    while (c < cuts.length && cuts[c].endMs <= startMs) c++;
    if (c < cuts.length && cuts[c].startMs < endMs) continue; // already edited
    const sa = speakerOf(kept[k - 1]), sb = speakerOf(kept[k]);
    out.push({
      before: kept[k - 1], after: kept[k], startMs, endMs,
      sentence: ENDS_SENTENCE.test(a.text) || (sa !== null && sb !== null && sa !== sb),
    });
  }
  return out;
}

/** The cuts that bring each long pause down to the rhythm's length, from its middle. */
export function shortenPauses(pauses: Pause[], rhythm: Rhythm): { startMs: number; endMs: number }[] {
  return pauses.flatMap((p) => {
    const keep = p.sentence ? rhythm.sentence : rhythm.within;
    const ms = p.endMs - p.startMs;
    if (ms <= keep + SLACK_MS) return [];
    return [{ startMs: p.startMs + keep / 2, endMs: p.endMs - keep / 2 }];
  });
}

/**
 * The quietest 400 ms between words within 15 s of `atMs` (shorter if no
 * such gap): what the room sounds like there, to fill an added pause with.
 */
export function findRoomTone(energy: Float32Array | null, words: EnrichedWord[], atMs: number): { startMs: number; endMs: number } | undefined {
  if (!energy || energy.length === 0) return undefined;
  const busy = new Uint8Array(energy.length);
  for (const w of words) {
    if (w.isSilence) continue;
    const from = Math.max(0, Math.floor((w.startMs - 60) / ENERGY_FRAME_MS));
    const to = Math.min(energy.length, Math.ceil((w.endMs + 60) / ENERGY_FRAME_MS));
    busy.fill(1, from, to);
  }
  for (const frames of [40, 25, 15]) {
    const lo = Math.max(0, Math.floor((atMs - 15_000) / ENERGY_FRAME_MS));
    const hi = Math.min(energy.length - frames, Math.floor((atMs + 15_000) / ENERGY_FRAME_MS));
    let best = -1, bestSum = Infinity;
    for (let f = lo; f <= hi; f++) {
      let sum = 0, clear = true;
      for (let g = f; g < f + frames; g++) {
        if (busy[g]) { clear = false; f = g; break; }
        sum += energy[g];
      }
      if (clear && sum < bestSum) { bestSum = sum; best = f; }
    }
    if (best >= 0) return { startMs: best * ENERGY_FRAME_MS, endMs: (best + frames) * ENERGY_FRAME_MS };
  }
  return undefined;
}

/**
 * Where a moment of the original lands in the edited audio: minus what's cut
 * before it, plus the pauses added before it. A pause added exactly at a word's
 * start moves the word; one at its end doesn't stretch it (`edge`).
 */
export function editedTime(
  ms:      number,
  cuts:    { startMs: number; endMs: number }[],
  pauses:  { atMs: number; ms: number }[],
  edge:    'start' | 'end',
): number {
  let t = ms;
  for (const c of cuts) {
    if (c.startMs >= ms) break;
    t -= Math.min(c.endMs, ms) - c.startMs;
  }
  for (const p of pauses) {
    if (edge === 'start' ? p.atMs <= ms : p.atMs < ms) t += p.ms;
  }
  return Math.max(0, t);
}
