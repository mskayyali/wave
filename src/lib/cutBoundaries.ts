import type { EnrichedWord } from '../hooks/useTranscript';
import { ENERGY_FRAME_MS } from './audioAnalysis';

/** Search pairs within the gaps only. A quiet point inside a kept word is
 * never eligible. Flat/silent energy keeps the conservative midpoint defaults. */
export function chooseBoundaries(energy: Float32Array | null, startMs: number, endMs: number,
  startLo: number, startHi: number, endLo: number, endHi: number): { startMs: number; endMs: number } {
  if (!energy?.length || startHi < startLo || endHi < endLo) return { startMs, endMs };
  const candidates = (lo: number, hi: number, initial: number) => {
    const points = [initial, lo, hi];
    for (let t = Math.ceil(lo / ENERGY_FRAME_MS) * ENERGY_FRAME_MS + ENERGY_FRAME_MS / 2; t < hi; t += ENERGY_FRAME_MS) points.push(t);
    return points;
  };
  const level = (ms: number) => energy[Math.min(energy.length - 1, Math.max(0, Math.floor(ms / ENERGY_FRAME_MS)))];
  const starts = candidates(startLo, startHi, startMs), ends = candidates(endLo, endHi, endMs);
  const scale = Math.max(1e-6, ...starts.map(level), ...ends.map(level));
  let best = Infinity, result = { startMs, endMs };
  for (const a of starts) for (const b of ends) {
    if (b <= a) continue;
    const left = level(a) / scale, right = level(b) / scale;
    const score = left + right + Math.abs(left - right) * 0.5
      + (Math.abs(a - startMs) + Math.abs(b - endMs)) / 60 * 0.25;
    if (score < best) { best = score; result = { startMs: a, endMs: b }; }
  }
  return result;
}

/** A cut range in original time. `startKey`/`endKey` name the edges so a
 *  drag on the waveform can be recorded as an adjustment of that edge. */
export type TimeOp = { startMs: number; endMs: number; startKey?: string; endKey?: string; fadeMs?: number; review?: boolean; manualBoundary?: boolean };

// ─── Cut ops ──────────────────────────────────────────────────────────────────
// Merged cut ops (original-time ranges), from the deleted words, free-range cuts
// and edge nudges. Pure, so a hypothetical edit can be previewed (C) exactly.
// Silence entries are cut exactly at their boundaries — they represent real
// silence, no Whisper imprecision to absorb.  Real words get up to ±60 ms of
// padding into the neighbouring gap to absorb timestamp imprecision.
//
// Candidate pairs stay outside kept words. Tight joins get a short fade and
// a review marker; manual nudges override automatic placement exactly.
const TRIM_PAD_MS = 60;

export function computeCutOps(
  enrichedWords: EnrichedWord[],
  deletedWords:  ReadonlySet<number>,
  rangeOps:      { startMs: number; endMs: number; id: string; fadeMs?: number; review?: boolean; manualBoundary?: boolean }[],
  adjustments:   ReadonlyMap<string, number>,
  energy:        Float32Array | null,
  fillerCuts:    { startMs: number; endMs: number }[] = [],
): TimeOp[] {
  const rawOps: TimeOp[] = [];

  // ── Removed fillers (an earlier version's edits): cut exactly at the saved
  // span; edges can be nudged like any cut.
  for (const f of fillerCuts) {
    const key = String(Math.round(f.startMs));
    rawOps.push({
      startMs:  adjustments.get(`fs:${key}`) ?? f.startMs,
      endMs:    adjustments.get(`fe:${key}`) ?? f.endMs,
      startKey: `fs:${key}`,
      endKey:   `fe:${key}`,
    });
  }

  // ── Word / silence deletions ──────────────────────────────────────────
  // Adjacent deleted entries form one run and are cut as a single contiguous
  // range — including any pauses between them. Cutting word-by-word left
  // every internal pause longer than ~130 ms behind as a sliver of audio.
  if (enrichedWords.length > 0 && deletedWords.size > 0) {
    const runs: [number, number][] = [];
    for (const idx of [...deletedWords].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && idx === last[1] + 1) last[1] = idx;
      else runs.push([idx, idx]);
    }

    for (const [firstIdx, lastIdx] of runs) {
      const first = enrichedWords[firstIdx];
      const last  = enrichedWords[lastIdx];
      if (!first || !last) continue;

      // Neighbours of a maximal run are always kept entries.
      const prevWord = firstIdx > 0 ? enrichedWords[firstIdx - 1] : null;
      const nextWord = lastIdx < enrichedWords.length - 1 ? enrichedWords[lastIdx + 1] : null;

      // Preserve half of short neighbouring gaps; search at most 60 ms into them.
      const gapBefore = prevWord && !prevWord.isSilence ? first.startMs - prevWord.endMs : TRIM_PAD_MS;
      const gapAfter  = nextWord && !nextWord.isSilence ? nextWord.startMs - last.endMs  : TRIM_PAD_MS;
      const expandStart = first.isSilence ? 0 : Math.min(TRIM_PAD_MS, Math.max(0, gapBefore) / 2);
      const expandEnd = last.isSilence ? 0 : Math.min(TRIM_PAD_MS, Math.max(0, gapAfter) / 2);
      const initialStart = Math.max(0, first.startMs - expandStart);
      const initialEnd = last.endMs + expandEnd;
      const boundary = chooseBoundaries(energy, initialStart, initialEnd,
        first.isSilence ? initialStart : Math.max(prevWord && !prevWord.isSilence ? prevWord.endMs : 0, first.startMs - TRIM_PAD_MS),
        first.startMs,
        last.endMs,
        last.isSilence ? initialEnd : Math.min(nextWord && !nextWord.isSilence ? nextWord.startMs : initialEnd, last.endMs + TRIM_PAD_MS));
      const startKey = `ws:${firstIdx}`;
      const endKey = `we:${lastIdx}`;
      const startMs = adjustments.get(startKey) ?? boundary.startMs;
      const endMs = adjustments.get(endKey) ?? boundary.endMs;
      const leftSpace = prevWord && !prevWord.isSilence ? Math.max(0, startMs - prevWord.endMs) : 12;
      const rightSpace = nextWord && !nextWord.isSilence ? Math.max(0, nextWord.startMs - endMs) : 12;
      const safeSpace = Math.min(leftSpace, rightSpace);
      rawOps.push({
        startMs,
        endMs,
        fadeMs: Math.max(2, Math.min(12, safeSpace)),
        review: (leftSpace < 5 && !adjustments.has(startKey)) || (rightSpace < 5 && !adjustments.has(endKey)),
        startKey,
        endKey,
      });
    }
  }

  // ── Free-range cuts (audio with no transcript word) ───────────────────
  // Used exactly as drawn. The resolved plan adds short, bounded fades.
  for (const r of rangeOps) {
    const startKey = `rs:${r.id}`;
    const endKey   = `re:${r.id}`;
    rawOps.push({
      startMs: adjustments.get(startKey) ?? r.startMs,
      endMs:   adjustments.get(endKey)   ?? r.endMs,
      fadeMs: r.fadeMs, review: r.review, manualBoundary: r.manualBoundary,
      startKey,
      endKey,
    });
  }

  const valid = rawOps.filter((op) => Number.isFinite(op.startMs) && Number.isFinite(op.endMs) && op.endMs > op.startMs);
  if (valid.length === 0) return [];

  // Merge overlapping cuts only: never silently swallow a short kept sound.
  // Keep track of which edit each outer edge came from.
  valid.sort((a, b) => a.startMs - b.startMs);
  const ops: TimeOp[] = [];
  for (const op of valid) {
    const last = ops[ops.length - 1];
    if (last && op.startMs <= last.endMs) {
      last.fadeMs = Math.min(last.fadeMs ?? 5, op.fadeMs ?? 5);
      last.review ||= op.review;
      last.manualBoundary ||= op.manualBoundary;
      if (op.endMs > last.endMs) {
        last.endMs  = op.endMs;
        last.endKey = op.endKey;
      }
    } else {
      ops.push({ ...op });
    }
  }
  return ops;
}
