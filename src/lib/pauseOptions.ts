import { normalizeCuts, type CutRange, type InsertedPause } from './editPlan';

export const PAUSE_LENGTHS: readonly number[] = [250, 500, 1000, 2000];
export const pauseLengthLabel = (ms: number) => `${Number((ms / 1000).toFixed(3))} s`;

/** Show pauses at the same source insertion points the playback plan resolves. */
export function resolvePauseMarkers<T extends InsertedPause & { id: string }>(pauses: T[], cuts: CutRange[], durationMs: number): T[] {
  const union = normalizeCuts(cuts, durationMs);
  return pauses.filter(p => Number.isFinite(p.atMs) && Number.isFinite(p.ms) && p.ms > 0).map(p => {
    const at = Math.max(0, Math.min(durationMs, p.atMs));
    const cut = union.find(c => at >= c.startMs && at < c.endMs);
    return { ...p, atMs: cut?.endMs ?? at };
  });
}
