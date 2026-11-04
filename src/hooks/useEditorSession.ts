import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { parseEditorSession, type EditorSession, type EditorSelection } from '../lib/editorSession';
import type { useWaveform } from './useWaveform';

interface Options {
  projectId: string; fingerprint: string | null; ready: boolean;
  waveform: ReturnType<typeof useWaveform>;
  wordSelection: EditorSession['wordSelection'];
  selection: EditorSelection | null; viewMode: 'flow' | 'segments'; panelHeight: number;
  restore: (session: EditorSession) => void;
}
/** Position is local per project; restore only after edits and audio have loaded. */
export function useEditorSession(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const restored = useRef(false);
  const saveNow = useRef<() => void>(() => undefined);
  const raf = useRef(0);
  useEffect(() => {
    if (restored.current || !options.ready || !options.waveform.audioReady) return;
    let session: EditorSession | null = null;
    try { session = parseEditorSession(localStorage.getItem(`wave.session.${options.projectId}`), options.waveform.durationMs, options.fingerprint); }
    catch { /* Storage may be disabled. */ }
    if (!session) { restored.current = true; return; }
    options.restore(session);
    // Wait for view mode and panel layout before restoring time-based geometry.
    raf.current = requestAnimationFrame(() => {
      raf.current = requestAnimationFrame(() => {
        const { waveform } = latest.current;
        waveform.showWindow(session!.centerMs, session!.spanMs);
        waveform.seek(session!.playheadMs);
        const scroll = document.querySelector<HTMLElement>('.wave-editor-scroll');
        const anchor = session!.textAnchor;
        const word = anchor && scroll?.querySelector<HTMLElement>(`[data-word-id="w${anchor.word}"]`);
        if (scroll && word && anchor) scroll.scrollTop += word.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
        document.querySelector<HTMLElement>(session!.pane === 'audio' ? '.wave-timeline' : '.wave-editor-scroll')?.focus({ preventScroll: true });
        restored.current = true;
      });
    });
    return () => cancelAnimationFrame(raf.current);
  }, [options.ready, options.waveform.audioReady, options.waveform.durationMs, options.fingerprint]);

  useEffect(() => {
    let pane: 'text' | 'audio' = 'text';
    const track = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.wave-timeline')) pane = 'audio';
      else if (event.target.closest('.wave-editor-scroll')) pane = 'text';
    };
    const save = () => {
      const o = latest.current;
      if (!restored.current || !o.ready || !o.waveform.audioReady) return;
      const view = o.waveform.getView();
      if (!view) return;
      const scroll = document.querySelector<HTMLElement>('.wave-editor-scroll');
      let textAnchor: EditorSession['textAnchor'] = null;
      if (scroll) {
        const top = scroll.getBoundingClientRect().top;
        for (const word of scroll.querySelectorAll<HTMLElement>('[data-word-id]')) {
          if (!word.dataset.wordId?.startsWith('w')) continue;
          const box = word.getBoundingClientRect();
          if (box.bottom <= top) continue;
          const index = Number(word.dataset.wordId?.slice(1));
          if (Number.isInteger(index)) textAnchor = { word: index, offset: box.top - top };
          break;
        }
      }
      const session: EditorSession = {
        version: 1, fingerprint: o.fingerprint, playheadMs: o.waveform.currentMs,
        selection: o.selection, wordSelection: o.wordSelection, viewMode: o.viewMode, panelHeight: o.panelHeight, pane, following: o.waveform.following,
        centerMs: (view.startMs + view.endMs) / 2, spanMs: view.endMs - view.startMs, textAnchor,
      };
      try { localStorage.setItem(`wave.session.${o.projectId}`, JSON.stringify(session)); }
      catch (e) { console.warn('Could not save editing position:', e); }
    };
    saveNow.current = save;
    const interval = setInterval(save, 750);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    document.addEventListener('focusin', track);
    document.addEventListener('pointerdown', track);
    let closed = false;
    let unlisten: (() => void) | undefined;
    try { getCurrentWindow().onCloseRequested(save).then(off => { if (closed) off(); else unlisten = off; }).catch(() => undefined); }
    catch { /* Browser preview. */ }
    return () => {
      closed = true; save(); clearInterval(interval); cancelAnimationFrame(raf.current); unlisten?.();
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', save);
      document.removeEventListener('focusin', track);
      document.removeEventListener('pointerdown', track);
    };
  }, [options.projectId]);
  return () => saveNow.current();
}
