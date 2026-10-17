// Finding a phrase among transcript words, ignoring case, accents and
// punctuation. Used by Find (⌘F) and the agents' find_text, so both agree.

/** For matching: lower case, no accents or punctuation. */
export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Every run of words that reads as `query`. Ranges are indices into `words`,
 * both ends included; words that are only punctuation (or pause markers) are
 * skipped over.
 */
export function findPhrase(words: readonly string[], query: string): { from: number; to: number }[] {
  const wanted = query.split(/\s+/).map(normalize).filter(Boolean);
  if (wanted.length === 0) return [];
  const keys = words.map((w, i) => ({ k: normalize(w), i })).filter((x) => x.k);
  const out: { from: number; to: number }[] = [];
  for (let s = 0; s + wanted.length <= keys.length; s++) {
    if (wanted.every((q, j) => keys[s + j].k === q)) out.push({ from: keys[s].i, to: keys[s + wanted.length - 1].i });
  }
  return out;
}
