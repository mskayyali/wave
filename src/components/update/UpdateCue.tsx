import { IconButton } from '@carbon/react';
import { Upgrade } from '@carbon/icons-react';
import { useUpdater } from '../../hooks/useUpdater';
import { updater } from '../../lib/updater';

// The quiet marks of an update: in the sidebar's footer the version becomes
// "1.1.0 available" (or "Update ready"), and the editor's top bar gets a small
// button with a dot. Both open the update dialog; neither shows until there's
// something to do, and "Later" quiets them for a day.

export function UpdateCue({ placement }: { placement: 'sidebar' | 'toolbar' }) {
  const s = useUpdater();
  const due = !s.snoozed && (s.phase === 'available' || s.phase === 'ready');
  const ready = s.phase === 'ready';

  if (placement === 'sidebar') {
    if (!due) return <span className="wave-sidebar__version">v{s.current}</span>;
    return (
      <button
        type="button"
        className="wave-update-cue"
        title={ready ? `Open the update to restart into Wave ${s.version}` : `See what’s new in Wave ${s.version}`}
        onClick={() => updater.openDialog()}
      >
        {ready ? 'Update ready' : `${s.version} available`}
      </button>
    );
  }

  if (!due) return null;
  return (
    <IconButton
      kind="ghost"
      size="sm"
      align="bottom-end"
      className="wave-update-cue--toolbar"
      label={ready ? `Wave ${s.version} is installed. Restart to use it.` : `Wave ${s.version} is available`}
      onClick={() => updater.openDialog()}
    >
      <Upgrade />
    </IconButton>
  );
}
