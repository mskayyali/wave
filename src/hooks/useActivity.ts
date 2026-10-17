import { useEffect, useRef, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';
import { activity, type Activity, type ActivitySpec } from '../lib/activity';
import { MODEL_BUNDLES, formatBytes, getCatalogEntry } from '../lib/modelCatalog';
import type { DownloadProgress, ModelError } from './useModels';
import type { Project } from './useProjects';

// The activity store (lib/activity.ts) in React, and the backend events that
// feed it. useActivityEvents runs once, in App.

/** Every job, for ActivityStatus. */
export function useActivities(): Activity[] {
  return useSyncExternalStore(activity.subscribe, activity.getSnapshot);
}

/** Whether a job is running; re-renders only when that changes, not on progress. */
export function useActivityRunning(id: string): boolean {
  return useSyncExternalStore(activity.subscribe, () => activity.get(id)?.state === 'running');
}

/** A job's progress, 0–1 (0 while unknown or not running). */
export function useActivityProgress(id: string): number {
  return useSyncExternalStore(activity.subscribe, () => activity.get(id)?.progress ?? 0);
}

/** A job's current step ("Cleaning up speech"). */
export function useActivityDetail(id: string): string | undefined {
  return useSyncExternalStore(activity.subscribe, () => activity.get(id)?.detail);
}

/**
 * Whether a job is running, and `onEnd` when it stops: with its error if it
 * failed, without one if it finished or was cancelled. A job outlives the
 * editor that started it, so whichever editor is open when it ends picks up
 * the result (by loading what the job saved).
 */
export function useActivityEnd(id: string, onEnd: (error: string | undefined) => void): boolean {
  const running = useActivityRunning(id);
  const wasRunning = useRef(running);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  useEffect(() => {
    if (wasRunning.current && !running) {
      const a = activity.get(id);
      onEndRef.current(a?.state === 'error' ? a.error : undefined);
    }
    wasRunning.current = running;
  }, [id, running]);
  return running;
}

/** Transcription's steps, from the backend's percentages (transcription.rs). */
function transcribeStep(pct: number): string | undefined {
  if (pct < 10)  return 'Loading the model';
  if (pct <= 90) return undefined;
  if (pct < 95)  return 'Placing each word';
  return 'Saving';
}

const ENHANCE_STEPS: Record<string, string> = {
  decoding:  'Reading the audio',
  enhancing: 'Cleaning up speech',
  mastering: 'Setting the loudness',
};

/** A bundle's parts download one after another as one job. */
function downloadOf(modelId: string) {
  const bundle = MODEL_BUNDLES.find((b) => b.parts.some((p) => p.modelId === modelId));
  const name   = bundle?.name ?? getCatalogEntry(modelId)?.name ?? modelId;
  return {
    id:     `download:${bundle?.id ?? modelId}`,
    name,
    part:   bundle?.parts.find((p) => p.modelId === modelId)?.role,
    bundle: bundle !== undefined,
  };
}

/** The Dock icon's progress bar: the jobs that can tell how far along they are. */
let dockKey = '';
function updateDock(items: Activity[]) {
  const measured = items.filter((a) => a.state === 'running' && a.shown && a.progress !== null);
  const progress = measured.length > 0
    ? Math.round((100 * measured.reduce((sum, a) => sum + a.progress!, 0)) / measured.length)
    : null;
  const key = progress === null ? 'none' : String(progress);
  if (key === dockKey) return;
  dockKey = key;
  try {
    void getCurrentWindow()
      .setProgressBar(progress === null ? { status: ProgressBarStatus.None } : { status: ProgressBarStatus.Normal, progress })
      .catch(() => undefined);
  } catch { /* not running in Tauri (a browser preview) */ }
}

export function useActivityEvents(projects: Project[]) {
  useEffect(() => {
    activity.setProjectNames(new Map(projects.map((p) => [p.id, p.name])));
  }, [projects]);

  useEffect(() => activity.subscribe(() => updateDock(activity.getSnapshot())), []);

  useEffect(() => {
    /** Start the job if this is its first event. */
    const ensure = (id: string, spec: () => Omit<ActivitySpec, 'id'>) => {
      if (activity.get(id)?.state !== 'running') activity.start({ id, ...spec() });
    };
    // The model a download job is fetching now (a bundle moves on to its next part).
    const downloading = new Map<string, string>();

    const subscriptions = [
      // ── Import ───────────────────────────────────────────────────────────────
      listen<{ projectId: string; percentage: number }>('project:import_progress', ({ payload }) => {
        const id = `import:${payload.projectId}`;
        ensure(id, () => ({ label: 'Importing audio', projectId: payload.projectId }));
        activity.update(id, payload.percentage / 100);
      }),
      listen<{ project: Project }>('project:import_complete', ({ payload }) => activity.finish(`import:${payload.project.id}`)),
      listen<{ projectId: string; message: string }>('project:import_error', ({ payload }) =>
        activity.finish(`import:${payload.projectId}`, payload.message)),

      // ── Transcription ────────────────────────────────────────────────────────
      listen<{ projectId: string; percentage: number }>('transcription:progress', ({ payload }) => {
        const id = `transcribe:${payload.projectId}`;
        if (payload.percentage >= 100) return; // complete follows
        ensure(id, () => ({ label: 'Transcribing', doneLabel: 'Transcript ready', projectId: payload.projectId }));
        activity.update(id, payload.percentage / 100, transcribeStep(payload.percentage));
      }),
      listen<{ projectId: string }>('transcription:complete', ({ payload }) => activity.finish(`transcribe:${payload.projectId}`)),
      listen<{ projectId: string; message: string }>('transcription:error', ({ payload }) =>
        activity.finish(`transcribe:${payload.projectId}`, payload.message)),

      // ── Model downloads ──────────────────────────────────────────────────────
      listen<DownloadProgress>('model:progress', ({ payload }) => {
        const d = downloadOf(payload.modelId);
        downloading.set(d.id, payload.modelId);
        ensure(d.id, () => ({
          label:     `Downloading ${d.name}`,
          doneLabel: `${d.name} downloaded`,
          cancel:    () => {
            const modelId = downloading.get(d.id);
            if (modelId) invoke('cancel_model_download', { modelId }).catch(() => undefined);
          },
        }));
        const amount = payload.totalBytes > 0
          ? `${formatBytes(payload.downloadedBytes)} of ${formatBytes(payload.totalBytes)}`
          : formatBytes(payload.downloadedBytes);
        activity.update(d.id, payload.percentage / 100, d.part ? `${d.part} · ${amount}` : amount);
      }),
      listen<string>('model:complete', ({ payload: modelId }) => {
        const d = downloadOf(modelId);
        // A bundle's next part may follow; its first progress calls this off.
        if (d.bundle) activity.finishSoon(d.id, 3000);
        else activity.finish(d.id);
      }),
      listen<string>('model:cancelled', ({ payload: modelId }) => activity.dismiss(downloadOf(modelId).id)),
      listen<ModelError>('model:error', ({ payload }) => activity.finish(downloadOf(payload.modelId).id, payload.message)),

      // ── The AI tools: started with `track`, progress from here ───────────────
      listen<{ projectId: string; progress: number }>('speakers:progress', ({ payload }) =>
        activity.update(`speakers:${payload.projectId}`, payload.progress)),
      listen<{ projectId: string; phase: string; progress: number }>('enhance:progress', ({ payload }) =>
        activity.update(`enhance:${payload.projectId}`, payload.progress, ENHANCE_STEPS[payload.phase])),
      // Audio export: reading the audio, then writing the file.
      listen<{ projectId: string; phase: string; format: string; progress: number }>('export:progress', ({ payload }) =>
        activity.update(`export:${payload.projectId}`, payload.progress,
          payload.phase === 'reading' ? 'Reading the audio'
            : payload.format === 'WAV' ? 'Writing WAV' : `Encoding ${payload.format}`)),
    ];
    return () => subscriptions.forEach((s) => void s.then((unlisten) => unlisten()));
  }, []);
}
