import type { EditorSelection } from './editorSession';
/** Edit intent is explicit; waveform coordinates never imply a padded word cut. */
export function selectionWordIndices(selection: EditorSelection, words: readonly {startMs: number; endMs: number}[]): number[] | null {
  if (selection.kind !== 'words') return null;
  if (selection.wordIndices) return [...new Set(selection.wordIndices)].filter(i => Number.isInteger(i) && i >= 0 && i < words.length);
  return words.flatMap((w, i) => w.endMs > selection.startMs && w.startMs < selection.endMs ? [i] : []);
}

/** A manual nudge can reveal audio from an earlier text deletion. Re-cutting
 * that word fills its remaining span instead of reusing the old nudge. */
export function wordCutIntent(indices: number[], deleted: ReadonlySet<number>, fullyCut: ReadonlySet<number>) {
  const kept = [...new Set(indices)].filter(i => !fullyCut.has(i));
  return { kept, fresh: kept.filter(i => !deleted.has(i)), revealed: kept.filter(i => deleted.has(i)) };
}
