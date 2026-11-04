export interface AudioRange { startMs: number; endMs: number }
/** Subtract the union without rounding, joining gaps, or counting overlap twice. */
export function subtractRanges<T extends AudioRange>(ranges: readonly T[], restore: readonly AudioRange[]): T[] {
  let result = [...ranges];
  for (const keep of restore) {
    result = result.flatMap(range => {
      if (keep.endMs <= range.startMs || keep.startMs >= range.endMs) return [range];
      return [
        ...(keep.startMs > range.startMs ? [{ ...range, endMs: keep.startMs }] : []),
        ...(keep.endMs < range.endMs ? [{ ...range, startMs: keep.endMs }] : []),
      ];
    });
  }
  return result;
}
