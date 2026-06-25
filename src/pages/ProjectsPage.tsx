import { useState } from 'react';
import { Button, Modal, TextInput, InlineLoading } from '@carbon/react';
import { Add, ArrowRight, DocumentAudio, TrashCan, WarningAltFilled, ErrorFilled, CheckmarkFilled, Music } from '@carbon/icons-react';
import type { Project, ProjectStatus } from '../hooks/useProjects';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(secs?: number): string {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ProjectStatus }) {
  if (status.type === 'empty') {
    return <span className="wave-project-badge wave-project-badge--dim">No Audio</span>;
  }
  if (status.type === 'importing') {
    return <span className="wave-project-badge wave-project-badge--blue">Importing…</span>;
  }
  if (status.type === 'readyToTranscribe') {
    return <span className="wave-project-badge wave-project-badge--amber">Ready to Transcribe</span>;
  }
  if (status.type === 'transcribing') {
    return <span className="wave-project-badge wave-project-badge--blue">Transcribing…</span>;
  }
  if (status.type === 'ready') {
    return <span className="wave-project-badge wave-project-badge--green">Transcribed</span>;
  }
  if (status.type === 'error') {
    return <span className="wave-project-badge wave-project-badge--red">Error</span>;
  }
  return null;
}

function StatusIcon({ status }: { status: ProjectStatus }) {
  if (status.type === 'readyToTranscribe' || status.type === 'ready') {
    return <CheckmarkFilled size={14} className="wave-project-card__status-icon wave-project-card__status-icon--ok" />;
  }
  if (status.type === 'error') {
    return <ErrorFilled size={14} className="wave-project-card__status-icon wave-project-card__status-icon--err" />;
  }
  return null;
}

// ─── Project card ─────────────────────────────────────────────────────────────

interface ProjectCardProps {
  project: Project;
  importPct?: number;
  transcriptionPct?: number;
  onClick: () => void;
  onDeleteRequest: () => void;
}

function ProjectCard({ project, importPct, transcriptionPct, onClick, onDeleteRequest }: ProjectCardProps) {
  const isImporting    = project.status.type === 'importing';
  const isTranscribing = project.status.type === 'transcribing';
  const isError        = project.status.type === 'error';

  return (
    <article
      className={`wave-project-card${isError ? ' wave-project-card--error' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <div className="wave-project-card__top">
        <div className="wave-project-card__icon">
          <DocumentAudio size={20} />
        </div>
        <div className="wave-project-card__top-right">
          <StatusBadge status={project.status} />
          <button
            className="wave-project-card__delete-btn"
            aria-label="Delete project"
            onClick={(e) => { e.stopPropagation(); onDeleteRequest(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onDeleteRequest(); } }}
          >
            <TrashCan size={14} />
          </button>
        </div>
      </div>

      <div className="wave-project-card__body">
        <h3 className="wave-project-card__name">
          {project.name}
          <StatusIcon status={project.status} />
        </h3>

        {project.originalFilename && (
          <p className="wave-project-card__filename">
            {project.originalFilename}
            {project.durationSecs != null && (
              <span className="wave-project-card__duration">
                &nbsp;·&nbsp;{formatDuration(project.durationSecs)}
              </span>
            )}
          </p>
        )}

        {isError && (project.status as { type: 'error'; message: string }).message && (
          <p className="wave-project-card__error-msg">
            {(project.status as { type: 'error'; message: string }).message}
          </p>
        )}
      </div>

      {/* Import progress bar */}
      {isImporting && (
        <div className="wave-project-card__import-bar">
          <div
            className="wave-project-card__import-fill"
            style={{ width: `${importPct ?? 0}%` }}
          />
        </div>
      )}
      {isImporting && (
        <span className="wave-project-card__import-pct">
          {importPct ?? 0}%
        </span>
      )}

      {/* Transcription progress bar */}
      {isTranscribing && (
        <div className="wave-project-card__import-bar wave-project-card__import-bar--transcribing">
          <div
            className="wave-project-card__import-fill wave-project-card__import-fill--transcribing"
            style={{ width: `${transcriptionPct ?? 0}%` }}
          />
        </div>
      )}
      {isTranscribing && (
        <span className="wave-project-card__import-pct">
          {transcriptionPct ?? 0}%
        </span>
      )}

      <div className="wave-project-card__footer">
        <span className="wave-project-card__date">{formatDate(project.createdAt)}</span>
      </div>
    </article>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

const IdleWaveform = () => (
  <svg className="wave-empty-state__waveform" width="180" height="56" viewBox="0 0 180 56" aria-hidden="true">
    <rect x="0"   y="22" width="10" height="12" rx="3" />
    <rect x="14"  y="12" width="10" height="32" rx="3" />
    <rect x="28"  y="4"  width="10" height="48" rx="3" />
    <rect x="42"  y="16" width="10" height="24" rx="3" />
    <rect x="56"  y="0"  width="10" height="56" rx="3" />
    <rect x="70"  y="10" width="10" height="36" rx="3" />
    <rect x="84"  y="18" width="10" height="20" rx="3" />
    <rect x="98"  y="6"  width="10" height="44" rx="3" />
    <rect x="112" y="14" width="10" height="28" rx="3" />
    <rect x="126" y="2"  width="10" height="52" rx="3" />
    <rect x="140" y="18" width="10" height="20" rx="3" />
    <rect x="154" y="24" width="10" height="8"  rx="3" />
  </svg>
);

// ─── New Project Modal ─────────────────────────────────────────────────────────

interface NewProjectModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, filePath: string) => Promise<void>;
  onPickFile: () => Promise<string | null>;
}

function NewProjectModal({ open: isOpen, onClose, onCreate, onPickFile }: NewProjectModalProps) {
  const [name,      setName]      = useState('');
  const [filePath,  setFilePath]  = useState<string | null>(null);
  const [fileName,  setFileName]  = useState<string | null>(null);
  const [creating,  setCreating]  = useState(false);
  const [nameError, setNameError] = useState('');

  async function handlePickFile() {
    const path = await onPickFile();
    if (path) {
      setFilePath(path);
      setFileName(path.split('/').pop() ?? path);
    }
  }

  async function handleCreate() {
    if (!name.trim()) {
      setNameError('Project name is required');
      return;
    }
    if (!filePath) return;
    setCreating(true);
    try {
      await onCreate(name.trim(), filePath);
      // Reset
      setName('');
      setFilePath(null);
      setFileName(null);
      setNameError('');
      onClose();
    } finally {
      setCreating(false);
    }
  }

  function handleClose() {
    if (creating) return;
    setName('');
    setFilePath(null);
    setFileName(null);
    setNameError('');
    onClose();
  }

  const canCreate = name.trim().length > 0 && filePath !== null && !creating;

  return (
    <Modal
      open={isOpen}
      modalHeading="New Project"
      primaryButtonText={creating ? 'Creating…' : 'Create Project'}
      primaryButtonDisabled={!canCreate}
      secondaryButtonText="Cancel"
      onRequestSubmit={handleCreate}
      onRequestClose={handleClose}
      onSecondarySubmit={handleClose}
      size="sm"
    >
      <div className="wave-new-project-form">
        <TextInput
          id="project-name"
          labelText="Project name"
          placeholder="e.g. Episode 42 — Interview with…"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (e.target.value.trim()) setNameError('');
          }}
          invalid={Boolean(nameError)}
          invalidText={nameError}
          disabled={creating}
          autoFocus
        />

        <div className="wave-file-picker">
          <span className="wave-file-picker__label">Audio file</span>
          <div className="wave-file-picker__row">
            <div className={`wave-file-picker__display${filePath ? ' wave-file-picker__display--selected' : ''}`}>
              {fileName ? (
                <>
                  <Music size={16} />
                  <span>{fileName}</span>
                </>
              ) : (
                <span className="wave-file-picker__placeholder">No file selected</span>
              )}
            </div>
            <Button
              kind="secondary"
              size="sm"
              onClick={handlePickFile}
              disabled={creating}
            >
              Browse…
            </Button>
          </div>
          <p className="wave-file-picker__hint">
            Supported: MP3, WAV, FLAC, M4A, AAC, OGG, AIFF
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface ProjectsPageProps {
  projects: Project[];
  importProgress: Record<string, number>;
  transcriptionProgress: Record<string, number>;
  loading: boolean;
  hasReadyModel: boolean;
  onNewProject: (name: string, filePath: string) => Promise<void>;
  onPickFile: () => Promise<string | null>;
  onOpenProject: (project: Project) => void;
  onDeleteProject: (id: string) => Promise<void>;
  onGoToSettings: () => void;
}

export function ProjectsPage({
  projects,
  importProgress,
  transcriptionProgress,
  loading,
  hasReadyModel,
  onNewProject,
  onPickFile,
  onOpenProject,
  onDeleteProject,
  onGoToSettings,
}: ProjectsPageProps) {
  const [modalOpen,        setModalOpen]        = useState(false);
  const [showNoModelModal, setShowNoModelModal] = useState(false);
  const [deleteTarget,     setDeleteTarget]     = useState<Project | null>(null);
  const [deleting,         setDeleting]         = useState(false);

  function handleNewProjectClick() {
    if (!hasReadyModel) {
      setShowNoModelModal(true);
    } else {
      setModalOpen(true);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await onDeleteProject(deleteTarget.id);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="wave-page">
      {/* No-model banner */}
      {!hasReadyModel && (
        <div className="wave-no-model-banner">
          <WarningAltFilled size={16} />
          <span className="wave-no-model-banner__text">
            <strong>No model downloaded.</strong>{' '}
            Download a Whisper model in Settings before creating a project.
          </span>
          <Button kind="ghost" size="sm" renderIcon={ArrowRight} onClick={onGoToSettings}>
            Go to Settings
          </Button>
        </div>
      )}

      <div className="wave-page__header">
        <div className="wave-page__header-row">
          <div>
            <h1 className="wave-page__title">Projects</h1>
            <p className="wave-page__subtitle">Your podcast and audio editing projects</p>
          </div>
          {projects.length > 0 && (
            <Button
              className="wave-btn-accent"
              kind="primary"
              renderIcon={Add}
              size="sm"
              onClick={handleNewProjectClick}
            >
              New Project
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="wave-empty-state">
          <InlineLoading description="Loading projects…" status="active" />
        </div>
      ) : projects.length === 0 ? (
        <div className="wave-empty-state">
          <IdleWaveform />
          <h2 className="wave-empty-state__heading">No projects yet</h2>
          <p className="wave-empty-state__body">
            Import an audio file to start transcribing and editing with text.
          </p>
          <Button className="wave-btn-accent" kind="primary" renderIcon={Add} onClick={handleNewProjectClick}>
            New Project
          </Button>
        </div>
      ) : (
        <div className="wave-project-grid">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              importPct={importProgress[p.id]}
              transcriptionPct={transcriptionProgress[p.id]}
              onClick={() => onOpenProject(p)}
              onDeleteRequest={() => setDeleteTarget(p)}
            />
          ))}
        </div>
      )}

      {/* New project modal */}
      <NewProjectModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreate={onNewProject}
        onPickFile={onPickFile}
      />

      {/* No-model gate modal */}
      <Modal
        open={showNoModelModal}
        modalHeading="Download a model first"
        primaryButtonText="Go to Settings"
        secondaryButtonText="Cancel"
        onRequestSubmit={() => { setShowNoModelModal(false); onGoToSettings(); }}
        onRequestClose={() => setShowNoModelModal(false)}
        onSecondarySubmit={() => setShowNoModelModal(false)}
        size="sm"
      >
        <p style={{ lineHeight: 1.6, color: '#c6c6c6' }}>
          Wave transcribes audio locally using a Whisper model running entirely on your Mac.
          You need to download at least one model before creating a project.
        </p>
        <p style={{ marginTop: 12, lineHeight: 1.6, color: '#8d8d8d', fontSize: 13 }}>
          The <strong style={{ color: '#c6c6c6' }}>Small</strong> model (466 MB) is
          recommended — fast and accurate on Apple Silicon.
        </p>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        open={Boolean(deleteTarget)}
        danger
        modalHeading="Delete project?"
        primaryButtonText={deleting ? 'Deleting…' : 'Delete'}
        secondaryButtonText="Cancel"
        onRequestSubmit={handleConfirmDelete}
        onRequestClose={() => !deleting && setDeleteTarget(null)}
        onSecondarySubmit={() => setDeleteTarget(null)}
        primaryButtonDisabled={deleting}
        size="sm"
      >
        <p style={{ lineHeight: 1.6, color: '#c6c6c6' }}>
          <strong style={{ color: '#f4f4f4' }}>{deleteTarget?.name}</strong> and all of its
          files — audio, transcript, and edits — will be permanently deleted.
          This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
