/** Wheel deltas use pixels, lines, or pages depending on the input device. */
export function wheelPixels(delta: number, mode: number, page: number): number {
  return Number.isFinite(delta) ? delta * (mode === 1 ? 16 : mode === 2 ? page : 1) : 0;
}
export function wheelZoom(deltaPixels: number): number { return Math.exp(Math.max(-2, Math.min(2, -deltaPixels * 0.005))); }
export function visibleRulerTicks(startMs: number, endMs: number, durationMs: number): number[] {
  const target = Math.max(1, (endMs - startMs) / 7);
  const power = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 5, 10].map(n => n * power).find(n => n >= target)!;
  const result: number[] = [];
  for (let t = Math.max(0, Math.floor(startMs / step) * step); t <= Math.min(durationMs, endMs + step); t += step) result.push(t);
  return result;
}
