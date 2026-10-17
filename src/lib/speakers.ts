import { formatLength } from './time';
// Speaker detection results (src-tauri/src/speakers.rs) applied to the words.

export interface SpeakerSegment {
  speaker: number;
  startMs: number;
  endMs:   number;
}

/** Who says each word, for the transcript, the segments view and exports. */
export interface SpeakerLabels {
  /** Speaker per enrichedWords index (merges applied); null for silences and unplaced words. */
  of:    (number | null)[];
  names: Record<number, string>;
}

/** A stretch where one speaker has the floor (for the waveform's speaker strip). */
export interface SpeakerTurn {
  speaker: number;
  startMs: number;
  endMs:   number;
}

/** The speaker a merged one now counts as (following merges into merges). */
export function rootSpeaker(id: number, speakers: readonly { id: number; mergedInto?: number | null }[]): number {
  let current = id;
  for (let hops = 0; hops < speakers.length; hops++) {
    const next = speakers.find((s) => s.id === current)?.mergedInto;
    if (next === null || next === undefined || next === current) break;
    current = next;
  }
  return current;
}

/**
 * Consecutive words of one speaker as one turn; a pause of 1.5 s or more ends
 * it, so long silences show as gaps.
 */
export function speakerTurns(
  words: readonly { startMs: number; endMs: number; isSilence?: boolean }[],
  of: readonly (number | null)[],
): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (let i = 0; i < words.length; i++) {
    const speaker = of[i];
    const w = words[i];
    if (w.isSilence || speaker === null || speaker === undefined) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker && w.startMs - last.endMs < 1500) last.endMs = w.endMs;
    else turns.push({ speaker, startMs: w.startMs, endMs: w.endMs });
  }
  return turns;
}

/** One colour per speaker channel (first arrival order), from Carbon's palette. */
export const SPEAKER_COLORS = ['#33b1ff', '#08bdba', '#ff7eb6', '#6fdc8c', '#be95ff', '#d2a106', '#4589ff', '#ff832b'];

export function speakerColor(id: number): string {
  return SPEAKER_COLORS[id % SPEAKER_COLORS.length];
}

/** A word with no speech under it takes the nearest speaker within this. */
const NEAREST_MS = 1000;

/**
 * Give each word the speaker it overlaps most. A word no segment overlaps
 * (a short one the model missed) takes the nearest segment within a second,
 * else the previous word's speaker. Silences get none.
 */
export function assignSpeakers(
  words: readonly { startMs: number; endMs: number; isSilence?: boolean }[],
  segments: readonly SpeakerSegment[],
): (number | null)[] {
  // Per speaker, segments are disjoint and sorted, so each can be searched.
  const bySpeaker = new Map<number, SpeakerSegment[]>();
  for (const s of segments) {
    if (!bySpeaker.has(s.speaker)) bySpeaker.set(s.speaker, []);
    bySpeaker.get(s.speaker)!.push(s);
  }
  for (const list of bySpeaker.values()) list.sort((a, b) => a.startMs - b.startMs);

  /** Index of the first segment ending after `ms`. */
  const firstEndingAfter = (list: SpeakerSegment[], ms: number) => {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].endMs <= ms) lo = mid + 1; else hi = mid;
    }
    return lo;
  };

  const out: (number | null)[] = [];
  let previous: number | null = null;
  for (const w of words) {
    if (w.isSilence) { out.push(null); continue; }
    let best: number | null = null;
    let bestOverlap = 0;
    let nearest: number | null = null;
    let nearestGap = NEAREST_MS;
    for (const [speaker, list] of bySpeaker) {
      const i = firstEndingAfter(list, w.startMs);
      let overlap = 0;
      for (let j = i; j < list.length && list[j].startMs < w.endMs; j++) {
        overlap += Math.min(w.endMs, list[j].endMs) - Math.max(w.startMs, list[j].startMs);
      }
      if (overlap > bestOverlap) { bestOverlap = overlap; best = speaker; }
      // Gaps to the segments either side of the word.
      const after = list[i];
      const before = list[i - 1];
      if (after && after.startMs >= w.endMs && after.startMs - w.endMs < nearestGap) { nearestGap = after.startMs - w.endMs; nearest = speaker; }
      if (before && w.startMs - before.endMs < nearestGap) { nearestGap = w.startMs - before.endMs; nearest = speaker; }
    }
    const speaker: number | null = best ?? nearest ?? previous;
    out.push(speaker);
    if (speaker !== null) previous = speaker;
  }
  return out;
}

export function formatTalkTime(ms: number): string {
  return formatLength(ms);
}
