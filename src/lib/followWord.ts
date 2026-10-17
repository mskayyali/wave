/**
 * Keep the playing word in view a page at a time, as the waveform does: no
 * scrolling while it stays in the middle of the view, then one move that puts
 * it a third of the way down. Scrolling a little at every new line (what
 * `scrollIntoView({ block: 'nearest' })` does) makes the text jitter.
 */
export function followWord(el: HTMLElement): void {
  const container = el.closest<HTMLElement>('.wave-editor-scroll');
  if (!container) {
    el.scrollIntoView({ block: 'nearest' });
    return;
  }
  const view = container.getBoundingClientRect();
  const word = el.getBoundingClientRect();
  const top    = word.top - view.top;
  const bottom = word.bottom - view.top;
  if (top >= view.height * 0.1 && bottom <= view.height * 0.85) return;
  container.scrollTo({ top: container.scrollTop + top - view.height / 3, behavior: 'smooth' });
}
