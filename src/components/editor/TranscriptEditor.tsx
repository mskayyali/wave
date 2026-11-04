import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Extension, Node as TiptapNode, mergeAttributes } from '@tiptap/core';
import { WordExtension } from './WordNode';
import type { EnrichedWord } from '../../hooks/useTranscript';
import { speakerColor, type SpeakerLabels } from '../../lib/speakers';
import { useWordAudioMarks, type WordAudioState } from '../../hooks/useWordAudioMarks';
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
        segmentStart: { default: null },
        segmentSilence: { default: false },
      },
    }];
  },
});

export function buildDocument(words: EnrichedWord[], tokens: TextToken[] = [], speakers: SpeakerLabels | null = null, layout: 'flow' | 'segments' = 'flow') {
  if (words.length === 0) {
    return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }

  // Each paragraph remembers its speaker (that of its first word).
  const paragraphs: { content: object[]; speaker: number | null; start: number | null; silence: boolean }[] = [];
  let current: object[] = [];
  let currentStart: number | null = null;
  let currentSilence = false;
  let wordCount = 0;
  let currentSpeaker: number | null = null;
  let lastSpeaker: number | null = null;
  const flush = () => {
    if (current.length > 0) paragraphs.push({ content: current, speaker: currentSpeaker, start: currentStart, silence: currentSilence });
    current = [];
    currentStart = null; currentSilence = false; wordCount = 0;
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
                          w.startMs - prev.endMs >= (layout === 'segments' ? 800 : PARA_GAP_MS);
    // A new speaker takes the floor: their turn starts a paragraph.
    const speaker   = speakers?.of[i] ?? null;
    const turnBreak = !w.isSilence && speaker !== null && lastSpeaker !== null && speaker !== lastSpeaker;

    if (i > 0 && (w.isSilence || prevIsSilence || gapBreak || turnBreak || (layout === 'segments' && wordCount >= 12))) flush();
    if (current.length === 0) { currentSpeaker = w.isSilence ? null : speaker; currentStart = w.startMs; currentSilence = w.isSilence; }
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
    wordCount++;
  }

  while (nextToken < tokens.length) pushToken(tokens[nextToken++]);
  flush();

  // Label the paragraphs where the speaker changes.
  let labelled: number | null = null;
  return {
    type:    'doc',
    content: paragraphs.map(({ content, speaker, start, silence }) => {
      const label = speakers && speaker !== null && speaker !== labelled;
      if (label) labelled = speaker;
      return { type: 'paragraph', attrs: {
        segmentStart: start, segmentSilence: silence,
        ...(label ? { speaker: speakers.names[speaker] ?? `Speaker ${speaker + 1}`, speakerIndex: speaker } : {}),
      }, content };
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

export interface TranscriptEditorProps {
  layout?: 'flow' | 'segments';
  selectionRange?: { startMs: number; endMs: number } | null;
  selectedWordIndices?: number[] | null;
  referenceIndices?: number[] | null;
  audioState: WordAudioState;
  following: boolean;
  words:              EnrichedWord[];
  activeWordId:       string | null;
  onWordClick?:       (attrs: { id: string; startMs: number; endMs: number; text: string }) => void;
  onSelectionChange?: (range: { startMs: number; endMs: number; wordIndices?: number[] } | null) => void;
  onContextMenu?:     (e: TranscriptContextEvent) => void;
  /** Added pauses to show between the words. */
  tokens?:            TextToken[];
  /** Who says each word: turns start paragraphs, labelled with the name. */
  speakers?:          SpeakerLabels | null;
}

export function TranscriptEditor({ words, activeWordId, onWordClick, onSelectionChange, onContextMenu, tokens, speakers = null, audioState, following, layout = 'flow', selectionRange, selectedWordIndices, referenceIndices }: TranscriptEditorProps) {
  // Refs keep callbacks and data fresh inside the one-time useEditor closure
  const rebuilding = useRef(false);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onContextMenuRef     = useRef(onContextMenu);
  const wordsRef             = useRef(words);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onContextMenuRef.current = onContextMenu; }, [onContextMenu]);
  useEffect(() => { wordsRef.current = words; }, [words]);

  // When the user clicks a word (mousedown on a word span), ProseMirror places
  // a collapsed cursor *before* handleClickOn fires, triggering onSelectionUpdate
  // with an empty selection and calling cb(null).  This would clear the selection
  // that handleClickOn/onWordClick is about to set.  Keep the word selection until another text gesture starts, including
  // repeated clicks where ProseMirror leaves its cursor unchanged.
  const suppressNextClear = useRef(false);

  const SegmentParagraph = TiptapNode.create({
    name: 'paragraph', group: 'block', content: 'inline*',
    parseHTML() { return [{ tag: 'p' }]; },
    renderHTML({ HTMLAttributes }) { return ['p', mergeAttributes(HTMLAttributes), 0]; },
    addNodeView() { return ({ node, view, getPos }) => {
          let current = node;
          const dom = document.createElement('div'); dom.className = 'wave-segment';
          const time = document.createElement('button');
          time.type = 'button'; time.className = 'wave-segment__ts'; time.contentEditable = 'false';
          const body = document.createElement('div'); body.className = 'wave-segment__text';
          const name = document.createElement('span'); name.className = 'wave-segment__speaker'; name.contentEditable = 'false';
          const contentDOM = document.createElement('span');
          body.append(name, contentDOM); dom.append(time, body);
          const refresh = () => {
            const seconds = Math.floor((current.attrs.segmentStart ?? 0) / 1000);
            const minutes = Math.floor(seconds / 60);
            const stamp = minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
            time.textContent = stamp; time.hidden = current.attrs.segmentSilence || current.attrs.segmentStart === null;
            time.setAttribute('aria-label', `Select segment at ${stamp}`);
            time.title = 'Select this segment · right-click for editing options';
            name.textContent = current.attrs.speaker ?? ''; name.style.display = current.attrs.speaker ? '' : 'none';
            if (current.attrs.speakerIndex !== null) name.style.setProperty('--speaker-color', speakerColor(current.attrs.speakerIndex));
            dom.classList.toggle('wave-segment--silence', !!current.attrs.segmentSilence);
          };
          refresh();
          time.onmousedown = event => event.preventDefault();
          time.onclick = () => {
            const position = getPos();
            if (position === undefined) return;
            suppressNextClear.current = true;
            const selection = TextSelection.create(view.state.doc, position + 1, position + current.nodeSize - 1);
            const unchanged = selection.eq(view.state.selection);
            view.dispatch(view.state.tr.setSelection(selection));
            if (unchanged) {
              const wordIndices: number[] = [];
              let startMs = Infinity, endMs = -Infinity;
              current.descendants(child => {
                if (child.type.name !== 'word' || !String(child.attrs.id).startsWith('w')) return;
                wordIndices.push(Number(String(child.attrs.id).slice(1)));
                startMs = Math.min(startMs, child.attrs.startMs); endMs = Math.max(endMs, child.attrs.endMs);
              });
              if (wordIndices.length) onSelectionChangeRef.current?.({ startMs, endMs, wordIndices });
            }
            view.focus();
          };
          time.oncontextmenu = event => {
            event.preventDefault();
            const wordIndices: number[] = [];
            current.descendants(child => { if (child.type.name === 'word' && String(child.attrs.id).startsWith('w')) wordIndices.push(Number(String(child.attrs.id).slice(1))); });
            onContextMenuRef.current?.({ wordIndices, clientX: event.clientX, clientY: event.clientY });
          };
          return { dom, contentDOM, stopEvent: event => event.target instanceof globalThis.Node && time.contains(event.target),
            update(next) { if (next.type !== current.type) return false; current = next; refresh(); return true; } };

    }; },
  });

  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({
        paragraph: layout === 'segments' ? false : {},
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
      ...(layout === 'segments' ? [SegmentParagraph] : []),
      WordExtension,
      SpeakerTurns,
    ],
    content: buildDocument(words, tokens, speakers, layout),

    // ── Use ProseMirror's internal selection (bypasses contenteditable DOM quirks)
    onSelectionUpdate({ editor: ed }) {
      if (rebuilding.current) return;
      const cb = onSelectionChangeRef.current;
      if (!cb) return;

      const sel = ed.state.selection;

      // Only act on text drags (TextSelection with a real span).
      // A collapsed selection fires when ProseMirror processes a mousedown —
      // but if a word click is in progress we want handleClickOn to own the
      // selection update, so we keep the word click as the active selection.
      if (!(sel instanceof TextSelection) || sel.from === sel.to) {
        if (suppressNextClear.current) {
          return;
        }
        cb(null);
        return;
      }

      const ws = wordsRef.current;
      let startMs = Infinity, endMs = -Infinity, found = false;
      const wordIndices: number[] = [];
      ed.state.doc.nodesBetween(sel.from, sel.to, (node) => {
        if (node.type.name === 'word' && String(node.attrs.id).startsWith('w')) {
          wordIndices.push(Number(String(node.attrs.id).slice(1)));
          startMs = Math.min(startMs, node.attrs.startMs as number);
          endMs   = Math.max(endMs, node.attrs.endMs as number);
          found   = true;
        }
        return true; // keep descending
      });

      // Require at least 1 word found; ignore accidental empty ranges
      if (found && ws.length > 0) {
        cb({ startMs, endMs, wordIndices });
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
        const pill = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-word-id^="p"]') : null;
        if (pill && (e.key === 'Enter' || e.key === ' ')) {
          const box = pill.getBoundingClientRect();
          onContextMenuRef.current?.({ wordIndices: [], pauseId: pill.dataset.wordId!.slice(1), clientX: box.left, clientY: box.bottom });
          return true;
        }
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
          if (e.button === 0) suppressNextClear.current = !!target.closest('[data-word-id]');
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


    },
  });

  // Rebuild when the words, the added pauses or the speakers shown change
  const activeWordIdRef = useRef(activeWordId);
  activeWordIdRef.current = activeWordId;
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      rebuilding.current = true;
      try { editor.commands.setContent(buildDocument(words, tokens, speakers, layout)); }
      finally { rebuilding.current = false; }
      // The rebuild drops the playing word's mark; put it back without scrolling.
      const id = activeWordIdRef.current;
      if (id) document.querySelector(`.wave-transcript-editor [data-word-id="${id}"]`)?.classList.add('wave-word--active');
    }
  }, [words, tokens, speakers, editor, layout]);

  useWordAudioMarks(audioState, [words, tokens, speakers, editor]);

  // Apply state after this editor's document exists, including view switches
  // and rebuilds for corrected words, speaker labels and inserted pauses.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const selected = selectedWordIndices ? new Set(selectedWordIndices) : null;
    const reference = new Set(referenceIndices ?? []);
    editor.view.dom.querySelectorAll<HTMLElement>('[data-word-id^="w"]').forEach(el => {
      const index = Number(el.dataset.wordId?.slice(1)), word = words[index];
      const touched = !!word && !!selectionRange && word.endMs > selectionRange.startMs && word.startMs < selectionRange.endMs;
      const whole = touched && word.startMs >= selectionRange!.startMs - 1 && word.endMs <= selectionRange!.endMs + 1;
      el.classList.toggle('wave-word--selected', selected ? selected.has(index) : whole);
      el.classList.toggle('wave-word--selected-part', !selected && touched && !whole);
      el.classList.toggle('wave-word--reference', reference.has(index));
    });
  }, [selectionRange, selectedWordIndices, referenceIndices, words, tokens, speakers, editor]);

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
        if (following) followWord(el);
      }
    }
  }, [activeWordId, following, editor]);

  if (!editor) return null;

  return <EditorContent editor={editor} className={`wave-transcript-editor${layout === 'segments' ? ' wave-segments' : ''}`} onClick={event => {
    if (!(event.target instanceof Element) || !(window.getSelection()?.isCollapsed ?? true)) return;
    const el = event.target.closest<HTMLElement>('[data-word-id]');
    if (!el) return;
    const id = el.dataset.wordId ?? '';
    if (id.startsWith('w')) {
      const word = words[Number(id.slice(1))];
      if (word) onWordClick?.({ id, ...word });
    } else {
      const token = tokens?.find(token => token.id === id);
      if (token) { const box = el.getBoundingClientRect(); onContextMenu?.({ wordIndices: [], pauseId: id.slice(1), clientX: box.left, clientY: box.bottom }); }
    }
  }} />;
}
