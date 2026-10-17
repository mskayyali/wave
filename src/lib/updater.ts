import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { activity } from './activity';
import { APP_VERSION } from './appInfo';

// Updates. The updater plugin reads latest.json from the newest GitHub release,
// downloads the new Wave.app, checks its signature against the public key in
// tauri.conf.json, and swaps it in; the new version runs from the next start.
// scripts/release.sh publishes them.
//
// Nothing here interrupts. Wave checks on its own (10 s after it starts, then
// every 6 hours) and only marks what it finds: the version in the sidebar's
// footer, a quiet button in the editor's top bar, the Wave menu's item and
// Settings → Updates. The update dialog opens when someone asks. "Later" quiets
// those marks for a day; an installed update is used the next time Wave opens.
// A restart waits for jobs that would be cut short (a transcription, an export).
//
// The store lives outside React, like the activity store, so a download keeps
// going, and reporting, whichever screen is open.

export type UpdatePhase =
  | 'idle'         // not checked yet
  | 'checking'
  | 'current'      // up to date
  | 'available'    // a newer version is out
  | 'downloading'
  | 'installing'
  | 'ready'        // installed: used from the next start
  | 'restarting'
  | 'failed'       // the last step didn't work (`stage`, `error`)
  | 'unavailable'; // this copy can't update itself (`reason`)

/** Why this copy can't update itself. */
export type UnavailableReason = 'dev' | 'unsigned' | 'not-bundled' | 'translocated' | 'read-only';

export interface UpdateState {
  phase:       UpdatePhase;
  /** The version running now. */
  current:     string;
  /** The newer version, once one is found. */
  version?:    string;
  /** What's new in it (Markdown from the release). */
  notes?:      string;
  /** When it was published (ISO). */
  date?:       string;
  received?:   number;
  total?:      number;
  stage?:      'check' | 'download' | 'install' | 'restart';
  /** What went wrong, in plain words. */
  error?:      string;
  /** The last check was asked for (the menu, Settings), so its outcome is shown. */
  manual:      boolean;
  /** When a check last got an answer. */
  checkedAt?:  number;
  /** A restart is waiting for this job to finish (its label). */
  waitingFor?: string;
  reason?:     UnavailableReason;
  /** "Later" was chosen for this version: its marks stay quiet for a day. */
  snoozed:     boolean;
  /** Wave checks on its own. */
  auto:        boolean;
  /** The update dialog is open. */
  dialog:      boolean;
}

const CHECK_AFTER_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const LATER_MS       = 24 * 60 * 60_000;

const AUTO_KEY    = 'wave.update.auto';
const LATER_KEY   = 'wave.update.later';
const CHECKED_KEY = 'wave.update.checkedAt';
const RAN_KEY     = 'wave.update.version';

// ── Small helpers ──────────────────────────────────────────────────────────

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* a preference; it can go */ }
}

/** "Later" for `version`, if it's still in force. */
function snoozedFor(version: string): boolean {
  try {
    const later = JSON.parse(read(LATER_KEY) ?? 'null') as { version: string; until: number } | null;
    return !!later && later.version === version && Date.now() < later.until;
  } catch { return false; }
}

/** Whether version `a` is newer than `b` (x.y.z). */
export function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0)} MB`;
}

/** What went wrong, in words someone can act on. */
function plain(error: unknown, stage: NonNullable<UpdateState['stage']>): string {
  const text = String(error instanceof Error ? error.message : error);
  if (/signature/i.test(text)) {
    return 'The download’s signature didn’t match this copy of Wave, so it wasn’t installed.';
  }
  if (/dns|connect|network|offline|timed? ?out|unreachable|error sending request|certificate/i.test(text)) {
    return 'Wave couldn’t reach the update server. Check your internet connection and try again.';
  }
  if (/valid release json|404|not found|status code/i.test(text)) {
    return 'There’s no update information for this Mac on the server yet.';
  }
  if (/permission|denied|read-only|not permitted|authoriz/i.test(text)) {
    return 'Wave couldn’t replace itself where it is. Move it to your Applications folder and try again.';
  }
  return stage === 'check' ? `Checking failed: ${text}` : `It stopped with this error: ${text}`;
}

/** A background job a restart would cut short, by its label (or nothing). */
function busyWith(): string | undefined {
  const quick = /^(update|note|playback|waveform):/;
  return activity.getSnapshot().find((a) => a.state === 'running' && !quick.test(a.id))?.label;
}

// ── The store ──────────────────────────────────────────────────────────────

class Updater {
  private state: UpdateState = {
    phase:     'idle',
    current:   APP_VERSION,
    manual:    false,
    snoozed:   false,
    auto:      read(AUTO_KEY) !== 'off',
    dialog:    false,
    checkedAt: Number(read(CHECKED_KEY)) || undefined,
  };
  private listeners = new Set<() => void>();
  private update: Update | null = null;
  private checking: Promise<void> | null = null;
  private timer?: number;
  private started = false;
  /** Restart as soon as the update is installed (the dialog stayed open). */
  private restartWhenInstalled = false;
  private stopWaiting?: () => void;
  private menuLabel = '';

  // For useSyncExternalStore.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.state;

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
    this.syncMenu();
  }

  /** Once, from App: say what changed if Wave was just updated, then start checking. */
  async start() {
    if (this.started) return;
    this.started = true;

    const ran = read(RAN_KEY);
    write(RAN_KEY, APP_VERSION);
    if (ran && newer(APP_VERSION, ran)) activity.announce(`Updated to Wave ${APP_VERSION}`);

    const reason = await this.unsupported();
    if (reason) {
      this.set({ phase: 'unavailable', reason });
      return;
    }
    this.syncMenu();
    this.schedule();
  }

  private async unsupported(): Promise<UnavailableReason | undefined> {
    if (import.meta.env.DEV) return 'dev';
    try {
      const { reason } = await invoke<{ reason: UnavailableReason | null }>('update_support');
      return reason ?? undefined;
    } catch {
      return 'not-bundled';
    }
  }

  /** The next automatic check: 10 s from now, or when 6 hours have passed since the last. */
  private schedule() {
    window.clearTimeout(this.timer);
    if (!this.state.auto || this.state.phase === 'unavailable') return;
    const since = Date.now() - (this.state.checkedAt ?? 0);
    const wait = Math.max(CHECK_AFTER_MS, CHECK_EVERY_MS - since);
    this.timer = window.setTimeout(() => { void this.check(false).finally(() => this.schedule()); }, wait);
  }

  setAuto(on: boolean) {
    write(AUTO_KEY, on ? 'on' : 'off');
    this.set({ auto: on });
    this.schedule();
  }

  /** Look for a newer version. `manual`: someone asked, so the outcome is shown. */
  check(manual: boolean): Promise<void> {
    const { phase } = this.state;
    if (['unavailable', 'downloading', 'installing', 'ready', 'restarting'].includes(phase)) {
      return Promise.resolve();
    }
    if (this.checking) {
      if (manual) this.set({ manual: true });
      return this.checking;
    }
    const before = this.state;
    this.set({ phase: 'checking', manual, error: undefined, stage: undefined });
    this.checking = (async () => {
      try {
        const found = await check({ timeout: 30_000 });
        const checkedAt = Date.now();
        write(CHECKED_KEY, String(checkedAt));
        if (found) {
          void this.update?.close().catch(() => undefined);
          this.update = found;
          this.set({
            phase:   'available',
            version: found.version,
            notes:   found.body?.trim() || undefined,
            date:    found.date,
            snoozed: snoozedFor(found.version),
            checkedAt,
          });
        } else {
          this.set({ phase: 'current', version: undefined, notes: undefined, date: undefined, checkedAt });
        }
      } catch (error) {
        // A check nobody asked for fails quietly, and keeps an update it already found.
        if (!this.state.manual && before.phase === 'available') this.set({ phase: 'available' });
        else this.set({ phase: 'failed', stage: 'check', error: plain(error, 'check') });
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** Download and install the update found; restart after if `restart`. */
  async install(restart: boolean) {
    this.restartWhenInstalled = restart;
    const { phase } = this.state;
    if (phase === 'downloading' || phase === 'installing') return;
    if (phase === 'ready') {
      if (restart) await this.restart();
      return;
    }
    if (!this.update) {
      await this.check(true);
      if (!this.update) return;
    }

    const update = this.update;
    const version = update.version;
    const id = `update:${version}`;
    let received = 0;
    let total: number | undefined;
    let shownAt = 0;
    this.set({ phase: 'downloading', received: 0, total: undefined, error: undefined, stage: undefined, snoozed: false });
    activity.start({ id, label: `Downloading Wave ${version}`, doneLabel: `Wave ${version} is ready` });
    try {
      await update.download((event) => {
        if (event.event === 'Started') total = event.data.contentLength || undefined;
        if (event.event === 'Progress') received += event.data.chunkLength;
        // Ten updates a second is plenty for a progress bar.
        const now = Date.now();
        if (event.event !== 'Progress' || now - shownAt > 100) {
          shownAt = now;
          this.set({ received, total });
          activity.update(id, total ? received / total : null, total ? `${megabytes(received)} of ${megabytes(total)}` : megabytes(received));
        }
      });
      this.set({ phase: 'installing', received: total ?? received });
      activity.update(id, null, 'Installing');
      await update.install();
      activity.finish(id);
      this.set({ phase: 'ready' });
      if (this.restartWhenInstalled) await this.restart();
    } catch (error) {
      const stage = this.state.phase === 'installing' ? 'install' : 'download';
      const message = plain(error, stage);
      activity.finish(id, message);
      this.set({ phase: 'failed', stage, error: message });
    }
  }

  /** Restart into the installed update, once nothing would be cut short (or now, if `anyway`). */
  async restart(anyway = false) {
    if (this.state.phase !== 'ready') return;
    const busy = busyWith();
    if (busy && !anyway) {
      this.set({ waitingFor: busy });
      if (!this.stopWaiting) {
        this.stopWaiting = activity.subscribe(() => {
          const still = busyWith();
          if (!still) {
            this.dontRestart();
            void this.restart();
          } else if (still !== this.state.waitingFor) {
            this.set({ waitingFor: still });
          }
        });
      }
      return;
    }
    this.dontRestart();
    this.set({ phase: 'restarting', error: undefined, stage: undefined });
    try {
      await relaunch();
    } catch (error) {
      this.set({ phase: 'ready', stage: 'restart', error: plain(error, 'restart') });
    }
  }

  /** Stop waiting to restart (the update stays installed for the next start). */
  dontRestart() {
    this.stopWaiting?.();
    this.stopWaiting = undefined;
    if (this.state.waitingFor) this.set({ waitingFor: undefined });
  }

  /** "Later": quiet the marks for this version for a day; an installed one waits for the next start. */
  later() {
    const { version } = this.state;
    this.restartWhenInstalled = false;
    if (version) write(LATER_KEY, JSON.stringify({ version, until: Date.now() + LATER_MS }));
    this.set({ snoozed: true, dialog: false });
  }

  openDialog() { this.set({ dialog: true }); }

  /** Close the dialog. A download carries on, without restarting at the end. */
  closeDialog() {
    this.restartWhenInstalled = false;
    this.set({ dialog: false });
  }

  /** The Wave menu's updates item: open the dialog, checking first if there's nothing found yet. */
  fromMenu() {
    this.openDialog();
    if (['idle', 'current', 'failed'].includes(this.state.phase)) void this.check(true);
  }

  /** The menu item's name follows the update. */
  private syncMenu() {
    const { phase, version } = this.state;
    const label = phase === 'available' ? `Update to Wave ${version}…`
      : phase === 'downloading' || phase === 'installing' ? 'Updating Wave…'
      : phase === 'ready' || phase === 'restarting' ? 'Restart to Update'
      : 'Check for Updates…';
    if (label === this.menuLabel) return;
    this.menuLabel = label;
    invoke('set_update_menu_label', { label }).catch(() => undefined);
  }
}

export const updater = new Updater();
