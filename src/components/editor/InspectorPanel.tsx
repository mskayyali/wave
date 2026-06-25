import { useState } from 'react';
import { Button } from '@carbon/react';
import {
  Download, Information, DocumentSet, Undo,
} from '@carbon/icons-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { toPlainText, toSRT, toVTT, toJSON } from '../../utils/exportFormats';
import type { Transcript, EnrichedWord } from '../../hooks/useTranscript';
import type { EditAction } from '../../pages/EditorPage';

type TimeOp = { startMs: number; endMs: number };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function avgConfidence(words: Transcript['words']): number {
  if (words.length === 0) return 0;
  return words.reduce((acc, w) => acc + w.confidence, 0) / words.length;
}

function confidenceColor(pct: number): string {
  if (pct >= 85) return '#42be65';
  if (pct >= 70) return 'var(--wave-accent)';
  return '#ff8389';
}

// ─── Keyboard shortcuts data ──────────────────────────────────────────────────

const SHORTCUTS: { key: string; label: string }[] = [
  { key: 'Space',   label: 'Play / Pause'    },
  { key: '←  →',   label: 'Seek ±5 seconds' },
  { key: 'J',       label: 'Speed −0.25×'    },
  { key: 'L',       label: 'Speed +0.25×'    },
  { key: 'Delete',  label: 'Delete selection'    },
  { key: '⌘Z',     label: 'Undo last cut'        },
];

// ─── Export tab ───────────────────────────────────────────────────────────────

interface ExportTabProps {
  transcript:    Transcript;
  projectName:   string;
  projectId:     string;
  filteredWords: EnrichedWord[];  // non-deleted, non-silence words for export
  currentOps:    TimeOp[];          // merged cut ranges (for audio splice)
}

function ExportTab({ transcript, projectName, projectId, filteredWords, currentOps }: ExportTabProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  async function handleTranscriptExport(format: string, ext: string, generate: () => string) {
    setBusy(format);
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
    setBusy('wav');
    setAudioError(null);
    try {
      const path = await save({
        defaultPath: `${projectName}.wav`,
        filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
      });
      if (!path) return;
      await invoke('export_audio', {
        projectId,
        ops: currentOps.map((op) => ({ startMs: op.startMs, endMs: op.endMs })),
        destPath: path,
      });
    } catch (e) {
      console.error('Audio export failed:', e);
      setAudioError('Export failed. Check the console for details.');
    } finally {
      setBusy(null);
    }
  }

  // Use filteredWords (deleted words omitted) for transcript exports so the
  // exported text / subtitles reflect the edits the user has made.
  const { language, durationMs } = transcript;

  const transcriptExports = [
    { id: 'txt',  label: 'Plain Text',    ext: 'txt',  desc: 'Clean paragraph text',     generate: () => toPlainText(filteredWords) },
    { id: 'srt',  label: 'SRT Subtitles', ext: 'srt',  desc: 'SubRip subtitle file',     generate: () => toSRT(filteredWords) },
    { id: 'vtt',  label: 'WebVTT',        ext: 'vtt',  desc: 'Web subtitle format',       generate: () => toVTT(filteredWords) },
    { id: 'json', label: 'JSON',          ext: 'json', desc: 'Word-level timestamp data',  generate: () => toJSON(filteredWords, language, durationMs) },
  ];

  return (
    <div className="wave-inspector-tab-content">
      <div className="wave-inspector-section">
        <p className="wave-inspector-section__title">Transcript</p>
        <div className="wave-inspector-export-list">
          {transcriptExports.map(({ id, label, ext, desc, generate }) => (
            <div key={id} className="wave-inspector-export-row">
              <div className="wave-inspector-export-row__info">
                <span className="wave-inspector-export-row__label">{label}</span>
                <span className="wave-inspector-export-row__desc">{desc}</span>
              </div>
              <Button
                kind="ghost"
                size="sm"
                className="wave-inspector-export-btn"
                renderIcon={Download}
                disabled={busy !== null}
                onClick={() => handleTranscriptExport(label, ext, generate)}
              >
                {busy === id ? '…' : `.${ext}`}
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="wave-inspector-section">
        <p className="wave-inspector-section__title">Audio</p>
        <div className="wave-inspector-export-list">
          <div className="wave-inspector-export-row">
            <div className="wave-inspector-export-row__info">
              <span className="wave-inspector-export-row__label">WAV</span>
              <span className="wave-inspector-export-row__desc">
                {currentOps.length > 0
                  ? `Edited audio · ${currentOps.length} cut${currentOps.length !== 1 ? 's' : ''} applied`
                  : 'Full audio, no cuts'}
              </span>
            </div>
            <Button
              kind="ghost"
              size="sm"
              className="wave-inspector-export-btn"
              renderIcon={Download}
              disabled={busy !== null}
              onClick={handleAudioExport}
            >
              {busy === 'wav' ? '…' : '.wav'}
            </Button>
          </div>
        </div>
        {audioError && (
          <p className="wave-inspector-section__note wave-inspector-section__note--error">
            {audioError}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Details tab ──────────────────────────────────────────────────────────────

function DetailsTab({ transcript }: { transcript: Transcript }) {
  const conf    = Math.round(avgConfidence(transcript.words) * 100);
  const confClr = confidenceColor(conf);

  const rows: { label: string; value: string; color?: string }[] = [
    { label: 'Language',   value: transcript.language.toUpperCase() },
    { label: 'Duration',   value: formatDuration(transcript.durationMs) },
    { label: 'Words',      value: transcript.words.length.toLocaleString() },
    { label: 'Confidence', value: `${conf}%`, color: confClr },
  ];

  return (
    <div className="wave-inspector-tab-content">
      <div className="wave-inspector-section">
        <p className="wave-inspector-section__title">Transcript info</p>
        <dl className="wave-inspector-details">
          {rows.map(({ label, value, color }) => (
            <div key={label} className="wave-inspector-details__row">
              <dt>{label}</dt>
              <dd style={color ? { color } : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="wave-inspector-section">
        <p className="wave-inspector-section__title">Confidence legend</p>
        <div className="wave-inspector-conf-legend">
          <span className="wave-word wave-word--low">Low (&lt;60%)</span>
          <span className="wave-word wave-word--mid">Medium (60–80%)</span>
          <span className="wave-word">High (&gt;80%)</span>
        </div>
      </div>

      <div className="wave-inspector-section">
        <p className="wave-inspector-section__title">Keyboard shortcuts</p>
        <dl className="wave-inspector-shortcuts">
          {SHORTCUTS.map(({ key, label }) => (
            <div key={key} className="wave-inspector-shortcuts__row">
              <dt><kbd className="wave-kbd">{key}</kbd></dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </div>
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
      <div className="wave-inspector-tab-content">
        <div className="wave-inspector-empty wave-inspector-empty--inline">
          <p className="wave-inspector-empty__hint">No edits yet.<br />Select words and press Delete.</p>
        </div>
      </div>
    );
  }

  const reversed = [...editActions].reverse();

  return (
    <div className="wave-inspector-tab-content">
      <div className="wave-inspector-section">
        <p className="wave-inspector-section__title">{editActions.length} cut{editActions.length !== 1 ? 's' : ''}</p>
        <ul className="wave-edits-list">
          {reversed.map((action) => (
            <li key={action.id} className="wave-edit-item">
              <span className="wave-edit-item__label">{action.label}</span>
              <button
                className="wave-edit-item__undo"
                title="Undo this edit"
                onClick={() => onUndoAction(action.id)}
              >
                <Undo size={12} />
                Undo
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── Inspector panel ──────────────────────────────────────────────────────────

interface InspectorPanelProps {
  transcript:    Transcript | null;
  projectName:   string;
  projectId:     string;
  filteredWords: EnrichedWord[];
  currentOps:    TimeOp[];
  editActions:   EditAction[];
  onUndoAction:  (id: string) => void;
}

type Tab = 'export' | 'edits' | 'details';

const TABS: { id: Tab; label: string; Icon: React.ComponentType<{ size: number }> }[] = [
  { id: 'export',  label: 'Export',  Icon: Download    },
  { id: 'edits',   label: 'Edits',   Icon: Undo        },
  { id: 'details', label: 'Details', Icon: Information },
];

export function InspectorPanel({ transcript, projectName, projectId, filteredWords, currentOps, editActions, onUndoAction }: InspectorPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('export');

  return (
    <aside className="wave-inspector">
      {/* Tab bar */}
      <div className="wave-inspector-tabs" role="tablist">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            className={`wave-inspector-tab${activeTab === id ? ' wave-inspector-tab--active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {!transcript ? (
        <div className="wave-inspector-empty">
          <DocumentSet size={24} />
          <p>No transcript yet</p>
        </div>
      ) : activeTab === 'export' ? (
        <ExportTab
          transcript={transcript}
          projectName={projectName}
          projectId={projectId}
          filteredWords={filteredWords}
          currentOps={currentOps}
        />
      ) : activeTab === 'edits' ? (
        <EditsTab editActions={editActions} onUndoAction={onUndoAction} />
      ) : (
        <DetailsTab transcript={transcript} />
      )}
    </aside>
  );
}
