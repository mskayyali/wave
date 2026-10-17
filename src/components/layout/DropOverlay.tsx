import { DocumentAudio } from '@carbon/icons-react';

// Shown while files are dragged over the window (App listens for the drag).
// Dropping audio creates a project per file.

export function DropOverlay({ audio, other }: {
  /** Audio files being dragged. */
  audio: number;
  /** Other files being dragged (ignored on drop). */
  other: number;
}) {
  return (
    <div className={`wave-drop${audio === 0 ? ' wave-drop--none' : ''}`} aria-live="polite">
      <div className="wave-drop__frame">
        <DocumentAudio size={32} className="wave-drop__icon" />
        <p className="wave-drop__title">
          {audio === 0 ? 'Wave imports audio files'
            : audio === 1 ? 'Drop to create a project'
            : `Drop to create ${audio} projects`}
        </p>
        <p className="wave-drop__hint">
          {audio === 0 ? 'MP3, WAV, M4A, AAC, FLAC, OGG or AIFF'
            : other > 0 ? `${other} other file${other === 1 ? '' : 's'} will be skipped`
            : 'Each file is imported and transcribed'}
        </p>
      </div>
    </div>
  );
}
