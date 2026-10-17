import type { UnavailableReason, UpdateState } from '../../lib/updater';
import { megabytes } from '../../lib/updater';

// The words for each update state, shared by Settings, the dialog and the marks.

export function unavailableText(reason: UnavailableReason | undefined): string {
  switch (reason) {
    case 'dev':          return 'Updates are off while Wave runs from its source code.';
    case 'translocated': return 'Move Wave to your Applications folder to get updates. Until it’s moved, macOS runs it from a temporary copy that can’t be replaced.';
    case 'read-only':    return 'Wave is running from the disk image. Drag it to your Applications folder to get updates.';
    default:             return 'This copy of Wave was built on this Mac, so it doesn’t update itself.';
  }
}

/** When a check got its answer: "today at 14:02", "yesterday at 09:10", "3 October at 18:40". */
export function checkedWhen(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })} at ${time}`;
}

/** "20 October 2026", for when an update was published. */
export function releasedOn(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function downloadedText(s: UpdateState): string {
  if (!s.received) return 'Starting the download…';
  return s.total ? `${megabytes(s.received)} of ${megabytes(s.total)}` : `${megabytes(s.received)} so far`;
}

/** One sentence on where things stand, for Settings. */
export function statusText(s: UpdateState): string {
  switch (s.phase) {
    case 'idle':
      return s.auto ? 'Wave checks for updates on its own.' : 'Automatic checks are off.';
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return s.checkedAt ? `Wave is up to date. Checked ${checkedWhen(s.checkedAt)}.` : 'Wave is up to date.';
    case 'available':
      return `Version ${s.version} is available.`;
    case 'downloading':
      return s.total && s.received
        ? `Downloading version ${s.version}: ${Math.round((100 * s.received) / s.total)}%.`
        : `Downloading version ${s.version}…`;
    case 'installing':
      return `Installing version ${s.version}…`;
    case 'ready':
      return s.waitingFor
        ? `Version ${s.version} is installed. Wave restarts as soon as “${s.waitingFor}” finishes.`
        : `Version ${s.version} is installed. It starts when Wave restarts, or the next time you open it.`;
    case 'restarting':
      return 'Restarting…';
    case 'failed':
      return `${s.stage === 'check' ? 'Couldn’t check for updates.' : 'The update didn’t install.'} ${s.error ?? ''}`.trim();
    case 'unavailable':
      return unavailableText(s.reason);
  }
}
