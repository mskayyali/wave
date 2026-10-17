import { useEffect, useRef } from 'react';
import { IconButton, Search } from '@carbon/react';
import { ChevronDown, ChevronUp, Close, Cut } from '@carbon/icons-react';

// Find in the transcript (⌘F), above the text. ↩ and ⇧↩ (or ⌘G, ⇧⌘G) step
// through the matches, each selected in the text and the waveform; Cut
// removes the selected match and moves on. EditorPage owns the matching.

export function FindBar({ query, count, current, focusRequest, onQuery, onNext, onPrevious, onCut, onClose }: {
  query:        string;
  count:        number;
  /** The selected match (0-based), or -1. */
  current:      number;
  /** Bumped to put the cursor back in the field (⌘F while open). */
  focusRequest: number;
  onQuery:      (query: string) => void;
  onNext:       () => void;
  onPrevious:   () => void;
  onCut:        () => void;
  onClose:      () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const none = query.trim() !== '' && count === 0;
  return (
    <div className="wave-find" role="search">
      <Search
        ref={inputRef}
        id="wave-find-input"
        size="sm"
        labelText="Find in transcript"
        placeholder="Find in transcript"
        closeButtonLabelText="Clear"
        autoComplete="off"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) onPrevious(); else onNext(); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
      />
      <span className={`wave-find__count${none ? ' wave-find__count--none' : ''}`} aria-live="polite">
        {query.trim() === '' ? '' : none ? 'No matches' : `${current + 1} of ${count}`}
      </span>
      <IconButton kind="ghost" size="sm" label="Previous (⇧↩)" align="bottom" disabled={count === 0} onClick={onPrevious}>
        <ChevronUp />
      </IconButton>
      <IconButton kind="ghost" size="sm" label="Next (↩)" align="bottom" disabled={count === 0} onClick={onNext}>
        <ChevronDown />
      </IconButton>
      <IconButton kind="ghost" size="sm" label="Cut this match" align="bottom" disabled={current < 0} onClick={onCut}>
        <Cut />
      </IconButton>
      <IconButton kind="ghost" size="sm" label="Close (Esc)" align="bottom-end" onClick={onClose}>
        <Close />
      </IconButton>
    </div>
  );
}
