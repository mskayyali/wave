// Frontend-only metadata for all known Whisper models.
// The Rust side only knows ids and filenames — rich display info lives here.

export interface ModelCatalogEntry {
  id: string;
  /** What the model does: transcribes speech, aligns words to the audio, or
   *  enhances the edit (an optional tool run from the editor). */
  kind: 'transcription' | 'alignment' | 'enhancement';
  name: string;
  /** English only = faster, slightly more accurate for English */
  language: 'English only' | 'Multilingual' | 'English-first';
  sizeMb: number;
  description: string;
  bestFor: string;
  requirements: string;
  /** Third-party model: who made it and under which licence (shown as credit). */
  provider?: {
    name:        string;
    url:         string;
    model:       string;
    licenseName: string;
    licenseUrl:  string;
  };
}

// Wave ships one transcription model — Large v3 Turbo — plus a word-alignment
// model. Text-based editing needs accurate words *and* accurate word timings:
// Turbo gives near-Large-v3 accuracy at a fraction of the time, and the aligner
// places each word on its audio. Keep in sync with KNOWN_MODELS in
// src-tauri/src/models.rs. Enhancement models are optional tools.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: 'large-v3-turbo',
    kind: 'transcription',
    name: 'Large Turbo',
    language: 'Multilingual',
    sizeMb: 1549,
    description:
      'Distilled from Whisper Large v3 — near-identical accuracy at a fraction of the time. Wave aligns every word to the audio, so cuts land where the words actually are. Handles accents, technical vocabulary and multiple languages.',
    bestFor: 'Podcasts, interviews and narration — precise text-based editing',
    requirements: 'Apple Silicon (M1 or later)',
  },
  {
    id: 'wav2vec2-align-en',
    kind: 'alignment',
    name: 'Word alignment',
    language: 'English only',
    sizeMb: 91,
    description:
      'A small wav2vec2 model that places every word on the exact audio it was spoken in — to within a few tens of milliseconds — so cutting a word removes all of it, with no leftover start of the word. Runs automatically after transcription.',
    bestFor: 'Precise text-based cuts in English recordings',
    requirements: 'Any Apple Silicon Mac',
  },
  {
    id: 'dpdfnet',
    kind: 'enhancement',
    name: 'DPDFNet',
    language: 'Multilingual',
    sizeMb: 14,
    description:
      'Removes background noise and room echo, keeping the voice as recorded.',
    bestFor: 'Noisy rooms, fans and traffic; voices you want left untouched',
    requirements: 'Any Apple Silicon Mac',
    provider: {
      name:        'Ceva',
      url:         'https://github.com/ceva-ip/DPDFNet',
      model:       'DPDFNet',
      licenseName: 'Apache-2.0',
      licenseUrl:  'https://www.apache.org/licenses/LICENSE-2.0',
    },
  },
  {
    id: 'nemotron3-diarization',
    kind: 'enhancement',
    name: 'Speaker detection',
    language: 'Multilingual',
    sizeMb: 115,
    description:
      'Works out who is speaking when, for up to 8 people, so the transcript reads as a conversation: each turn starts a new paragraph under the speaker’s name, which you can change. The names also go into text and subtitle exports.',
    bestFor: 'Interviews, panels and conversations',
    requirements: 'Any Apple Silicon Mac · about a minute per hour of audio',
    provider: {
      name:        'NVIDIA',
      url:         'https://huggingface.co/nvidia/Nemotron-3-Diarization',
      model:       'Nemotron 3 Diarization',
      licenseName: 'OpenMDW 1.1',
      licenseUrl:  'https://openmdw.ai/license/1-1/',
    },
  },
];

export function getCatalogEntry(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** True for models that transcribe (the ones a project can be transcribed with). */
export function isTranscriptionModel(id: string): boolean {
  return getCatalogEntry(id)?.kind === 'transcription';
}

/** Id of the forced-alignment model (mirrors ALIGNER_ID in models.rs). */
export const ALIGNER_MODEL_ID = 'wav2vec2-align-en';

// ─── Bundles ──────────────────────────────────────────────────────────────────
// Models that only make sense together are one entry in Settings: downloaded
// in sequence, ready only when all are, and deleted together.

export interface ModelBundle {
  id:           string;
  name:         string;
  description:  string;
  bestFor:      string;
  requirements: string;
  /** Third-party models: credit shown on the card. */
  provider?:    ModelCatalogEntry['provider'];
  /** In download order. */
  parts: { modelId: string; role: string; detail: string }[];
}

/**
 * Transcription = Whisper (what was said) + the word aligner (exactly when).
 * Text-based editing cuts at word boundaries, so the aligner isn't optional:
 * without it, cuts land up to half a second off mid-sentence.
 */
export const TRANSCRIPTION_BUNDLE: ModelBundle = {
  id:       'transcription',
  name:     'Transcription',
  description:
    'Two models that work as one. Whisper writes down what was said; a small alignment model then finds exactly where each word was spoken, to within a few hundredths of a second, so cutting a word removes all of it and none of its neighbours.',
  bestFor:      'Podcasts, interviews and narration: precise text-based editing',
  requirements: 'Apple Silicon (M1 or later) · runs entirely on your Mac',
  parts: [
    { modelId: 'large-v3-turbo',  role: 'Speech recognition', detail: 'Whisper Large v3 Turbo · writes the words, 99 languages' },
    { modelId: 'wav2vec2-align-en', role: 'Word alignment',   detail: 'wav2vec2 · places each word on its audio (English)' },
  ],
};

/** Every bundle, in Settings order. */
export const MODEL_BUNDLES: ModelBundle[] = [TRANSCRIPTION_BUNDLE];

/** Models shown as part of a bundle rather than on their own card. */
export function isBundled(id: string): boolean {
  return MODEL_BUNDLES.some((b) => b.parts.some((p) => p.modelId === id));
}


/** Id of the speaker-detection model (mirrors DIARIZATION_ID in models.rs). */
export const SPEAKER_MODEL_ID = 'nemotron3-diarization';

/** Speech enhancement's clean-up model (mirrors DPDFNET_ID in models.rs). */
export const DPDFNET_MODEL_ID = 'dpdfnet';

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(secs: number): string {
  if (secs <= 0) return '';
  if (secs < 60) return '< 1 min';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `~${mins} min`;
  const hrs = (secs / 3600).toFixed(1);
  return `~${hrs} hr`;
}
