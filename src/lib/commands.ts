import { listen } from '@tauri-apps/api/event';

// Commands from the menu bar (src-tauri/src/menu.rs sends each item's id as
// a `menu` event). A screen registers what it does with a command while it's
// showing; the most recently registered handler runs first, and returning
// false passes the command on (the editor takes Find; the shell takes the rest).

export type Command =
  | 'about' | 'check-updates' | 'new-project' | 'settings' | 'back' | 'shortcuts'
  | 'undo' | 'redo' | 'find' | 'find-next' | 'find-previous'
  | 'view-flow' | 'view-segments';

type Handler = () => boolean | void;

const handlers: { command: Command; run: Handler }[] = [];

/** Handle a command while mounted; returns the unregister function. */
export function onCommand(command: Command, run: Handler): () => void {
  const entry = { command, run };
  handlers.push(entry);
  return () => {
    const i = handlers.indexOf(entry);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export function runCommand(command: Command): void {
  for (let i = handlers.length - 1; i >= 0; i--) {
    const h = handlers[i];
    if (h.command === command && h.run() !== false) return;
  }
}

/** True when a text field has the keyboard (its own undo, copy… apply). */
export function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    || (el instanceof HTMLElement && el.isContentEditable);
}

/** Feed menu commands into runCommand. Called once, by App. */
export function listenForMenu(): () => void {
  const unlisten = listen<string>('menu', ({ payload }) => runCommand(payload as Command));
  return () => { void unlisten.then((fn) => fn()); };
}
