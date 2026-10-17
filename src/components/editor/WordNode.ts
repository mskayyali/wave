import { Node, mergeAttributes } from '@tiptap/core';

/** Below this, Whisper may well have misheard the word: it's dimmed, with a tooltip. */
export const LOW_CONFIDENCE = 0.6;

export function lowConfidenceTitle(confidence: number): string {
  return `Possibly misheard · ${Math.round(confidence * 100)}% confidence`;
}

export function correctedTitle(from: string): string {
  return `Corrected from "${from}"`;
}

export const WordExtension = Node.create({
  name: 'word',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      id:         { default: null },
      text:       { default: '' },
      startMs:    { default: 0 },
      endMs:      { default: 0 },
      confidence: { default: 1.0 },
      deleted:    { default: false },
      isSilence:  { default: false },
      /** A pause added by hand: not a transcript word. */
      isPause:    { default: false },
      /** What transcription heard, when the word was corrected by hand. */
      correctedFrom: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-word-id]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const conf      = node.attrs.confidence as number;
    const isSilence = node.attrs.isSilence as boolean;
    const isPause   = node.attrs.isPause as boolean;
    const from      = node.attrs.correctedFrom as string | null;
    // A corrected word has been checked by hand, so it's no longer "possibly misheard".
    const isLow     = !isPause && !isSilence && from === null && conf < LOW_CONFIDENCE;
    const cls       = [
      'wave-word',
      isPause   ? 'wave-word--pause-token'
        : isSilence ? 'wave-word--silence' : from !== null ? 'wave-word--corrected' : isLow ? 'wave-word--low' : '',
      node.attrs.deleted ? 'wave-word--deleted' : '',
    ].filter(Boolean).join(' ');

    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-word-id':    node.attrs.id,
        'data-start-ms':   node.attrs.startMs,
        'data-end-ms':     node.attrs.endMs,
        'data-is-silence': isSilence ? 'true' : undefined,
        title: isPause ? 'An added pause (right-click to take it out)' : from !== null ? correctedTitle(from) : isLow ? lowConfidenceTitle(conf) : undefined,
        class: cls,
      }),
      node.attrs.text as string,
    ];
  },
});
