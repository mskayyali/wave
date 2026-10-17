import { Button, ProgressBar } from '@carbon/react';
import { Renew, WarningAltFilled } from '@carbon/icons-react';
import type { Project } from '../../hooks/useProjects';
import { useActivityDetail, useActivityProgress } from '../../hooks/useActivity';

// The editor before there's a transcript to edit: importing or transcribing
// (with live progress; the text fills in when it's done), never transcribed,
// failed, or unreadable. Each one says what's happening or what to do.

export function ProjectStatus({ project, loadError, onRetry }: {
  project:   Project;
  /** The transcript file couldn't be read. */
  loadError: string | null;
  /** Transcribe (again), or import again when the audio never made it. */
  onRetry:   () => void;
}) {
  const status = project.status;
  const job = status.type === 'importing' ? `import:${project.id}` : `transcribe:${project.id}`;
  const progress = useActivityProgress(job);
  const step = useActivityDetail(job);
  const imported = Boolean(project.durationSecs);

  if (status.type === 'importing' || status.type === 'transcribing') {
    const importing = status.type === 'importing';
    return (
      <div className="wave-project-status">
        <h2 className="wave-project-status__title">{importing ? 'Importing the audio' : 'Transcribing'}</h2>
        <ProgressBar
          label={step ?? (importing ? 'Reading the file' : 'Writing down the words')}
          helperText={progress > 0 ? `${Math.round(progress * 100)}%` : undefined}
          value={progress > 0 ? progress * 100 : undefined}
          max={100}
          size="small"
          className="wave-project-status__progress"
        />
        <p className="wave-project-status__body">
          The transcript appears here as soon as it&apos;s ready. You can leave this page; it carries on.
        </p>
      </div>
    );
  }

  const content = status.type === 'error'
    ? { title: 'Something went wrong', body: status.message, action: imported ? 'Transcribe again' : 'Import again…' }
    : status.type === 'readyToTranscribe'
    ? { title: 'Not transcribed yet', body: 'The audio is imported. Transcribe it to start editing.', action: 'Transcribe' }
    : status.type === 'empty'
    ? { title: 'No audio yet', body: 'This project has no recording.', action: 'Import audio…' }
    : { title: 'The transcript couldn’t be read', body: loadError ?? 'The transcript file is missing.', action: 'Transcribe again' };

  return (
    <div className="wave-project-status">
      {status.type === 'error' && <WarningAltFilled size={24} className="wave-project-status__icon" />}
      <h2 className="wave-project-status__title">{content.title}</h2>
      <p className="wave-project-status__body">{content.body}</p>
      <Button kind="primary" size="sm" className="wave-btn-accent" renderIcon={Renew} onClick={onRetry}>{content.action}</Button>
    </div>
  );
}
