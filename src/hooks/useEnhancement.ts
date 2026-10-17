import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { activity } from '../lib/activity';
import { useActivityDetail, useActivityEnd, useActivityProgress } from './useActivity';
import type { EqAmount } from '../lib/eq';

// Speech enhancement (src-tauri/src/enhance.rs): a clean-up with DPDFNet
// (Ceva) or none, then an EQ preset (the EQ tool), then the loudness target.
// A run writes an enhanced copy of the audio next to the original; the on/off
// switch picks which one plays and exports, and is saved with the project. A
// preview runs the same on 15 s first.

export type EnhanceLoudness = 'podcast' | 'streaming' | 'broadcast' | 'off';
/** The clean-up: DPDFNet or none. Runs saved by earlier versions may say
 *  'clear' or 'both' (Clear is no longer part of Wave); they still play. */
export type EnhanceModels   = 'none' | 'dpdfnet';

export interface EnhanceOptions {
  models:   EnhanceModels;
  loudness: EnhanceLoudness;
  /** How much of the clean-up to keep, 0–1 (the rest is the original). */
  strength: number;
  /** EQ preset id (lib/eq.ts), or 'off'. */
  eq:       string;
  eqAmount: EqAmount;
}

/** Which enhancement models are downloaded. */
export interface EnhanceModelsReady {
  dpdfnet: boolean;
}

/** 15 s through the chosen enhancement, and the same 15 s untouched (at the same loudness). */
export interface EnhancePreview {
  original: string;
  enhanced: string;
  startMs:  number;
  lengthMs: number;
}

export interface Enhancement {
  version:      number;
  /** What made it, e.g. `dpdfnet@dd6818d+eq:clearer`. */
  model:        string;
  file:         string;
  options:      EnhanceOptions;
  /** Playing and exporting the enhanced audio. */
  enabled:      boolean;
  durationMs:   number;
  /** Loudness of the enhanced audio before mastering (LUFS). */
  measuredLufs: number | null;
  truePeakDbfs: number | null;
  elapsedMs:    number;
  /** Absolute path of the enhanced audio. */
  audioPath:    string;
}

/** A DPDFNet clean-up, podcast loudness, the clean-up in full, no EQ. */
export const DEFAULT_ENHANCE_OPTIONS: EnhanceOptions = {
  models: 'dpdfnet', loudness: 'podcast', strength: 1, eq: 'off', eqAmount: 'medium',
};

export function sameOptions(a: EnhanceOptions, b: EnhanceOptions): boolean {
  return a.models === b.models && a.loudness === b.loudness && a.eq === b.eq
    && (a.eq === 'off' || a.eqAmount === b.eqAmount)
    && (a.models === 'none' || Math.abs(a.strength - b.strength) < 1e-3);
}

/** The model these options need is downloaded, and there's something to do.
 *  An earlier version's Clear run can't be run again. */
export function canRun(o: EnhanceOptions, ready: EnhanceModelsReady): boolean {
  switch (o.models) {
    case 'none':    return o.eq !== 'off' || o.loudness !== 'off';
    case 'dpdfnet': return ready.dpdfnet;
    default:        return false;
  }
}

/** The clean-up to start from: DPDFNet if it's downloaded, else none (the EQ
 *  and loudness still work). */
export function availableModels(ready: EnhanceModelsReady): EnhanceModels {
  return ready.dpdfnet ? 'dpdfnet' : 'none';
}

export function useEnhancement(projectId: string) {
  const [enhancement, setEnhancement] = useState<Enhancement | null>(null);
  /** The options the next run will use; start from the last run's. */
  const [draft,    setDraft]    = useState<EnhanceOptions>(DEFAULT_ENHANCE_OPTIONS);
  const [error,    setError]    = useState<string | null>(null);
  const enhancementRef = useRef(enhancement);
  enhancementRef.current = enhancement;
  const job = `enhance:${projectId}`;

  const load = useCallback(() => invoke<Enhancement | null>('get_enhancement', { projectId }), [projectId]);
  const apply = useCallback((e: Enhancement | null) => {
    setEnhancement(e);
    if (e) setDraft(e.options);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEnhancement(null);
    setDraft(DEFAULT_ENHANCE_OPTIONS);
    load()
      .then((e) => { if (!cancelled) apply(e); })
      .catch((e) => console.warn('Could not load the enhancement:', e));
    return () => { cancelled = true; };
  }, [load, apply]);

  const cancel = useCallback(() => {
    invoke('cancel_enhance', { projectId }).catch(() => undefined);
  }, [projectId]);

  // A run is an activity: it carries on if the editor is closed, and the
  // editor open when it ends loads the result.
  const running = useActivityEnd(job, (failed) => {
    if (failed) setError(failed);
    else load().then(apply).catch((e) => console.warn('Could not load the enhancement:', e));
  });
  const progress = useActivityProgress(job);
  /** The step it's on ("Cleaning up speech"). */
  const step     = useActivityDetail(job);

  /** Run with `options` (they become the draft), e.g. an agent's. */
  const runWith = useCallback((options: EnhanceOptions) => {
    setDraft(options);
    setError(null);
    activity.track(
      { id: job, label: 'Enhancing speech', doneLabel: 'Speech enhanced', projectId, cancel },
      () => invoke('enhance_audio', { projectId, options }),
    ).catch(() => undefined); // the outcome arrives through useActivityEnd (a cancel is no error)
  }, [job, projectId, cancel]);
  const run = useCallback(() => runWith(draft), [runWith, draft]);

  /** Switch between the enhanced and the original audio (saved). */
  const setEnabled = useCallback((enabled: boolean) => {
    const current = enhancementRef.current;
    if (!current || current.enabled === enabled) return;
    setEnhancement({ ...current, enabled });
    invoke('set_enhancement_enabled', { projectId, enabled })
      .catch((e) => console.warn('Could not save the enhancement switch:', e));
  }, [projectId]);

  /** The draft's enhancement on 15 s from `startMs`, for listening first. */
  const preview = useCallback(
    (startMs: number) => invoke<EnhancePreview>('preview_enhancement', { projectId, startMs, lengthMs: 15_000, options: draft }),
    [projectId, draft],
  );

  /** Delete the enhanced audio. */
  const remove = useCallback(async () => {
    try {
      await invoke('remove_enhancement', { projectId });
      setEnhancement(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  return { enhancement, draft, setDraft, running, step, progress, error, run, runWith, cancel, setEnabled, remove, preview };
}
