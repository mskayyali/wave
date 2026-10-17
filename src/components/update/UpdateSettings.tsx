import {
  Button, ContainedList, ContainedListItem, InlineLoading, ProgressBar, Toggle,
  preview__IconIndicator as IconIndicator,
} from '@carbon/react';
import { Renew, Restart, Upgrade } from '@carbon/icons-react';
import { useUpdater } from '../../hooks/useUpdater';
import { updater, type UpdateState } from '../../lib/updater';
import { downloadedText, statusText } from './updateText';

// Settings → Updates: the version, where updates stand, one action, and the
// switch for automatic checks. Laid out like the model rows above it.

type Indicator = { kind: string; label: string } | null;

function indicator(s: UpdateState): Indicator {
  switch (s.phase) {
    case 'current':     return { kind: 'succeeded', label: 'Up to date' };
    case 'available':   return { kind: 'informative', label: 'Update available' };
    case 'checking':    return { kind: 'in-progress', label: 'Checking' };
    case 'downloading':
    case 'installing':  return { kind: 'in-progress', label: 'Updating' };
    case 'ready':
    case 'restarting':  return { kind: 'pending', label: 'Installed' };
    case 'failed':      return { kind: 'failed', label: 'Failed' };
    default:            return null;
  }
}

function action(s: UpdateState) {
  switch (s.phase) {
    case 'idle':
    case 'current':
      return <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={() => void updater.check(true)}>Check now</Button>;
    case 'checking':
      return <InlineLoading status="active" description="Checking…" />;
    case 'available':
      return <Button kind="tertiary" size="sm" renderIcon={Upgrade} onClick={() => updater.openDialog()}>Update…</Button>;
    case 'ready':
      return s.waitingFor
        ? <Button kind="ghost" size="sm" onClick={() => updater.dontRestart()}>Don’t restart</Button>
        : <Button kind="tertiary" size="sm" renderIcon={Restart} onClick={() => void updater.restart()}>Restart Wave</Button>;
    case 'failed':
      return s.stage === 'check'
        ? <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={() => void updater.check(true)}>Try again</Button>
        : <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={() => void updater.install(false)}>Try again</Button>;
    default:
      return null;
  }
}

export function UpdateSettings() {
  const s = useUpdater();
  const status = indicator(s);
  const act = action(s);
  const busy = s.phase === 'downloading' || s.phase === 'installing';
  return (
    <section className="wave-settings-section">
      <header className="wave-settings-section__header">
        <h2 className="wave-settings-section__title">Updates</h2>
        <p className="wave-settings-section__desc">
          Wave updates itself with new versions from GitHub. It checks quietly, shows you what’s new, and never installs
          or restarts without asking.
        </p>
      </header>
      <ContainedList label="Wave" kind="on-page" className="wave-model-group">
        <ContainedListItem
          className={`wave-model-row wave-update-row${status || act ? '' : ' wave-update-row--bare'}`}
          action={
            <div className="wave-model-row__action">
              {status && <IconIndicator kind={status.kind} label={status.label} />}
              {act}
            </div>
          }
        >
          <div className="wave-model-row__body">
            <p className="wave-model-row__name">Version {s.current}</p>
            <p className="wave-model-row__summary">{statusText(s)}</p>
            {busy && (
              <ProgressBar
                size="small"
                label={s.phase === 'installing' ? 'Installing' : 'Downloading'}
                helperText={s.phase === 'installing' ? 'Almost done' : downloadedText(s)}
                value={s.phase === 'downloading' && s.total ? (100 * (s.received ?? 0)) / s.total : undefined}
                max={100}
              />
            )}
          </div>
        </ContainedListItem>
      </ContainedList>
      {s.phase !== 'unavailable' && (
        <Toggle
          id="wave-update-auto"
          className="wave-update__auto"
          labelText="Check for updates automatically"
          labelA="Off"
          labelB="On"
          toggled={s.auto}
          onToggle={(on: boolean) => updater.setAuto(on)}
        />
      )}
    </section>
  );
}
