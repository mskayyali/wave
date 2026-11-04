import { useEffect } from 'react';
import type { wordAudioState } from '../lib/wordAudioState';
export type WordAudioState = ReturnType<typeof wordAudioState>;
/** Runs after document rebuilds too, so corrections and view changes retain audio marks. */
export function useWordAudioMarks(state: WordAudioState, dependencies: unknown[]) {
  useEffect(() => {
    document.querySelectorAll<HTMLElement>('.wave-transcript-editor [data-word-id]').forEach(el => {
      const index = Number(el.dataset.wordId?.slice(1));
      const full = state.fullCutWords.has(index), part = state.partCutWords.has(index);
      el.classList.toggle('wave-word--deleted', full);
      el.classList.toggle('wave-word--partcut', part);
      el.dataset.audioState = full ? 'removed' : part ? 'partial' : 'kept';
      if (part) {
        if (el.dataset.audioTitle === undefined) el.dataset.audioTitle = el.getAttribute('title') ?? '';
        el.title = `Audio partly cut · ${Math.round(state.retainedMs.get(index) ?? 0)} ms retained`;
      } else if (el.dataset.audioTitle !== undefined) {
        const original = el.dataset.audioTitle;
        if (original) el.title = original; else el.removeAttribute('title');
        delete el.dataset.audioTitle;
      }
    });
  }, [state, ...dependencies]); // The caller includes the document rebuild inputs.
}
