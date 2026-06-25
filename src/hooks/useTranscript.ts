import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

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
}

export interface Transcript {
  words:      TranscriptWord[];
  language:   string;
  durationMs: number;
}

export function useTranscript(projectId: string | null) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setTranscript(null);
      return;
    }
    setLoading(true);
    setError(null);
    invoke<Transcript | null>('get_transcript', { projectId })
      .then((t) => setTranscript(t ?? null))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectId]);

  return { transcript, loading, error };
}
