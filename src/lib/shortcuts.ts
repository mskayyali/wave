// Every keyboard and pointer shortcut in the editor, for the shortcuts sheet
// (? or the keyboard button in the top bar). Keep in sync with the keydown
// handler in EditorPage, the menu bar (src-tauri/src/menu.rs) and the
// waveform's pointer handling in useWaveform.

export interface Shortcut {
  /** Alternatives, each one key combination as displayed (e.g. `⇧Z`, `⌘0`). */
  keys:  string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Playback',
    items: [
      { keys: ['Space'],        label: 'Play or pause' },
      { keys: ['←', '→'],       label: 'Back or forward 5 seconds' },
      { keys: ['J', 'L'],       label: 'Slower or faster' },
      { keys: ['C'],            label: 'Hear the selection as if it were cut' },
      { keys: ['Tab', '⇧Tab'],  label: 'Next or previous cut' },
    ],
  },
  {
    title: 'General',
    items: [
      { keys: ['⌫'],         label: 'Delete the selection' },
      { keys: ['↩'],         label: 'Correct the selected word' },
      { keys: ['⌘Z', '⇧⌘Z'], label: 'Undo or redo' },
      { keys: ['⌘F'],        label: 'Find in the transcript' },
      { keys: ['⌘G', '⇧⌘G'], label: 'Next or previous match' },
      { keys: ['Esc'],       label: 'Clear the selection' },
      { keys: ['?', '⌘/'],   label: 'Show keyboard shortcuts' },
    ],
  },
  {
    title: 'Selecting words',
    items: [
      { keys: ['[', ']'],      label: 'Previous or next word' },
      { keys: ['{', '}'],      label: 'Add the previous or next word' },
      { keys: ['Double-click'], label: 'Select a word or pause on the waveform' },
    ],
  },
  {
    title: 'Wave',
    items: [
      { keys: ['⌘N'],       label: 'New project' },
      { keys: ['⌘1', '⌘2'], label: 'Flow or Segments view' },
      { keys: ['⌘['],       label: 'Back to projects' },
      { keys: ['⌘,'],       label: 'Settings' },
    ],
  },
  {
    title: 'Fine-tuning a selection',
    items: [
      { keys: ['⇧←', '⇧→'],   label: 'Move the end 10 ms (with ⌘, 1 ms)' },
      { keys: ['⌥⇧←', '⌥⇧→'], label: 'Move the start 10 ms (with ⌘, 1 ms)' },
      { keys: ['⌥ drag'],      label: 'Ignore Snap to words while dragging' },
    ],
  },
  {
    title: 'Timeline',
    items: [
      { keys: ['+', '−'],         label: 'Zoom in or out at the pointer' },
      { keys: ['Z'],              label: 'Zoom to the selection, again to go back' },
      { keys: ['⇧Z', '⌘0'],       label: 'Show the whole file' },
      { keys: ['Pinch', '⌃ scroll'], label: 'Zoom at the pointer' },
      { keys: ['Swipe'],          label: 'Scroll the timeline' },
    ],
  },
];
