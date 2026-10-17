import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Extension } from '@tiptap/core';
import { WordExtension } from './WordNode';
import type { EnrichedWord } from '../../hooks/useTranscript';
import type { SpeakerLabels } from '../../lib/speakers';
import { followWord } from '../../lib/followWord';

// ─── Document builder ─────────────────────────────────────────────────────────

/**
 * Something shown in the text that isn't a transcript word: a pause added by
 * hand (id `p` + its edit's id), placed by time.
 */
export interface TextToken {
  id:      string;
  label:   string;
  startMs: number;
}

// Gap ≥ this (ms) between real words → new paragraph.
// Silence entries (isSilence=true) always force their own paragraph so that
// the █ block appears as a standalone visual break rather than inline.
const PARA_GAP_MS = 1500;

/**
 * A speaker's name over the paragraph where their turn starts: attributes on
 * the paragraph, drawn by CSS (`p[data-speaker]::before`), so the label is
 * never part of the text or of a selection.
 */
const SpeakerTurns = Extension.create({
  name: 'speakerTurns',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        speaker: {
          default:    null,
          parseHTML:  (el) => el.getAttribute('data-speaker'),
          renderHTML: (attrs) => (attrs.speaker ? { 'data-speaker': attrs.speaker } : {}),
        },
        speakerIndex: {
          default:    null,
          parseHTML:  (el) => el.getAttribute('data-speaker-index'),
          renderHTML: (attrs) => (attrs.speakerIndex !== null ? { 'data-speaker-index': String(attrs.speakerIndex) } : {}),
        },
      },
    }];
  },
});

function buildDocument(words: EnrichedWord[], tokens: TextToken[] = [], speakers: SpeakerLabels | null = null) {
  if (words.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }

  // Each paragraph remembers its speaker (that of its first word).
  const paragraphs: { content: object[]; speaker: number | null }[] = [];
  let current: object[] = [];
  let currentSpeaker: number | null = null;
  let lastSpeaker: number | null = null;
  const flush = () => {
    if (current.length > 0) paragraphs.push({ content: current, speaker: currentSpeaker });
    current = [];
  };
  // Tokens are placed by time: each goes before the first word that starts after it.
  let nextToken = 0;
  const pushToken = (t: TextToken) => {
    if (current.length > 0) current.push({ type: 'text', text: ' ' });
    current.push({
      type:  'word',
      attrs: { id: t.id, text: t.label, startMs: t.startMs, endMs: t.startMs, isPause: true },
    });
  };

  for (let i = 0; i < words.length; i++) {
    const w    = words[i];
    const prev = words[i - 1];

    // Force a paragraph break:
    //  • before any silence entry (so █ gets its own paragraph)
    //  • after any silence entry (the next real word starts fresh)
    //  • whenever the gap between real words exceeds PARA_GAP_MS
    const prevIsSilence = prev?.isSilence ?? false;
    const gapBreak      = i > 0 && !w.isSilence && !prevIsSilence &&
                          w.startMs - prev.endMs >= PARA_GAP_MS;
    // A new speaker takes the floor: their turn starts a paragraph.
    const speaker   = speakers?.of[i] ?? null;
    const turnBreak = !w.isSilence && speaker !== null && lastSpeaker !== null && speaker !== lastSpeaker;

    if (i > 0 && (w.isSilence || prevIsSilence || gapBreak || turnBreak)) flush();
    if (current.length === 0) currentSpeaker = w.isSilence ? null : speaker;
    if (!w.isSilence && speaker !== null) lastSpeaker = speaker;

    while (!w.isSilence && nextToken < tokens.length && tokens[nextToken].startMs < w.startMs) {
      pushToken(tokens[nextToken++]);
    }

    if (current.length > 0) {
      current.push({ type: 'text', text: ' ' });
    }

    current.push({
      type:  'word',
      attrs: {
        id:        `w${i}`,
        text:      w.text,
        startMs:   w.startMs,
        endMs:     w.endMs,
        confidence: w.confidence,
        deleted:   false,
        isSilence: w.isSilence,
        correctedFrom: w.correctedFrom ?? null,
      },
    });
  }

  while (nextToken < tokens.length) pushToken(tokens[nextToken++]);
  flush();

  // Label the paragraphs where the speaker changes.
  let labelled: number | null = null;
  return {
    type:    'doc',
    content: paragraphs.map(({ content, speaker }) => {
      const label = speakers && speaker !== null && speaker !== labelled;
      if (label) labelled = speaker;
      return label
        ? { type: 'paragraph', attrs: { speaker: speakers.names[speaker] ?? `Speaker ${speaker + 1}`, speakerIndex: speaker }, content }
        : { type: 'paragraph', content };
    }),
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

/** A right-click on transcript words (or a token): what and where the menu goes. */
export interface TranscriptContextEvent {
  wordIndices: number[];
  /** Set when the target is an added pause (its edit's id). */
  pauseId?:    string;
  clientX:     number;
  clientY:     number;
}

interface TranscriptEditorProps {
  words:              EnrichedWord[];
  activeWordId:       string | null;
  onWordClick?:       (attrs: { id: string; startMs: number; endMs: number; text: string }) => void;
  onSelectionChange?: (range: { startMs: number; endMs: number } | null) => void;
  onContextMenu?:     (e: TranscriptContextEvent) => void;
  /** Added pauses to show between the words. */
  tokens?:            TextToken[];
  /** Who says each word: turns start paragraphs, labelled with the name. */
  speakers?:          SpeakerLabels | null;
}

export function TranscriptEditor({ words, activeWordId, onWordClick, onSelectionChange, onContextMenu, tokens, speakers = null }: TranscriptEditorProps) {
  // Refs keep callbacks and data fresh inside the one-time useEditor closure
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onContextMenuRef     = useRef(onContextMenu);
  const wordsRef             = useRef(words);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onContextMenuRef.current = onContextMenu; }, [onContextMenu]);
  useEffect(() => { wordsRef.current = words; }, [words]);

  // When the user clicks a word (mousedown on a word span), ProseMirror places
  // a collapsed cursor *before* handleClickOn fires, triggering onSelectionUpdate
  // with an empty selection and calling cb(null).  This would clear the selection
  // that handleClickOn/onWordClick is about to set.  We suppress that one cb(null)
  // call using this flag so the word click lands cleanly as a selection.
  const suppressNextClear = useRef(false);

  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({
        bold:           false,
        italic:         false,
        strike:         false,
        code:           false,
        codeBlock:      false,
        blockquote:     false,
        horizontalRule: false,
        heading:        false,
        bulletList:     false,
        orderedList:    false,
        listItem:       false,
      }),
      WordExtension,
      SpeakerTurns,
    ],
    content: buildDocument(words, tokens, speakers),

    // ── Use ProseMirror's internal selection (bypasses contenteditable DOM quirks)
    onSelectionUpdate({ editor: ed }) {
      const cb = onSelectionChangeRef.current;
      if (!cb) return;

      const sel = ed.state.selection;

      // Only act on text drags (TextSelection with a real span).
      // A collapsed selection fires when ProseMirror processes a mousedown —
      // but if a word click is in progress we want handleClickOn to own the
      // selection update, so we skip one cb(null) here.
      if (!(sel instanceof TextSelection) || sel.from === sel.to) {
        if (suppressNextClear.current) {
          suppressNextClear.current = false;
          return;
        }
        cb(null);
        return;
      }

      const ws = wordsRef.current;
      let startMs = Infinity, endMs = -Infinity, found = false;
      ed.state.doc.nodesBetween(sel.from, sel.to, (node) => {
        if (node.type.name === 'word') {
          startMs = Math.min(startMs, node.attrs.startMs as number);
          endMs   = Math.max(endMs, node.attrs.endMs as number);
          found   = true;
        }
        return true; // keep descending
      });

      // Require at least 1 word found; ignore accidental empty ranges
      if (found && ws.length > 0) {
        cb({ startMs, endMs });
      } else {
        cb(null);
      }
    },

    editorProps: {
      // Intercept Backspace/Delete so ProseMirror doesn't modify the document
      // directly (e.g. via its own deleteSelection command). The event still
      // bubbles to window where EditorPage's keyboard handler picks it up via
      // the EditActions system. Returning true calls e.preventDefault() inside
      // ProseMirror but does NOT call e.stopPropagation(), so window gets it.
      handleKeyDown(_view, e) {
        if (e.key === 'Backspace' || e.key === 'Delete') return true;
        return false;
      },

      // Detect word clicks on mousedown — before ProseMirror places its cursor
      // and triggers onSelectionUpdate with a collapsed selection.  Setting the
      // flag here lets onSelectionUpdate skip the cb(null) call so the word
      // click's selection (set by handleClickOn + onWordClick) lands cleanly.
      handleDOMEvents: {
        mousedown(_view, e) {
          const target = e.target as HTMLElement;
          if (e.button === 0 && target.closest('[data-word-id]')) {
            suppressNextClear.current = true;
          }
          return false; // let ProseMirror continue processing normally
        },
        // Right-click a word → show it in the timeline (EditorPage decides
        // whether that means the word or the selection around it).
        contextmenu(_view, e) {
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-word-id]');
          const cb = onContextMenuRef.current;
          if (!el || !cb) return false;
          e.preventDefault();
          const id = el.dataset.wordId ?? '';
          if (id.startsWith('p')) cb({ wordIndices: [], pauseId: id.slice(1), clientX: e.clientX, clientY: e.clientY });
          else cb({ wordIndices: [parseInt(id.slice(1), 10)], clientX: e.clientX, clientY: e.clientY });
          return true;
        },
      },

      handleClickOn(_view, _pos, node) {
        if (node.type.name === 'word' && onWordClick) {
          onWordClick({
            id:      node.attrs.id as string,
            startMs: node.attrs.startMs as number,
            endMs:   node.attrs.endMs as number,
            text:    node.attrs.text as string,
          });
          return true;
        }
        return false;
      },
    },
  });

  // Rebuild when the words, the added pauses or the speakers shown change
  const activeWordIdRef = useRef(activeWordId);
  activeWordIdRef.current = activeWordId;
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(buildDocument(words, tokens, speakers));
      // The rebuild drops the playing word's mark; put it back without scrolling.
      const id = activeWordIdRef.current;
      if (id) document.querySelector(`.wave-transcript-editor [data-word-id="${id}"]`)?.classList.add('wave-word--active');
    }
  }, [words, tokens, speakers, editor]);

  // ── DOM-based active-word highlight (no re-render, runs at word boundaries) ──
  useEffect(() => {
    const prev = document.querySelector('.wave-transcript-editor .wave-word--active');
    prev?.classList.remove('wave-word--active');

    if (activeWordId) {
      const el = document.querySelector<HTMLElement>(
        `.wave-transcript-editor [data-word-id="${activeWordId}"]`
      );
      if (el) {
        el.classList.add('wave-word--active');
        followWord(el);
      }
    }
  }, [activeWordId]);

  if (!editor) return null;

  return <EditorContent editor={editor} className="wave-transcript-editor" />;
}
