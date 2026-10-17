import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import {
  Button, ContainedList, ContainedListItem, ContentSwitcher, IconButton, InlineNotification,
  RadioButton, RadioButtonGroup, Switch, Tab, TabList, TabPanel, TabPanels, Tabs, Tag,
} from '@carbon/react';
import { DocumentSet, Download, Export, Information, MagicWand, RecentlyViewed, Undo } from '@carbon/icons-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { toPlainText, toSRT, toVTT, toJSON } from '../../utils/exportFormats';
import { activity } from '../../lib/activity';
import { AUDIO_FORMATS, estimateMb, type AudioFormatId } from '../../lib/audioFormats';
import { formatLength } from '../../lib/time';
import type { Transcript, EnrichedWord } from '../../hooks/useTranscript';
import type { EditAction } from '../../pages/EditorPage';
import type { EnhanceToolProps } from './EnhancePanel';
import type { SpeakerToolProps } from './SpeakersPanel';
import type { PauseToolProps } from './PausesPanel';
import { ToolsTab, type ToolId } from './ToolsTab';
import type { InsertedPause } from '../../lib/editPlayer';

type TimeOp = { startMs: number; endMs: number };

// The editor's right-hand panel: Tools, Export, Edits and Details tabs. Its
// width is dragged from the left edge (or ←/→ on the focused edge) and saved.

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** "English" for "en"; the code itself if there's no name for it. */
function languageName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}

function avgConfidence(words: Transcript['words']): number {
  if (words.length === 0) return 0;
  return words.reduce((acc, w) => acc + w.confidence, 0) / words.length;
}

/** A list row with a title and a line of helper text. */
function ItemText({ title, helper }: { title: string; helper?: string }) {
  return (
    <span className="wave-list-text">
      <span className="wave-list-text__title">{title}</span>
      {helper && <span className="wave-list-text__helper">{helper}</span>}
    </span>
  );
}

// ─── Width ────────────────────────────────────────────────────────────────────

const WIDTH_KEY     = 'wave.inspectorWidth';
const MIN_WIDTH     = 300;
const DEFAULT_WIDTH = 320;
const MAX_WIDTH     = 480;
/** The transcript keeps at least this much of the window. */
const MIN_TRANSCRIPT_WIDTH = 480;
const KEY_STEP = 16;

function clampWidth(width: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - MIN_TRANSCRIPT_WIDTH));
  return Math.round(Math.max(MIN_WIDTH, Math.min(max, width)));
}

/** The panel's width, and props for the drag handle on its left edge. */
function usePanelWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return saved ? clampWidth(saved) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const stopDrag = useRef<() => void>(() => {});

  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* storage unavailable */ }
  }, [width]);

  // Stay within bounds when the window gets narrower; end a drag on unmount.
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      stopDrag.current();
    };
  }, []);

  const handleProps: HTMLAttributes<HTMLDivElement> = {
    role:               'separator',
    tabIndex:           0,
    title:              'Drag to resize · double-click to reset',
    'aria-label':       'Resize the panel',
    'aria-orientation': 'vertical',
    'aria-valuemin':    MIN_WIDTH,
    'aria-valuemax':    MAX_WIDTH,
    'aria-valuenow':    width,
    // Followed on the window, so the pointer can leave the thin handle.
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startWidth = width;
      const onMove = (ev: PointerEvent) => setWidth(clampWidth(startWidth + startX - ev.clientX));
      const onUp = () => stopDrag.current();
      stopDrag.current = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('wave-resizing-x');
        stopDrag.current = () => {};
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      document.body.classList.add('wave-resizing-x');
    },
    onDoubleClick: () => setWidth(clampWidth(DEFAULT_WIDTH)),
    onKeyDown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // Not a seek: keep the editor's shortcuts from seeing it.
      e.preventDefault();
      e.stopPropagation();
      setWidth((w) => clampWidth(w + (e.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP)));
    },
  };
  return { width, handleProps };
}

// ─── Export tab ───────────────────────────────────────────────────────────────

/** An added pause as export_audio takes it. */
export function insertOp(p: InsertedPause) {
  return { atMs: p.atMs, ms: p.ms, toneStartMs: p.tone?.startMs ?? null, toneEndMs: p.tone?.endMs ?? null };
}

interface ExportTabProps {
  transcript:    Transcript;
  projectName:   string;
  projectId:     string;
  filteredWords: (EnrichedWord & { speaker?: string })[];  // non-deleted, non-silence words for export
  currentOps:    TimeOp[];          // merged cut ranges (for audio splice)
  /** Pauses added by hand (room tone, spliced in). */
  addedPauses:   InsertedPause[];
  /** Speech enhancement is on: export the enhanced audio. */
  enhanced:      boolean;
}

const EXPORT_FORMAT_KEY = 'wave.exportFormat';
const EXPORT_PRESETS_KEY = 'wave.exportPresets';

/** The audio format and preset to export with: the last ones chosen (a preset
 *  per format), else MP3 at the podcast standard. */
function useAudioChoice() {
  const [formatId, setFormatId] = useState<AudioFormatId>(() => {
    try {
      const saved = localStorage.getItem(EXPORT_FORMAT_KEY);
      if (AUDIO_FORMATS.some((f) => f.id === saved)) return saved as AudioFormatId;
    } catch { /* storage unavailable */ }
    return 'mp3';
  });
  const [chosen, setChosen] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(EXPORT_PRESETS_KEY) ?? '{}') ?? {}; } catch { return {}; }
  });
  const format = AUDIO_FORMATS.find((f) => f.id === formatId) ?? AUDIO_FORMATS[0];
  const preset = format.presets.find((p) => p.id === chosen[format.id]) ?? format.presets.find((p) => p.id === format.standard)!;

  const pickFormat = (id: AudioFormatId) => {
    setFormatId(id);
    try { localStorage.setItem(EXPORT_FORMAT_KEY, id); } catch { /* not saved */ }
  };
  const pickPreset = (id: string) => {
    const next = { ...chosen, [format.id]: id };
    setChosen(next);
    try { localStorage.setItem(EXPORT_PRESETS_KEY, JSON.stringify(next)); } catch { /* not saved */ }
  };
  return { format, preset, pickFormat, pickPreset };
}

/** "about 42 MB", "about 6.3 MB". */
function aboutMb(mb: number): string {
  return `about ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function ExportTab({ transcript, projectName, projectId, filteredWords, currentOps, addedPauses, enhanced }: ExportTabProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const { format, preset, pickFormat, pickPreset } = useAudioChoice();

  async function handleTranscriptExport(format: string, ext: string, generate: () => string) {
    setBusy(ext);
    try {
      const path = await save({
        defaultPath: `${projectName}.${ext}`,
        filters: [{ name: format, extensions: [ext] }],
      });
      if (!path) return;
      await invoke('save_text_file', { path, content: generate() });
    } catch (e) {
      console.error('Export failed:', e);
    } finally {
      setBusy(null);
    }
  }

  async function handleAudioExport() {
    setBusy('audio');
    setAudioError(null);
    try {
      const path = await save({
        defaultPath: `${projectName}.${format.ext}`,
        filters: [{ name: `${format.name} audio`, extensions: [format.ext] }],
      });
      if (!path) return;
      await activity.track(
        { id: `export:${projectId}`, label: 'Exporting audio', doneLabel: `${format.name} exported`, projectId, quietMs: 500 },
        () => invoke('export_audio', {
          projectId,
          ops: currentOps.map((op) => ({ startMs: op.startMs, endMs: op.endMs })),
          inserts: addedPauses.map(insertOp),
          destPath: path,
          enhanced,
          format: preset.settings,
        }),
      );
    } catch (e) {
      console.error('Audio export failed:', e);
      setAudioError(String(e));
    } finally {
      setBusy(null);
    }
  }

  // Use filteredWords (deleted words omitted) for transcript exports so the
  // exported text / subtitles reflect the edits the user has made.
  // Times are on the edited timeline (EditorPage maps them), and so is the length.
  const { language } = transcript;
  const durationMs = Math.max(0, transcript.durationMs
    - currentOps.reduce((sum, op) => sum + op.endMs - op.startMs, 0)
    + addedPauses.reduce((sum, p) => sum + p.ms, 0));

  const transcriptExports = [
    { label: 'Plain text',    ext: 'txt',  desc: 'Paragraphs of text',    generate: () => toPlainText(filteredWords) },
    { label: 'SRT subtitles', ext: 'srt',  desc: 'SubRip subtitle file',  generate: () => toSRT(filteredWords) },
    { label: 'WebVTT',        ext: 'vtt',  desc: 'Web subtitle format',   generate: () => toVTT(filteredWords) },
    { label: 'JSON',          ext: 'json', desc: 'Words with timestamps', generate: () => toJSON(filteredWords, language, durationMs) },
  ];

  const cuts = currentOps.length;
  const added = addedPauses.length;
  const mb = estimateMb(preset.settings, durationMs / 1000);
  const audioDesc = [
    cuts > 0 ? `${cuts} cut${cuts !== 1 ? 's' : ''} applied` : 'No cuts',
    added > 0 && `${added} pause${added !== 1 ? 's' : ''} added`,
    enhanced ? 'enhanced audio' : 'original audio',
    mb !== null && aboutMb(mb),
  ].filter(Boolean).join(' · ');

  const saveButton = (ext: string, onClick: () => void) => (
    <IconButton kind="ghost" size="sm" label={`Save as .${ext}`} align="left" disabled={busy !== null} onClick={onClick}>
      <Download />
    </IconButton>
  );

  return (
    <div className="wave-inspector__stack">
      <ContainedList label="Audio" kind="on-page" size="md">
        <ContainedListItem className="wave-export-audio">
          <ContentSwitcher
            size="sm"
            selectedIndex={AUDIO_FORMATS.indexOf(format)}
            onChange={({ index }) => { if (index !== undefined) pickFormat(AUDIO_FORMATS[index].id); }}
          >
            {AUDIO_FORMATS.map((f) => <Switch key={f.id} name={f.id} text={f.name} />)}
          </ContentSwitcher>
          <p className="cds--form__helper-text">{format.note}</p>
          <RadioButtonGroup
            name={`wave-export-${format.id}`}
            legendText="Quality"
            orientation="vertical"
            valueSelected={preset.id}
            onChange={(value) => pickPreset(String(value))}
            className="wave-choice-list"
          >
            {format.presets.map((p) => (
              <RadioButton
                key={p.id}
                id={`wave-export-${p.id}`}
                value={p.id}
                labelText={<span className="wave-choice"><span className="wave-choice__name">{p.name}</span><span className="wave-choice__note">{p.note}</span></span>}
              />
            ))}
          </RadioButtonGroup>
          <div className="wave-export-audio__go">
            <p className="cds--form__helper-text">{audioDesc}</p>
            <Button size="sm" kind="primary" className="wave-btn-accent" renderIcon={Download} disabled={busy !== null} onClick={handleAudioExport}>
              {busy === 'audio' ? 'Exporting…' : `Export ${format.name}…`}
            </Button>
          </div>
        </ContainedListItem>
      </ContainedList>
      {audioError && (
        <InlineNotification kind="error" lowContrast title="Export failed" subtitle={audioError} onClose={() => setAudioError(null)} />
      )}

      <ContainedList label="Transcript" kind="on-page" size="md">
        {transcriptExports.map(({ label, ext, desc, generate }) => (
          <ContainedListItem key={ext} action={saveButton(ext, () => handleTranscriptExport(label, ext, generate))}>
            <ItemText title={label} helper={`.${ext} · ${desc}`} />
          </ContainedListItem>
        ))}
      </ContainedList>
    </div>
  );
}

// ─── Edits tab ────────────────────────────────────────────────────────────────

interface EditsTabProps {
  editActions:  EditAction[];
  onUndoAction: (id: string) => void;
}

function EditsTab({ editActions, onUndoAction }: EditsTabProps) {
  if (editActions.length === 0) {
    return (
      <div className="wave-inspector__empty">
        <p>No edits yet. Select words or a stretch of the waveform and press Delete.</p>
      </div>
    );
  }

  // An AI agent's call is one row (its actions share a group), undone together.
  const rows: { id: string; label: string; agent?: string }[] = [];
  const seen = new Set<string>();
  for (const action of [...editActions].reverse()) {
    if (action.group) {
      if (seen.has(action.group.id)) continue;
      seen.add(action.group.id);
      rows.push({ id: action.id, label: action.group.label, agent: action.group.agent });
    } else {
      rows.push({ id: action.id, label: action.label });
    }
  }

  return (
    <div className="wave-inspector__stack">
      <ContainedList label={`${rows.length} edit${rows.length !== 1 ? 's' : ''}, newest first`} kind="on-page" size="sm">
        {rows.map((row) => (
          <ContainedListItem
            key={row.id}
            action={
              <IconButton kind="ghost" size="sm" label="Undo this edit" align="left" onClick={() => onUndoAction(row.id)}>
                <Undo />
              </IconButton>
            }
          >
            {row.agent && <Tag size="sm" type="purple" className="wave-edit-agent" title={`Made by ${row.agent}`}>{row.agent}</Tag>}
            {row.label}
          </ContainedListItem>
        ))}
      </ContainedList>
    </div>
  );
}

// ─── Details tab ──────────────────────────────────────────────────────────────

interface DetailsTabProps {
  transcript:   Transcript;
  alignerReady: boolean;
  onRealign:    () => Promise<void>;
}

function DetailsTab({ transcript, alignerReady, onRealign }: DetailsTabProps) {
  const [aligning,  setAligning]  = useState(false);
  const [alignNote, setAlignNote] = useState<{ ok: boolean; text: string } | null>(null);
  const isEnglish = transcript.language === 'en';

  async function handleRealign() {
    setAligning(true);
    setAlignNote(null);
    try {
      await onRealign();
      setAlignNote({ ok: true, text: 'Existing cuts now use the new word boundaries.' });
    } catch (e) {
      setAlignNote({ ok: false, text: String(e) });
    } finally {
      setAligning(false);
    }
  }

  const rows: { label: string; value: string }[] = [
    { label: 'Language',   value: languageName(transcript.language) },
    { label: 'Duration',   value: formatLength(transcript.durationMs) },
    { label: 'Words',      value: transcript.words.length.toLocaleString() },
    { label: 'Confidence', value: `${Math.round(avgConfidence(transcript.words) * 100)}%` },
  ];

  return (
    <div className="wave-inspector__stack">
      <ContainedList label="Transcript" kind="on-page" size="sm">
        {rows.map(({ label, value }) => (
          <ContainedListItem key={label}>
            <span className="wave-list-value">
              <span>{label}</span>
              <span className="wave-list-value__value">{value}</span>
            </span>
          </ContainedListItem>
        ))}
      </ContainedList>

      <ContainedList label="Word timing" kind="on-page" size="md">
        <ContainedListItem>
          <ItemText
            title={!isEnglish ? 'English only' : alignerReady ? 'Word alignment' : 'Alignment model missing'}
            helper={
              !isEnglish
                ? 'Word alignment currently supports English recordings.'
                : alignerReady
                  ? 'Re-run if cuts leave part of a word behind, or for projects transcribed before alignment was installed.'
                  : 'Finish the Transcription download in Settings: its alignment model places every word on its exact audio.'
            }
          />
        </ContainedListItem>
      </ContainedList>
      {isEnglish && alignerReady && (
        <Button kind="tertiary" size="sm" disabled={aligning} onClick={handleRealign} className="wave-inspector__action">
          {aligning ? 'Aligning…' : 'Re-align words'}
        </Button>
      )}
      {alignNote && (
        <InlineNotification
          kind={alignNote.ok ? 'success' : 'error'}
          lowContrast
          title={alignNote.ok ? 'Words re-aligned' : 'Re-align failed'}
          subtitle={alignNote.text}
          onClose={() => setAlignNote(null)}
        />
      )}
    </div>
  );
}

// ─── Inspector panel ──────────────────────────────────────────────────────────

interface InspectorPanelProps {
  transcript:    Transcript | null;
  alignerReady:  boolean;
  onRealign:     () => Promise<void>;
  projectName:   string;
  projectId:     string;
  /** Non-deleted words for the text exports, with speaker names when shown. */
  filteredWords: (EnrichedWord & { speaker?: string })[];
  currentOps:    TimeOp[];
  editActions:   EditAction[];
  onUndoAction:  (id: string) => void;
  /** The Speech enhancement tool (Tools tab). */
  enhanceTool:   EnhanceToolProps;
  /** The Speakers tool (Tools tab). */
  speakerTool:   SpeakerToolProps;
  /** The Pauses tool (Tools tab). */
  pauseTool:     PauseToolProps;
  /** Pauses added by hand, for the audio export. */
  addedPauses:   InsertedPause[];
}

const TABS = [
  { label: 'Details', icon: Information },
  { label: 'Tools',   icon: MagicWand },
  { label: 'Edits',   icon: RecentlyViewed },
  { label: 'Export',  icon: Export },
] as const;

/** The tab last shown, across projects and launches. */
const TAB_KEY = 'wave.inspectorTab';

function readTab(): number {
  try {
    const i = TABS.findIndex((t) => t.label === localStorage.getItem(TAB_KEY));
    return i >= 0 ? i : 0;
  } catch {
    return 0;
  }
}

export function InspectorPanel({ transcript, alignerReady, onRealign, projectName, projectId, filteredWords, currentOps, editActions, onUndoAction, enhanceTool, speakerTool, pauseTool, addedPauses }: InspectorPanelProps) {
  const [tab, setTab] = useState(readTab);
  /** The tool open in the Tools tab (kept while other tabs are shown). */
  const [openTool, setOpenTool] = useState<ToolId | null>(null);
  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, TABS[tab].label); } catch { /* not saved */ }
  }, [tab]);
  const { width, handleProps } = usePanelWidth();

  function content(index: number) {
    if (!transcript) {
      return (
        <div className="wave-inspector__empty">
          <DocumentSet size={24} />
          <p>No transcript yet</p>
        </div>
      );
    }
    switch (TABS[index].label) {
      case 'Tools':
        return (
          <ToolsTab enhanceTool={enhanceTool} speakerTool={speakerTool} pauseTool={pauseTool}
            open={openTool} onOpen={setOpenTool} />
        );
      case 'Export':
        return (
          <ExportTab
            transcript={transcript}
            projectName={projectName}
            projectId={projectId}
            filteredWords={filteredWords}
            currentOps={currentOps}
            addedPauses={addedPauses}
            enhanced={enhanceTool.enhancement?.enabled ?? false}
          />
        );
      case 'Edits':
        return <EditsTab editActions={editActions} onUndoAction={onUndoAction} />;
      default:
        return <DetailsTab transcript={transcript} alignerReady={alignerReady} onRealign={onRealign} />;
    }
  }

  return (
    <aside className="wave-inspector" style={{ width }}>
      <div className="wave-inspector__resize" {...handleProps} />
      <Tabs selectedIndex={tab} onChange={({ selectedIndex }) => setTab(selectedIndex)}>
        <TabList aria-label="Inspector" className="wave-inspector__tabs">
          {TABS.map(({ label, icon }) => <Tab key={label} renderIcon={icon}>{label}</Tab>)}
        </TabList>
        <TabPanels>
          {TABS.map(({ label }, index) => (
            <TabPanel key={label} className="wave-inspector__panel">
              {tab === index && content(index)}
            </TabPanel>
          ))}
        </TabPanels>
      </Tabs>
    </aside>
  );
}
