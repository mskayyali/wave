// What Wave is doing in the background (imports, transcription, model
// downloads, the AI tools, exports), in one place, so a long job shows wherever
// you are and not only in the panel that started it. ActivityStatus draws it
// in the sidebar and the editor's top bar; useActivityEvents feeds it from the
// backend's events and mirrors it on the Dock icon.
//
// Jobs the backend announces (import, transcription, downloads) are followed
// from their events. The rest are started with `track` around their invoke.
// The store lives outside React, so a job keeps reporting after the editor
// that started it is closed.

export type ActivityState = 'running' | 'done' | 'error';

export interface ActivitySpec {
  /** One job per id: `speakers:<projectId>`, `download:<bundleOrModelId>`… */
  id:         string;
  /** What it's doing: "Detecting speakers". */
  label:      string;
  /** Shown for a few seconds once it's done ("Speakers detected"). Without one, it just goes. */
  doneLabel?: string;
  /** The project it works on (its name is shown). */
  projectId?: string;
  /** Or what it works on, named directly. */
  subject?:   string;
  /** Show it only once it has run this long, so quick jobs don't flicker. */
  quietMs?:   number;
  /** Stops it (offered as Cancel). */
  cancel?:    () => void;
}

export interface Activity extends ActivitySpec {
  state:     ActivityState;
  /** 0–1, or null when there's no telling. */
  progress:  number | null;
  /** The current step: "Aligning words", "120 MB of 1.5 GB". */
  detail?:   string;
  error?:    string;
  startedAt: number;
  /** Past its quiet period (or failed): drawn by ActivityStatus. */
  shown:     boolean;
}

/** How long a finished job stays, with its done label. */
const DONE_MS = 4000;

class ActivityStore {
  private items     = new Map<string, Activity>();
  private timers    = new Map<string, number>();
  private running   = new Map<string, Promise<unknown>>();
  private names     = new Map<string, string>();
  private listeners = new Set<() => void>();
  private snapshot: Activity[] = [];

  // ── For useSyncExternalStore ───────────────────────────────────────────────
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  get = (id: string) => this.items.get(id);

  /** Project names, for the projects jobs work on. */
  setProjectNames(names: Map<string, string>) {
    this.names = names;
    this.publish();
  }

  start(spec: ActivitySpec) {
    this.clearTimer(spec.id);
    const quiet = (spec.quietMs ?? 0) > 0;
    this.items.set(spec.id, { ...spec, state: 'running', progress: null, startedAt: Date.now(), shown: !quiet });
    if (quiet) this.later(spec.id, spec.quietMs!, () => this.patch(spec.id, { shown: true }));
    this.publish();
  }

  /** Progress (0–1, or null for unknown) and, optionally, the current step. */
  update(id: string, progress: number | null, detail?: string) {
    const a = this.items.get(id);
    if (!a || a.state !== 'running') return;
    // A finish pending for a bundle part is called off by the next part's progress.
    this.clearTimer(id, 'finish');
    const p = progress === null ? null : Math.max(0, Math.min(1, progress));
    if (a.progress === p && (detail === undefined || detail === a.detail)) return;
    this.patch(id, { progress: p, detail: detail ?? a.detail });
  }

  /** Done, or failed with `error`. A cancelled job (an error that says so) just goes. */
  finish(id: string, error?: unknown) {
    const a = this.items.get(id);
    if (!a) return;
    this.clearTimer(id);
    if (error !== undefined) {
      const message = String(error);
      if (/^cancel/i.test(message)) return this.dismiss(id);
      // Errors stay until dismissed, even for a quiet job.
      this.patch(id, { state: 'error', error: message, shown: true });
    } else if (a.doneLabel && a.shown) {
      this.patch(id, { state: 'done', progress: 1, detail: undefined });
      this.later(id, DONE_MS, () => this.dismiss(id));
    } else {
      this.dismiss(id);
    }
  }

  /** Finish after `ms` unless more progress comes first (a bundle's next part). */
  finishSoon(id: string, ms: number) {
    if (!this.items.has(id)) return;
    this.later(id, ms, () => this.finish(id), 'finish');
  }

  /** Something that just happened, shown for a moment like a finished job. */
  announce(label: string, projectId?: string) {
    const id = `note:${Date.now()}:${Math.random()}`;
    this.start({ id, label, doneLabel: label, projectId });
    this.finish(id);
  }

  dismiss(id: string) {
    this.clearTimer(id);
    if (this.items.delete(id)) this.publish();
  }

  /**
   * Run `job` as an activity. While one with this id runs, a second call gets
   * the same promise instead of starting another.
   */
  track<T>(spec: ActivitySpec, job: () => Promise<T>): Promise<T> {
    const existing = this.running.get(spec.id);
    if (existing) return existing as Promise<T>;
    this.start(spec);
    const promise = job().then(
      (value) => { this.running.delete(spec.id); this.finish(spec.id); return value; },
      (error) => { this.running.delete(spec.id); this.finish(spec.id, error); throw error; },
    );
    this.running.set(spec.id, promise);
    return promise;
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  private patch(id: string, change: Partial<Activity>) {
    const a = this.items.get(id);
    if (!a) return;
    this.items.set(id, { ...a, ...change });
    this.publish();
  }

  private later(id: string, ms: number, fn: () => void, slot = '') {
    this.clearTimer(id, slot);
    this.timers.set(id + slot, window.setTimeout(() => { this.timers.delete(id + slot); fn(); }, ms));
  }

  private clearTimer(id: string, slot = '') {
    const t = this.timers.get(id + slot);
    if (t !== undefined) { window.clearTimeout(t); this.timers.delete(id + slot); }
    if (slot === '') this.clearTimer(id, 'finish');
  }

  private publish() {
    this.snapshot = [...this.items.values()].map((a) =>
      a.projectId && !a.subject ? { ...a, subject: this.names.get(a.projectId) } : a);
    this.listeners.forEach((l) => l());
  }
}

export const activity = new ActivityStore();
