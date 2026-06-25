import { Node, mergeAttributes } from '@tiptap/core';

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
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-word-id]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const conf      = node.attrs.confidence as number;
    const isSilence = node.attrs.isSilence as boolean;
    const cls       = [
      'wave-word',
      isSilence ? 'wave-word--silence' : (conf < 0.6 ? 'wave-word--low' : conf < 0.8 ? 'wave-word--mid' : ''),
      node.attrs.deleted ? 'wave-word--deleted' : '',
    ].filter(Boolean).join(' ');

    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-word-id':    node.attrs.id,
        'data-start-ms':   node.attrs.startMs,
        'data-end-ms':     node.attrs.endMs,
        'data-is-silence': isSilence ? 'true' : undefined,
        class: cls,
      }),
      node.attrs.text as string,
    ];
  },
});
