import { Button, InlineLoading, InlineNotification, Modal, ProgressBar } from '@carbon/react';
import { useUpdater } from '../../hooks/useUpdater';
import { updater, type UpdateState } from '../../lib/updater';
import { ExternalLink } from '../editor/ToolCredit';
import { downloadedText, releasedOn, unavailableText } from './updateText';

// The update dialog, opened from the sidebar's mark, the editor's top bar, the
// Wave menu or Settings, never by itself. It follows the update along: what's
// new and Update and restart or Later; the download, which can carry on in the
// background; Restart now or Later once it's installed; waiting for a running
// job before restarting; and what went wrong.

const WEBSITE = 'https://mskayyali.github.io/wave/';

/** The release notes: paragraphs, and lines starting with "- " as a list. */
function Notes({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map((block) => block.split('\n').filter((line) => line.trim()));
  return (
    <div className="wave-update__notes">
      {blocks.map((lines, i) =>
        lines.every((line) => /^\s*[-*] /.test(line)) ? (
          <ul key={i}>{lines.map((line, j) => <li key={j}>{line.replace(/^\s*[-*] /, '')}</li>)}</ul>
        ) : (
          <p key={i}>{lines.map((line) => line.replace(/^#+\s*/, '')).join(' ')}</p>
        ),
      )}
    </div>
  );
}

interface View {
  heading:    string;
  body:       React.ReactNode;
  primary?:   string;
  onPrimary?: () => void;
  secondary?: string;
  onSecondary?: () => void;
  danger?:    boolean;
}

function view(s: UpdateState): View {
  const close = () => updater.closeDialog();
  switch (s.phase) {
    case 'idle':
    case 'checking':
      return {
        heading: 'Checking for updates',
        body: <InlineLoading status="active" description="Looking for a newer version of Wave…" />,
      };

    case 'current':
      return {
        heading: 'Wave is up to date',
        body: <p>You have version {s.current}, the newest there is.</p>,
        primary: 'Done', onPrimary: close,
      };

    case 'available': {
      const released = releasedOn(s.date);
      return {
        heading: `Wave ${s.version} is available`,
        body: (
          <>
            <p>You have version {s.current}.{released && ` This one came out on ${released}.`}</p>
            {s.notes && <Notes text={s.notes} />}
            <p className="wave-update__aside">
              Wave restarts once the update is installed. Your edits are saved as you make them.
            </p>
          </>
        ),
        primary: 'Update and restart', onPrimary: () => void updater.install(true),
        secondary: 'Later', onSecondary: () => updater.later(),
      };
    }

    case 'downloading':
    case 'installing': {
      const installing = s.phase === 'installing';
      return {
        heading: `Updating to Wave ${s.version}`,
        body: (
          <>
            <ProgressBar
              label={installing ? 'Installing' : 'Downloading'}
              helperText={installing ? 'Almost done' : downloadedText(s)}
              value={!installing && s.total ? (100 * (s.received ?? 0)) / s.total : undefined}
              max={100}
            />
            <p className="wave-update__aside">
              Wave restarts once it’s installed. Or let it finish in the background, and restart when it suits you.
            </p>
            <Button kind="ghost" size="sm" onClick={close}>Continue in the background</Button>
          </>
        ),
      };
    }

    case 'ready':
      if (s.waitingFor) {
        return {
          heading: 'Waiting to restart',
          body: (
            <p>
              “{s.waitingFor}” is still running. Wave restarts as soon as it finishes, so it isn’t cut short.
            </p>
          ),
          primary: 'Restart now anyway', onPrimary: () => void updater.restart(true), danger: true,
          secondary: 'Don’t restart', onSecondary: () => updater.dontRestart(),
        };
      }
      return {
        heading: `Wave ${s.version} is ready`,
        body: (
          <>
            <p>Restart Wave to start using it. Your edits are saved.</p>
            <p className="wave-update__aside">If you’d rather not now, it starts the next time you open Wave.</p>
            {s.stage === 'restart' && s.error && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Wave couldn’t restart" subtitle={s.error} />
            )}
          </>
        ),
        primary: 'Restart now', onPrimary: () => void updater.restart(),
        secondary: 'Later', onSecondary: () => updater.later(),
      };

    case 'restarting':
      return {
        heading: 'Restarting Wave',
        body: <InlineLoading status="active" description="Opening the new version…" />,
      };

    case 'failed':
      if (s.stage === 'check') {
        return {
          heading: 'Couldn’t check for updates',
          body: <p>{s.error}</p>,
          primary: 'Try again', onPrimary: () => void updater.check(true),
          secondary: 'Close', onSecondary: close,
        };
      }
      return {
        heading: 'Wave couldn’t update',
        body: (
          <>
            <p>{s.error}</p>
            <p className="wave-update__aside">
              You can also download the newest version from the <ExternalLink href={WEBSITE}>Wave website</ExternalLink>.
            </p>
          </>
        ),
        primary: 'Try again', onPrimary: () => void updater.install(true),
        secondary: 'Close', onSecondary: close,
      };

    case 'unavailable':
      return {
        heading: 'Updates aren’t available here',
        body: <p>{unavailableText(s.reason)}</p>,
        primary: 'Done', onPrimary: close,
      };
  }
}

export function UpdateDialog() {
  const s = useUpdater();
  const v = view(s);
  const passive = !v.primary;
  return (
    <Modal
      open={s.dialog}
      size="sm"
      className="wave-update"
      modalHeading={v.heading}
      passiveModal={passive}
      danger={v.danger}
      primaryButtonText={v.primary}
      secondaryButtonText={v.secondary}
      onRequestSubmit={v.onPrimary}
      onSecondarySubmit={v.onSecondary}
      onRequestClose={() => updater.closeDialog()}
    >
      <div className="wave-update__body">{v.body}</div>
    </Modal>
  );
}
