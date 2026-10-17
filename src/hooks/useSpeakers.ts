import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { activity } from '../lib/activity';
import type { SpeakerSegment } from '../lib/speakers';
import { useActivityEnd, useActivityProgress } from './useActivity';

// Speaker detection (Nemotron 3 Diarization; see src-tauri/src/speakers.rs).
// Detection runs once and is saved with the project; names and visibility are
// edited here and saved alongside.

export interface Speaker {
  id:     number;
  name:   string;
  talkMs: number;
  /** Merged into another speaker (its id); the detection itself is kept. */
  mergedInto?: number | null;
}

export interface SpeakerSettings {
  /** Show speakers in the transcript and exports. */
  show: boolean;
}

export interface SpeakerAnalysis {
  version:    number;
  model:      string;
  durationMs: number;
  speakers:   Speaker[];
  segments:   SpeakerSegment[];
  settings:   SpeakerSettings;
}

export function useSpeakers(projectId: string) {
  const [analysis, setAnalysis] = useState<SpeakerAnalysis | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const analysisRef = useRef(analysis);
  analysisRef.current = analysis;
  const job = `speakers:${projectId}`;

  const load = useCallback(() => invoke<SpeakerAnalysis | null>('get_speakers', { projectId }), [projectId]);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    load()
      .then((a) => { if (!cancelled) setAnalysis(a); })
      .catch((e) => console.warn('Could not load speakers:', e));
    return () => { cancelled = true; };
  }, [load]);

  // Detection is an activity: it carries on if the editor is closed, and the
  // editor open when it ends loads what it saved.
  const running = useActivityEnd(job, (failed) => {
    if (failed) setError(failed);
    else load().then(setAnalysis).catch((e) => console.warn('Could not load speakers:', e));
  });
  const progress = useActivityProgress(job);

  const detect = useCallback(() => {
    setError(null);
    activity.track(
      { id: job, label: 'Detecting speakers', doneLabel: 'Speakers detected', projectId },
      () => invoke('detect_speakers', { projectId }),
    ).catch(() => undefined); // the outcome arrives through useActivityEnd
  }, [job, projectId]);

  const save = useCallback((next: SpeakerAnalysis) => {
    setAnalysis(next);
    invoke('save_speakers', { projectId, speakers: next.speakers, settings: next.settings })
      .catch((e) => console.warn('Could not save speakers:', e));
  }, [projectId]);

  /** Rename a speaker (an empty name goes back to "Speaker N"). */
  const rename = useCallback((id: number, name: string) => {
    const current = analysisRef.current;
    if (!current) return;
    const trimmed = name.trim() || `Speaker ${id + 1}`;
    if (current.speakers.find((s) => s.id === id)?.name === trimmed) return;
    save({ ...current, speakers: current.speakers.map((s) => (s.id === id ? { ...s, name: trimmed } : s)) });
  }, [save]);

  const setShow = useCallback((show: boolean) => {
    const current = analysisRef.current;
    if (current) save({ ...current, settings: { ...current.settings, show } });
  }, [save]);

  /** Count `from`'s words as `into`'s (and anyone already merged into `from`). */
  const merge = useCallback((from: number, into: number) => {
    const current = analysisRef.current;
    if (!current || from === into) return;
    save({
      ...current,
      speakers: current.speakers.map((s) => (s.id === from || s.mergedInto === from ? { ...s, mergedInto: into } : s)),
    });
  }, [save]);

  /** Make a merged speaker separate again. */
  const unmerge = useCallback((id: number) => {
    const current = analysisRef.current;
    if (!current) return;
    save({ ...current, speakers: current.speakers.map((s) => (s.id === id ? { ...s, mergedInto: null } : s)) });
  }, [save]);

  return { analysis, running, progress, error, detect, rename, setShow, merge, unmerge };
}
