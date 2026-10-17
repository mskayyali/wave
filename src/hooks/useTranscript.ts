import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { activity } from '../lib/activity';

export interface TranscriptWord {
  text:       string;
  startMs:    number;
  endMs:      number;
  confidence: number;
}

/** A TranscriptWord enriched with silence sentinels injected between long gaps. */
export interface EnrichedWord extends TranscriptWord {
  /** True for injected silence blocks (≥ threshold ms of silence between words). */
  isSilence: boolean;
  /** What transcription heard, when the word was corrected by hand (`text` is the correction). */
  correctedFrom?: string;
}

export interface Transcript {
  words:      TranscriptWord[];
  language:   string;
  durationMs: number;
}

/** `ready`: the project has finished transcribing; the transcript loads (again) when it turns true. */
export function useTranscript(projectId: string | null, ready = true) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !ready) {
      setTranscript(null);
      return;
    }
    setLoading(true);
    setError(null);
    invoke<Transcript | null>('get_transcript', { projectId })
      .then((t) => setTranscript(t ?? null))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectId, ready]);

  // Re-run forced alignment on this transcript (words unchanged, timings move).
  const realign = useCallback(async () => {
    if (!projectId) return;
    const aligned = await activity.track(
      { id: `realign:${projectId}`, label: 'Re-aligning words', doneLabel: 'Words re-aligned', projectId, quietMs: 500 },
      () => invoke<Transcript>('realign_transcript', { projectId }),
    );
    setTranscript(aligned);
  }, [projectId]);

  return { transcript, loading, error, realign };
}
