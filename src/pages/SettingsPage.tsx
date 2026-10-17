// IconIndicator is Carbon's status indicator; this release ships it as a preview.
import {
  Button, ContainedList, ContainedListItem, IconButton, InlineLoading, InlineNotification, ProgressBar, Stack,
  preview__IconIndicator as IconIndicator,
} from '@carbon/react';
import { Download, Renew, StopFilled, TrashCan } from '@carbon/icons-react';
import {
  DPDFNET_MODEL_ID,
  SPEAKER_MODEL_ID,
  TRANSCRIPTION_BUNDLE,
  formatBytes,
  formatEta,
  formatSpeed,
  getCatalogEntry,
  type ModelBundle,
  type ModelCatalogEntry,
} from '../lib/modelCatalog';
import type { ModelInfo, DownloadProgress } from '../hooks/useModels';
import { ExternalLink } from '../components/editor/ToolCredit';
import { AgentAccess } from '../components/settings/AgentAccess';
import { UpdateSettings } from '../components/update/UpdateSettings';

// Settings: the downloads Wave needs, grouped the way the editor's Tools are
// (Clean up, Sound, People), one row each: what it does, its size and maker,
// its state and the one thing to do (download, cancel, retry or delete). A
// row is a bundle (several models fetched in sequence) or a single model.

const MB = 1024 * 1024;

/** One downloadable entry, a bundle or a single model. */
interface Entry {
  id:        string;
  name:      string;
  /** What it does, in a line. */
  summary:   string;
  provider?: ModelCatalogEntry['provider'];
  /** In download order; a single model is one part. */
  parts:     { modelId: string; role: string }[];
}

/** The one-line summaries, by entry id (bundle or model). */
const SUMMARIES: Record<string, string> = {
  transcription:           'Writes down what was said and places every word on its audio. Wave needs it to edit.',
  dpdfnet:                 'Removes background noise and room echo, keeping the voice as recorded.',
  'nemotron3-diarization': 'Works out who is speaking when, for up to 8 people, and names them in the transcript.',
};

function bundleEntry(bundle: ModelBundle): Entry {
  return { id: bundle.id, name: bundle.name, summary: SUMMARIES[bundle.id] ?? bundle.description, provider: bundle.provider, parts: bundle.parts };
}

function modelEntry(id: string): Entry | null {
  const meta = getCatalogEntry(id);
  if (!meta) return null;
  return { id, name: meta.name, summary: SUMMARIES[id] ?? meta.description, provider: meta.provider, parts: [{ modelId: id, role: meta.name }] };
}

// ─── Row ──────────────────────────────────────────────────────────────────────

interface ModelRowProps {
  entry:      Entry;
  models:     ModelInfo[];
  progress:   Record<string, DownloadProgress>;
  errors:     Record<string, string>;
  onDownload: () => void;
  onCancel:   () => void;
  onDelete:   () => void;
  onRetry:    () => void;
}

function ModelRow({ entry, models, progress, errors, onDownload, onCancel, onDelete, onRetry }: ModelRowProps) {
  const parts = entry.parts.map((part, index) => ({
    ...part,
    index,
    sizeMb: getCatalogEntry(part.modelId)?.sizeMb ?? 0,
    status: models.find((m) => m.id === part.modelId)?.status ?? { type: 'notDownloaded' as const },
    prog:   progress[part.modelId],
    error:  errors[part.modelId],
  }));
  const multi       = parts.length > 1;
  const totalMb     = parts.reduce((sum, p) => sum + p.sizeMb, 0);
  const allReady    = parts.every((p) => p.status.type === 'ready');
  const active      = parts.find((p) => p.status.type === 'downloading');
  const failed      = parts.find((p) => p.error);
  const started     = parts.some((p) => p.status.type === 'ready' || p.status.type === 'partial');
  const hasPartial  = parts.some((p) => p.status.type === 'partial');
  const remainingMb = parts.filter((p) => p.status.type !== 'ready').reduce((sum, p) => sum + p.sizeMb, 0);
  const readyBytes  = parts.reduce((sum, p) => sum + (p.status.type === 'ready' ? p.status.sizeBytes : 0), 0);

  const status = allReady ? { kind: 'succeeded', label: 'Ready' }
    : active   ? { kind: 'in-progress', label: 'Downloading' }
    : failed   ? { kind: 'failed', label: 'Failed' }
    : started  ? { kind: 'incomplete', label: `${formatBytes(remainingMb * MB)} to go` }
    :            null;

  const action = active
    ? <Button kind="ghost" size="sm" renderIcon={StopFilled} onClick={onCancel}>Cancel</Button>
    : allReady
      ? <IconButton kind="ghost" size="sm" label={`Delete ${entry.name}`} align="left" onClick={onDelete}><TrashCan /></IconButton>
      : failed
        ? <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={onRetry}>Retry</Button>
        : <Button kind="tertiary" size="sm" renderIcon={Download} onClick={onDownload}>{hasPartial || started ? 'Resume' : 'Download'}</Button>;

  return (
    <ContainedListItem
      className="wave-model-row"
      action={
        <div className="wave-model-row__action">
          {status && <IconIndicator kind={status.kind} label={status.label} />}
          {action}
        </div>
      }
    >
      <div className="wave-model-row__body">
        <p className="wave-model-row__name">{entry.name}</p>
        <p className="wave-model-row__summary">{entry.summary}</p>
        <p className="wave-model-row__meta">
          {formatBytes(allReady ? readyBytes : totalMb * MB)}
          {multi && <> · {parts.map((p) => p.role).join(' + ')}</>}
          {entry.provider && (
            <> · {entry.provider.name} · <ExternalLink href={entry.provider.licenseUrl}>{entry.provider.licenseName}</ExternalLink></>
          )}
        </p>
        {active && (active.prog ? (
          <ProgressBar
            size="small"
            value={active.prog.percentage}
            max={100}
            label={`${multi ? `${active.role} (${active.index + 1} of ${parts.length}) · ` : ''}${active.prog.resuming ? 'Resuming' : 'Downloading'}`}
            helperText={[
              `${formatBytes(active.prog.downloadedBytes)} of ${formatBytes(active.prog.totalBytes)}`,
              formatSpeed(active.prog.speedBps),
              formatEta(active.prog.etaSecs),
            ].filter(Boolean).join(' · ')}
          />
        ) : (
          <InlineLoading description={`${multi ? `${active.role}: ` : ''}connecting…`} status="active" />
        ))}
        {failed && (
          <InlineNotification kind="error" lowContrast hideCloseButton title={multi ? `${failed.role} failed` : 'Download failed'} subtitle={failed.error} />
        )}
      </div>
    </ContainedListItem>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface SettingsPageProps {
  models:           ModelInfo[];
  progress:         Record<string, DownloadProgress>;
  errors:           Record<string, string>;
  loading:          boolean;
  onDownload:       (id: string) => void;
  onCancel:         (id: string) => void;
  onDelete:         (id: string) => void;
  onRetry:          (id: string) => void;
  onDownloadBundle: (bundle: ModelBundle) => void;
  onCancelBundle:   (bundle: ModelBundle) => void;
  onDeleteBundle:   (bundle: ModelBundle) => void;
  onRetryBundle:    (bundle: ModelBundle) => void;
}

export function SettingsPage({
  models, progress, errors, loading,
  onDownload, onCancel, onDelete, onRetry,
  onDownloadBundle, onCancelBundle, onDeleteBundle, onRetryBundle,
}: SettingsPageProps) {
  const shared = { models, progress, errors };
  const bundleRow = (bundle: ModelBundle) => (
    <ModelRow
      key={bundle.id}
      entry={bundleEntry(bundle)}
      {...shared}
      onDownload={() => onDownloadBundle(bundle)}
      onCancel={() => onCancelBundle(bundle)}
      onDelete={() => onDeleteBundle(bundle)}
      onRetry={() => onRetryBundle(bundle)}
    />
  );
  const modelRow = (id: string) => {
    const entry = modelEntry(id);
    if (!entry || !models.some((m) => m.id === id)) return null;
    return (
      <ModelRow
        key={id}
        entry={entry}
        {...shared}
        onDownload={() => onDownload(id)}
        onCancel={() => onCancel(id)}
        onDelete={() => onDelete(id)}
        onRetry={() => onRetry(id)}
      />
    );
  };

  return (
    <div className="wave-page wave-settings">
      <div className="wave-page__header">
        <h1 className="wave-page__title">Settings</h1>
        <p className="wave-page__subtitle">
          Everything runs on your Mac. Download a model once; after that, no internet is needed.
        </p>
      </div>

      {loading ? (
        <InlineLoading description="Loading models…" status="active" />
      ) : (
        <Stack gap={9}>
          <section className="wave-settings-section">
            <header className="wave-settings-section__header">
              <h2 className="wave-settings-section__title">Models</h2>
              <p className="wave-settings-section__desc">
                Transcription is required. The rest are optional, and each runs only when you start it from the editor&apos;s Tools.
              </p>
            </header>
            <ContainedList label="Required" kind="on-page" className="wave-model-group">{bundleRow(TRANSCRIPTION_BUNDLE)}</ContainedList>
            <ContainedList label="Sound" kind="on-page" className="wave-model-group">
              {modelRow(DPDFNET_MODEL_ID)}
            </ContainedList>
            <ContainedList label="People" kind="on-page" className="wave-model-group">{modelRow(SPEAKER_MODEL_ID)}</ContainedList>
          </section>

          <section className="wave-settings-section">
            <header className="wave-settings-section__header">
              <h2 className="wave-settings-section__title">AI agents</h2>
              <p className="wave-settings-section__desc">
                Let Claude or ChatGPT edit with you: read transcripts, cut words, fix mishearings, remove fillers, tighten
                or add pauses, clean up and shape the sound, and export. Their edits appear live in the editor, marked with
                the agent&apos;s name, and undo like your own.
              </p>
            </header>
            <AgentAccess />
          </section>
          <UpdateSettings />
        </Stack>
      )}
    </div>
  );
}
