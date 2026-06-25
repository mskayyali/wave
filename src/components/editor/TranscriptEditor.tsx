import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { WordExtension } from './WordNode';
import type { EnrichedWord } from '../../hooks/useTranscript';

// ─── Document builder ─────────────────────────────────────────────────────────

// Gap ≥ this (ms) between real words → new paragraph.
// Silence entries (isSilence=true) always force their own paragraph so that
// the █ block appears as a standalone visual break rather than inline.
const PARA_GAP_MS = 1500;

function buildDocument(words: EnrichedWord[]) {
  if (words.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }

  const paragraphs: object[][] = [];
  let current: object[] = [];

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

    if (i > 0 && (w.isSilence || prevIsSilence || gapBreak)) {
      if (current.length > 0) paragraphs.push(current);
      current = [];
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
      },
    });
  }

  if (current.length > 0) paragraphs.push(current);

  return {
    type:    'doc',
    content: paragraphs.map((content) => ({ type: 'paragraph', content })),
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

interface TranscriptEditorProps {
  words:              EnrichedWord[];
  activeWordId:       string | null;
  onWordClick?:       (attrs: { id: string; startMs: number; endMs: number; text: string }) => void;
  onSelectionChange?: (range: { startMs: number; endMs: number } | null) => void;
}

export function TranscriptEditor({ words, activeWordId, onWordClick, onSelectionChange }: TranscriptEditorProps) {
  // Refs keep callbacks and data fresh inside the one-time useEditor closure
  const onSelectionChangeRef = useRef(onSelectionChange);
  const wordsRef             = useRef(words);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
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
    ],
    content: buildDocument(words),

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
          if (target.closest('[data-word-id]')) {
            suppressNextClear.current = true;
          }
          return false; // let ProseMirror continue processing normally
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

  // Rebuild when words change
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(buildDocument(words));
    }
  }, [words, editor]);

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
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [activeWordId]);

  if (!editor) return null;

  return <EditorContent editor={editor} className="wave-transcript-editor" />;
}
