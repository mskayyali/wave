import { normalizeCuts } from './editPlan';

/** Text and waveform describe the actual retained audio, including manual edge changes. */
export function wordAudioState(words: readonly { startMs: number; endMs: number; isSilence?: boolean }[], cuts: readonly {startMs: number; endMs: number}[], durationMs: number) {
  const union = normalizeCuts([...cuts], durationMs);
  const fullCutWords = new Set<number>();
  const partCutWords = new Set<number>();
  const retainedMs = new Map<number, number>();
  let first = 0;
  words.forEach((word, i) => {
    while (first < union.length && union[first].endMs <= word.startMs) first++;
    let removed = 0;
    for (let j = first; j < union.length && union[j].startMs < word.endMs; j++) {
      removed += Math.max(0, Math.min(word.endMs, union[j].endMs) - Math.max(word.startMs, union[j].startMs));
    }
    const remaining = Math.max(0, word.endMs - word.startMs - removed);
    retainedMs.set(i, remaining);
    if (removed > 0 && remaining < 0.001) fullCutWords.add(i);
    else if (removed > 0.001) partCutWords.add(i);
  });
  return { fullCutWords, partCutWords, retainedMs };
}
