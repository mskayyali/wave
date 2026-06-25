import { Button, InlineLoading, ProgressBar } from '@carbon/react';
import {
  CheckmarkFilled,
  Checkmark,
  Download,
  Error as ErrorIcon,
  Renew,
  StopFilled,
  TrashCan,
} from '@carbon/icons-react';
import {
  MODEL_CATALOG,
  formatBytes,
  formatEta,
  formatSpeed,
} from '../lib/modelCatalog';
import type { ModelInfo, DownloadProgress } from '../hooks/useModels';

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreDots({
  score,
  color,
}: {
  score: number;
  color: 'amber' | 'teal';
}) {
  return (
    <span className="wave-score-dots">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`wave-score-dot wave-score-dot--${color}${i < score ? ' wave-score-dot--filled' : ''}`}
        />
      ))}
    </span>
  );
}

interface ModelCardProps {
  info:        ModelInfo;
  prog?:       DownloadProgress;
  error?:      string;
  isSelected:  boolean;
  onDownload:  () => void;
  onCancel:    () => void;
  onDelete:    () => void;
  onRetry:     () => void;
  onSelect:    () => void;
}

function ModelCard({
  info,
  prog,
  error,
  isSelected,
  onDownload,
  onCancel,
  onDelete,
  onRetry,
  onSelect,
}: ModelCardProps) {
  const meta   = MODEL_CATALOG.find((m) => m.id === info.id)!;
  const status = info.status;
  const isDownloading = status.type === 'downloading';
  const isReady       = status.type === 'ready';
  const isPartial     = status.type === 'partial';
  const hasError      = Boolean(error);

  return (
    <article className={`wave-model-card${isReady ? ' wave-model-card--ready' : ''}${hasError ? ' wave-model-card--error' : ''}${isSelected ? ' wave-model-card--selected' : ''}`}>
      {/* ── Selected badge ────────────────────────────────────────────── */}
      {isSelected && (
        <div className="wave-model-card__selected-badge">
          <Checkmark size={12} />
          <span>Active model</span>
        </div>
      )}

      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="wave-model-card__head">
        <div className="wave-model-card__title-row">
          <h3 className="wave-model-card__name">{meta.name}</h3>
          <div className="wave-model-card__badges">
            {meta.badge && (
              <span className={`wave-badge wave-badge--${meta.recommended ? 'amber' : 'teal'}`}>
                {meta.badge}
              </span>
            )}
            <span className="wave-badge wave-badge--dim">
              {meta.language}
            </span>
          </div>
        </div>
        <span className="wave-model-card__size">
          {formatBytes(meta.sizeMb * 1024 * 1024)}
        </span>
      </div>

      {/* ── Description ───────────────────────────────────────────────── */}
      <p className="wave-model-card__desc">{meta.description}</p>

      <div className="wave-model-card__best-for">
        <span className="wave-model-card__label">Best for</span>
        {meta.bestFor}
      </div>

      {/* ── Speed / Accuracy ─────────────────────────────────────────── */}
      <div className="wave-model-card__scores">
        <div className="wave-model-card__score-row">
          <span className="wave-model-card__label">Speed</span>
          <ScoreDots score={meta.speedScore} color="teal" />
          <span className="wave-model-card__score-label">{meta.speedLabel}</span>
        </div>
        <div className="wave-model-card__score-row">
          <span className="wave-model-card__label">Accuracy</span>
          <ScoreDots score={meta.accuracyScore} color="amber" />
        </div>
      </div>

      <p className="wave-model-card__reqs">{meta.requirements}</p>

      {/* ── Error banner ─────────────────────────────────────────────── */}
      {hasError && (
        <div className="wave-model-card__error-banner">
          <ErrorIcon size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* ── Downloading: progress ─────────────────────────────────────── */}
      {isDownloading && prog && (
        <div className="wave-model-card__progress">
          <div className="wave-model-card__progress-meta">
            <span>{formatBytes(prog.downloadedBytes)} / {formatBytes(prog.totalBytes)}</span>
            <span className="wave-model-card__progress-right">
              <span className="wave-model-card__speed">{formatSpeed(prog.speedBps)}</span>
              {prog.etaSecs > 0 && (
                <span className="wave-model-card__eta">{formatEta(prog.etaSecs)}</span>
              )}
            </span>
          </div>
          <ProgressBar
            value={prog.percentage}
            max={100}
            label={prog.resuming ? 'Resuming…' : 'Downloading…'}
            hideLabel
            className="wave-progress-bar"
          />
          {prog.resuming && (
            <span className="wave-model-card__resuming-note">Resuming from previous download</span>
          )}
        </div>
      )}

      {isDownloading && !prog && (
        <div className="wave-model-card__progress">
          <InlineLoading description="Connecting…" status="active" />
        </div>
      )}

      {/* ── Footer: action buttons ────────────────────────────────────── */}
      <div className="wave-model-card__footer">
        {isReady && (
          <>
            <div className="wave-model-card__ready-row">
              <span className="wave-model-card__ready-label">
                <CheckmarkFilled size={14} />
                Ready &nbsp;·&nbsp; {formatBytes((status as { type: 'ready'; sizeBytes: number }).sizeBytes)}
              </span>
              {!isSelected && (
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={onSelect}
                  className="wave-btn-select-model"
                >
                  Use for transcription
                </Button>
              )}
            </div>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={TrashCan}
              iconDescription="Delete model"
              onClick={onDelete}
              className="wave-btn-danger-ghost"
            >
              Delete
            </Button>
          </>
        )}

        {isDownloading && (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={StopFilled}
            onClick={onCancel}
            className="wave-btn-danger-ghost"
          >
            Cancel
          </Button>
        )}

        {!isReady && !isDownloading && !hasError && (
          <Button
            kind="primary"
            size="sm"
            renderIcon={Download}
            onClick={onDownload}
            className="wave-btn-accent"
          >
            {isPartial ? 'Resume Download' : 'Download'}
          </Button>
        )}

        {!isReady && !isDownloading && hasError && (
          <Button
            kind="primary"
            size="sm"
            renderIcon={Renew}
            onClick={onRetry}
            className="wave-btn-accent"
          >
            Retry
          </Button>
        )}

        {isPartial && !isDownloading && !hasError && (
          <span className="wave-model-card__partial-note">
            {formatBytes((status as { type: 'partial'; downloadedBytes: number }).downloadedBytes)} already downloaded
          </span>
        )}
      </div>
    </article>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface SettingsPageProps {
  models:          ModelInfo[];
  progress:        Record<string, DownloadProgress>;
  errors:          Record<string, string>;
  loading:         boolean;
  selectedModelId: string | null;
  onDownload:      (id: string) => void;
  onCancel:        (id: string) => void;
  onDelete:        (id: string) => void;
  onRetry:         (id: string) => void;
  onSelectModel:   (id: string) => void;
}

export function SettingsPage({
  models, progress, errors, loading, selectedModelId,
  onDownload, onCancel, onDelete, onRetry, onSelectModel,
}: SettingsPageProps) {
  return (
    <div className="wave-page">
      <div className="wave-page__header">
        <h1 className="wave-page__title">Settings</h1>
        <p className="wave-page__subtitle">
          Configure Wave — models, preferences, and storage
        </p>
      </div>

      {/* ── Local models section ──────────────────────────────────────── */}
      <div className="wave-settings-section">
        <div className="wave-settings-section__header">
          <h2 className="wave-settings-section__title">On-device Models</h2>
          <p className="wave-settings-section__desc">
            Local Whisper models — download once, run entirely on your Mac with no internet required.
          </p>
        </div>

        {loading ? (
          <InlineLoading description="Loading models…" status="active" />
        ) : (
          <div className="wave-model-grid">
            {models.map((info) => (
              <ModelCard
                key={info.id}
                info={info}
                prog={progress[info.id]}
                error={errors[info.id]}
                isSelected={info.id === selectedModelId}
                onDownload={() => onDownload(info.id)}
                onCancel={() => onCancel(info.id)}
                onDelete={() => onDelete(info.id)}
                onRetry={() => onRetry(info.id)}
                onSelect={() => onSelectModel(info.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
