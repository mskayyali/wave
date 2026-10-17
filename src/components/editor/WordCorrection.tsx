import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TextInput } from '@carbon/react';

// Correcting a misheard word: a small field just under the word, in Flow or
// Segments. Enter or clicking away saves, Esc cancels. Typing what was
// transcribed takes the correction back off (EditorPage.correctWord).

const GAP    = 6;   // between the word and the field
const MARGIN = 8;   // from the window's edges

export function WordCorrection({ index, text, heard, onSave, onCancel }: {
  /** The word's index in enrichedWords (its element is `[data-word-id="w{index}"]`). */
  index:    number;
  /** The word as it reads now. */
  text:     string;
  /** What transcription heard (the same as `text` until it's corrected). */
  heard:    string;
  onSave:   (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(text);
  const [pos,   setPos]   = useState<{ left: number; top: number } | null>(null);
  const boxRef   = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Saving or cancelling closes the field, which blurs it: only the first counts.
  const doneRef  = useRef(false);

  // Bring the word into view (it may have been chosen on the waveform), then
  // follow it while the transcript scrolls.
  useLayoutEffect(() => {
    const word     = document.querySelector<HTMLElement>(`.wave-editor-scroll [data-word-id="w${index}"]`);
    const scroller = word?.closest<HTMLElement>('.wave-editor-scroll');
    if (!word || !scroller) return;
    const view = scroller.getBoundingClientRect();
    const top  = word.getBoundingClientRect().top - view.top;
    if (top < view.height * 0.1 || top > view.height * 0.7) scroller.scrollTop += top - view.height / 3;

    const place = () => {
      const r   = word.getBoundingClientRect();
      const box = boxRef.current?.getBoundingClientRect();
      const w   = box?.width ?? 240;
      const h   = box?.height ?? 72;
      const below = r.bottom + GAP + h <= window.innerHeight - MARGIN;
      setPos({
        left: Math.max(MARGIN, Math.min(r.left - 4, window.innerWidth - w - MARGIN)),
        top:  below ? r.bottom + GAP : r.top - GAP - h,
      });
    };
    place();
    // A second pass once the field has its real size.
    const raf = requestAnimationFrame(place);
    scroller.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
    };
  }, [index]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onSave(value);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <div
      ref={boxRef}
      className="wave-correct"
      role="dialog"
      aria-label="Correct word"
      // Unplaced, it's transparent rather than hidden, so the field can take focus.
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, opacity: 0 }}
    >
      <TextInput
        ref={inputRef}
        id="wave-correct-input"
        size="sm"
        labelText="Correct word"
        hideLabel
        autoComplete="off"
        spellCheck
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter')  { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        helperText={heard !== text ? `Heard as "${heard}" · ↩ save · Esc cancel` : '↩ save · Esc cancel'}
      />
    </div>
  );
}
