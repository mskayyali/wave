import { useEffect, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button, IconButton, Modal, Tag, TextInput, InlineLoading } from '@carbon/react';
import { Add, ArrowRight, CheckmarkFilled, DocumentAudio, Renew, TrashCan, WarningAltFilled, Music } from '@carbon/icons-react';
import type { Project, ProjectStatus } from '../hooks/useProjects';
import { formatLength } from '../lib/time';
import { BrandHero } from '../components/brand/BrandHero';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}


// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_TAGS: Record<ProjectStatus['type'], { label: string; type: 'gray' | 'blue' | 'warm-gray' | 'green' | 'red' }> = {
  empty:             { label: 'No audio',            type: 'gray' },
  importing:         { label: 'Importing',           type: 'blue' },
  readyToTranscribe: { label: 'Ready to transcribe', type: 'warm-gray' },
  transcribing:      { label: 'Transcribing',        type: 'blue' },
  ready:             { label: 'Transcribed',         type: 'green' },
  error:             { label: 'Error',               type: 'red' },
};

function StatusTag({ status }: { status: ProjectStatus }) {
  const tag = STATUS_TAGS[status.type];
  return <Tag size="sm" type={tag.type} className="wave-project-card__status">{tag.label}</Tag>;
}

// ─── Card waveform ────────────────────────────────────────────────────────────

/** The project's waveform in miniature (waveform.rs → get_waveform_overview). */
function CardWaveform({ projectId }: { projectId: string }) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<number[] | null>('get_waveform_overview', { projectId, points: 96 })
      .then((p) => { if (!cancelled) setPeaks(p); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);
  if (!peaks) return <div className="wave-project-card__wave" aria-hidden />;
  const top = Math.max(...peaks, 1e-3);
  return (
    <svg className="wave-project-card__wave" viewBox={`0 0 ${peaks.length * 3} 32`} preserveAspectRatio="none" aria-hidden>
      {peaks.map((p, i) => {
        const h = Math.max(1.5, (p / top) * 30);
        return <rect key={i} x={i * 3} y={16 - h / 2} width={2} height={h} rx={1} />;
      })}
    </svg>
  );
}

// ─── Project card ─────────────────────────────────────────────────────────────

interface ProjectCardProps {
  project: Project;
  importPct?: number;
  transcriptionPct?: number;
  onClick: () => void;
  onDeleteRequest: () => void;
  /** Try again (failed), or transcribe (imported, never transcribed). */
  onRetry: () => void;
}

function ProjectCard({ project, importPct, transcriptionPct, onClick, onDeleteRequest, onRetry }: ProjectCardProps) {
  const isImporting    = project.status.type === 'importing';
  const isTranscribing = project.status.type === 'transcribing';
  const isError        = project.status.type === 'error';
  const isWaiting      = project.status.type === 'readyToTranscribe';

  return (
    <article
      className={`wave-project-card${isError ? ' wave-project-card--error' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`${project.name}, ${STATUS_TAGS[project.status.type].label}`}
      data-project-card
    >
      <div className="wave-project-card__top">
        <div className="wave-project-card__icon">
          <DocumentAudio size={20} />
        </div>
        <div className="wave-project-card__top-right">
          <StatusTag status={project.status} />
          <IconButton
            kind="ghost"
            size="sm"
            label="Delete project"
            align="bottom-end"
            className="wave-project-card__delete"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onDeleteRequest(); }}
            onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
          >
            <TrashCan />
          </IconButton>
        </div>
      </div>

      <div className="wave-project-card__body">
        <h3 className="wave-project-card__name">{project.name}</h3>

        {project.originalFilename && (
          <p className="wave-project-card__filename">
            {project.originalFilename}
            {project.durationSecs != null && (
              <span className="wave-project-card__duration">
                &nbsp;·&nbsp;{formatLength(project.durationSecs * 1000)}
              </span>
            )}
          </p>
        )}

        {isError && (project.status as { type: 'error'; message: string }).message && (
          <p className="wave-project-card__error-msg">
            {(project.status as { type: 'error'; message: string }).message}
          </p>
        )}
        {(isError || isWaiting) && (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={isWaiting ? undefined : Renew}
            className="wave-project-card__retry"
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRetry(); }}
            onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
          >
            {isWaiting ? 'Transcribe' : project.durationSecs ? 'Transcribe again' : 'Import again…'}
          </Button>
        )}
      </div>

      {project.status.type === 'ready' && <CardWaveform projectId={project.id} />}

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
        <div className="wave-project-card__import-bar">
          <div
            className="wave-project-card__import-fill"
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
      modalHeading="New project"
      primaryButtonText={creating ? 'Creating…' : 'Create project'}
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
  onRetryProject: (project: Project) => void;
  onGoToSettings: () => void;
  /** ⌘N (the menu): open the New Project dialog, then call onNewProjectShown. */
  newProjectPending: boolean;
  onNewProjectShown: () => void;
}

// ─── First run ────────────────────────────────────────────────────────────────

/** The empty Projects page: three steps to a first edit, ticking themselves off. */
function FirstRun({ hasReadyModel, onNewProject, onGoToSettings }: {
  hasReadyModel:  boolean;
  onNewProject:   () => void;
  onGoToSettings: () => void;
}) {
  // Where the user is: setting up, or ready for a first recording.
  const current = hasReadyModel ? 1 : 0;
  const steps = [
    { title: 'Set up transcription', body: hasReadyModel ? 'Ready. It runs on your Mac.' : 'A one-time 1.6 GB download.' },
    { title: 'Import a recording',   body: 'MP3, WAV, M4A, FLAC and more.' },
    { title: 'Edit the text',        body: 'Select words, press ⌫. Undo anything.' },
  ];
  return (
    <div className="wave-empty-state wave-welcome">
      <BrandHero />
      <h2 className="wave-welcome__title">Welcome to Wave</h2>
      <ol className="wave-steps">
        {steps.map((step, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'next';
          return (
            <li
              key={step.title}
              className={`wave-steps__step wave-steps__step--${state}`}
              aria-current={state === 'current' ? 'step' : undefined}
              style={{ animationDelay: `${0.1 + i * 0.07}s` }}
            >
              <span className="wave-steps__mark" aria-hidden>
                {state === 'done' ? <CheckmarkFilled size={16} /> : i + 1}
              </span>
              <span className="wave-steps__text">
                <span className="wave-steps__title">
                  {step.title}{state === 'done' && <span className="cds--visually-hidden"> (done)</span>}
                </span>
                <span className="wave-steps__body">{step.body}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="wave-welcome__action">
        {hasReadyModel ? (
          <>
            <Button kind="primary" className="wave-btn-accent" renderIcon={Add} onClick={onNewProject}>New project</Button>
            <span className="wave-welcome__hint">or drop an audio file anywhere on this window</span>
          </>
        ) : (
          <>
            <Button kind="primary" className="wave-btn-accent" renderIcon={ArrowRight} onClick={onGoToSettings}>Set up transcription</Button>
            <span className="wave-welcome__hint">in Settings, once</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Arrow keys move between cards, ⌫ asks to delete the focused one. */
function gridKeys(e: KeyboardEvent<HTMLDivElement>, onDelete: (index: number) => void) {
  const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-project-card]')];
  const index = cards.indexOf(e.target as HTMLElement);
  if (index < 0) return;
  // Cards per row: those level with the first.
  const columns = Math.max(1, cards.filter((c) => c.offsetTop === cards[0].offsetTop).length);
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[e.key];
  if (step !== undefined) {
    e.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, index + step))]?.focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    cards[index].click();
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    onDelete(index);
  }
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
  onRetryProject,
  onGoToSettings,
  newProjectPending,
  onNewProjectShown,
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

  // ⌘N from the menu, also when it brought this page up.
  useEffect(() => {
    if (!newProjectPending) return;
    onNewProjectShown();
    handleNewProjectClick();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newProjectPending]);

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
      {/* No-model banner (the empty page's first-run steps say it instead) */}
      {!hasReadyModel && projects.length > 0 && (
        <div className="wave-no-model-banner">
          <WarningAltFilled size={16} />
          <span className="wave-no-model-banner__text">
            <strong>Transcription isn&apos;t set up yet.</strong>{' '}
            Download it in Settings before creating a project.
          </span>
          <Button kind="ghost" size="sm" renderIcon={ArrowRight} onClick={onGoToSettings}>
            Go to Settings
          </Button>
        </div>
      )}

      <div className="wave-page__header" data-tauri-drag-region>
        <div className="wave-page__header-row" data-tauri-drag-region>
          <div data-tauri-drag-region>
            <h1 className="wave-page__title" data-tauri-drag-region>Projects</h1>
            <p className="wave-page__subtitle" data-tauri-drag-region>Your podcast and audio editing projects</p>
          </div>
          {projects.length > 0 && (
            <Button
              className="wave-btn-accent"
              kind="primary"
              renderIcon={Add}
              size="sm"
              onClick={handleNewProjectClick}
            >
              New project
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="wave-empty-state">
          <InlineLoading description="Loading projects…" status="active" />
        </div>
      ) : projects.length === 0 ? (
        <FirstRun hasReadyModel={hasReadyModel} onNewProject={handleNewProjectClick} onGoToSettings={onGoToSettings} />
      ) : (
        <div className="wave-project-grid" onKeyDown={(e) => gridKeys(e, (i) => setDeleteTarget(projects[i]))}>
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              importPct={importProgress[p.id]}
              transcriptionPct={transcriptionProgress[p.id]}
              onClick={() => onOpenProject(p)}
              onDeleteRequest={() => setDeleteTarget(p)}
              onRetry={() => onRetryProject(p)}
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
        modalHeading="Set up transcription first"
        primaryButtonText="Open Settings"
        secondaryButtonText="Cancel"
        onRequestSubmit={() => { setShowNoModelModal(false); onGoToSettings(); }}
        onRequestClose={() => setShowNoModelModal(false)}
        onSecondarySubmit={() => setShowNoModelModal(false)}
        size="sm"
      >
        <p className="wave-modal-text">
          Wave transcribes audio locally, entirely on your Mac. Download the transcription
          models once before creating a project.
        </p>
        <p className="wave-modal-text wave-modal-text--secondary">
          <strong>Transcription</strong> (1.6 GB) is two models in one
          download: Whisper writes the words, and a small alignment model places each one on its
          exact audio, so text cuts are clean.
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
        <p className="wave-modal-text">
          <strong>{deleteTarget?.name}</strong> and all of its
          files — audio, transcript, and edits — will be permanently deleted.
          This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
