import { useEffect } from 'react';
import { Menu, MenuItem, MenuItemDivider } from '@carbon/react';

// Right-click menu shared by the transcript and the waveform. Like any context
// menu, opening it changes nothing; every effect is an item. The first line
// names what it acts on, so nothing needs highlighting to show that.
//
//  • words — transcript words (one, a selection, or a segment)
//  • cut   — an existing cut on the waveform
//  • range — waveform audio that isn't exactly whole words (a pause, a
//            breath, a drawn selection): cut exactly as it is
//  • pause — a pause added by hand

export type ContextMenuKind = 'words' | 'cut' | 'range' | 'pause';

export interface WordContextMenuState {
  kind:        ContextMenuKind;
  /** Where it was opened: decides "Show in timeline" vs "Show in transcript". */
  source:      'transcript' | 'timeline';
  x:           number;
  y:           number;
  startMs:     number;
  endMs:       number;
  /** The words it covers (for words) or touches (for cuts and ranges). */
  wordIndices: number[];
  /** What it is: `"so"`, "12 words", "Cut", "Selection", "Pause". */
  title:       string;
  /** Every word in it is already cut. */
  allDeleted:  boolean;
  /** The one speaker who says these words, when speakers are detected. */
  speaker?:    { id: number; name: string };
  /** Opened on a single word (not a pause): it can be corrected. */
  word?:       { correctedFrom?: string };
  /** Opened on an added pause (its edit's id). */
  pauseId?:    string;
}

export interface WordContextMenuActions {
  onClose:            () => void;
  onPlay:             () => void;
  onPlayOriginal:     () => void;
  onPlayFrom:         () => void;
  onPreviewCut:       () => void;
  onSelect:           () => void;
  onZoom:             () => void;
  onShowInTimeline:   () => void;
  onShowInTranscript: () => void;
  onDelete:           () => void;
  onRestore:          () => void;
  onClearHighlight:   () => void;
  /** Select everything `menu.speaker` said. */
  onSelectSpeaker:    () => void;
  /** Type the right text for a misheard word. */
  onCorrect:          () => void;
  /** Back to what transcription heard. */
  onRevertCorrection: () => void;
  /** Add a pause of `ms` after the words. */
  onAddPause:         (ms: number) => void;
  /** Take an added pause back out. */
  onRemovePause:      () => void;
}

/** What "Add pause after" offers. */
const PAUSE_LENGTHS = [250, 500, 1000, 2000];

/** "4:31.220" */
function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
}

/** "84 ms", "1.25 s" */
function fmtLength(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function WordContextMenu({ menu, hasHighlight, ...a }: {
  menu: WordContextMenuState | null;
  /** A passage is marked; offer to clear it. */
  hasHighlight: boolean;
} & WordContextMenuActions) {
  // Carbon's Menu closes only when focus moves to something focusable, and
  // the transcript text and the waveform aren't. Like a native menu, close it
  // on any press, wheel or app switch outside it. (A right-click elsewhere
  // closes this one before its own contextmenu event opens the next.)
  const open    = menu !== null;
  const onClose = a.onClose;
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest('.wave-word-menu')) onClose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', outside, { capture: true, passive: true });
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', outside, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose]);

  const kind     = menu?.kind ?? 'words';
  const fromWave = menu?.source === 'timeline';
  const hasWords = (menu?.wordIndices.length ?? 0) > 0;
  const header   = !menu ? ''
    : kind === 'pause' ? `${menu.title}\nat ${fmtClock(menu.startMs)}`
    : `${menu.title}\n${fmtClock(menu.startMs)}–${fmtClock(menu.endMs)} (${fmtLength(menu.endMs - menu.startMs)})`;

  const show = fromWave
    ? hasWords && <MenuItem key="show" label="Show in transcript" onClick={a.onShowInTranscript} />
    : <MenuItem key="show" label="Show in timeline" onClick={a.onShowInTimeline} />;
  const zoom = <MenuItem key="zoom" label="Zoom to it" shortcut="Z" onClick={a.onZoom} />;
  const clear = hasHighlight && [
    <MenuItemDivider key="dc" />,
    <MenuItem key="clear" label="Clear highlight" shortcut="Esc" onClick={a.onClearHighlight} />,
  ];

  const addPause = !menu?.allDeleted && (
    <MenuItem key="pause" label="Add pause after">
      {PAUSE_LENGTHS.map((ms) => (
        <MenuItem key={ms} label={`${ms / 1000} s`} onClick={() => a.onAddPause(ms)} />
      ))}
    </MenuItem>
  );

  const items = kind === 'pause' ? [
    <MenuItem key="from"   label="Play from here" onClick={a.onPlayFrom} />,
    <MenuItemDivider key="d1" />,
    <MenuItem key="remove" label="Take out this pause" kind="danger" onClick={a.onRemovePause} />,
  ] : kind === 'cut' ? [
    <MenuItem key="preview" label="Preview edit" shortcut="C" onClick={a.onPreviewCut} />,
    <MenuItem key="orig"    label="Play what was cut" onClick={a.onPlayOriginal} />,
    <MenuItemDivider key="d1" />,
    show,
    zoom,
    <MenuItemDivider key="d2" />,
    <MenuItem key="restore" label="Restore cut" onClick={a.onRestore} />,
  ] : kind === 'range' ? [
    <MenuItem key="play"    label="Play" onClick={a.onPlay} />,
    <MenuItem key="preview" label="Preview cut" shortcut="C" onClick={a.onPreviewCut} />,
    <MenuItemDivider key="d1" />,
    <MenuItem key="select"  label="Select" onClick={a.onSelect} />,
    show,
    zoom,
    <MenuItemDivider key="d2" />,
    <MenuItem key="cut"     label="Cut exactly this" kind="danger" shortcut="⌫" onClick={a.onDelete} />,
  ] : [
    menu?.allDeleted
      ? <MenuItem key="orig" label="Play original" onClick={a.onPlayOriginal} />
      : <MenuItem key="play" label="Play" onClick={a.onPlay} />,
    <MenuItem key="from"    label="Play from here" onClick={a.onPlayFrom} />,
    !menu?.allDeleted && <MenuItem key="preview" label="Preview cut" shortcut="C" onClick={a.onPreviewCut} />,
    <MenuItemDivider key="d1" />,
    <MenuItem key="select"  label="Select" onClick={a.onSelect} />,
    menu?.speaker && <MenuItem key="speaker" label={`Select everything ${menu.speaker.name} said`} onClick={a.onSelectSpeaker} />,
    show,
    zoom,
    menu?.word && <MenuItemDivider key="dw" />,
    menu?.word && <MenuItem key="correct" label="Correct word…" shortcut="↩" onClick={a.onCorrect} />,
    menu?.word?.correctedFrom !== undefined
      && <MenuItem key="uncorrect" label={`Back to "${menu.word.correctedFrom}"`} onClick={a.onRevertCorrection} />,
    !menu?.allDeleted && <MenuItemDivider key="dp" />,
    addPause,
    <MenuItemDivider key="d2" />,
    menu?.allDeleted
      ? <MenuItem key="restore" label="Restore" onClick={a.onRestore} />
      : <MenuItem key="delete"  label="Delete" kind="danger" shortcut="⌫" onClick={a.onDelete} />,
  ];

  return (
    <Menu
      // Carbon places a menu only as it opens: a new key for each right-click
      // opens a fresh one at the pointer instead of moving the old contents.
      key={menu ? `${menu.x},${menu.y},${menu.startMs},${menu.kind}` : 'closed'}
      open={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={a.onClose}
      label={menu ? `Actions for ${menu.title}` : 'Actions'}
      size="sm"
      className="wave-word-menu"
    >
      <MenuItem key="header" label={header} disabled className="wave-word-menu__header" />
      <MenuItemDivider key="dh" />
      {items.filter(Boolean)}
      {clear}
    </Menu>
  );
}
