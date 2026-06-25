// Frontend-only metadata for all known Whisper models.
// The Rust side only knows ids and filenames — rich display info lives here.

export interface ModelCatalogEntry {
  id: string;
  name: string;
  /** English only = faster, slightly more accurate for English */
  language: 'English only' | 'Multilingual';
  sizeMb: number;
  speedLabel: 'Fastest' | 'Fast' | 'Medium' | 'Slow' | 'Slowest';
  /** 1 (slow) → 5 (fastest) */
  speedScore: 1 | 2 | 3 | 4 | 5;
  /** 1 (rough) → 5 (best) */
  accuracyScore: 1 | 2 | 3 | 4 | 5;
  recommended: boolean;
  /** Short badge shown on the card (optional) */
  badge?: string;
  description: string;
  bestFor: string;
  requirements: string;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: 'tiny.en',
    name: 'Tiny',
    language: 'English only',
    sizeMb: 75,
    speedLabel: 'Fastest',
    speedScore: 5,
    accuracyScore: 2,
    recommended: false,
    description:
      'Smallest and fastest model. Suitable for clear studio recordings where you want a rough draft instantly. Struggles with background noise, heavy accents, or crosstalk.',
    bestFor: 'Quick drafts, real-time preview',
    requirements: 'Any Mac',
  },
  {
    id: 'base.en',
    name: 'Base',
    language: 'English only',
    sizeMb: 142,
    speedLabel: 'Fast',
    speedScore: 4,
    accuracyScore: 3,
    recommended: false,
    description:
      'A clear step up from Tiny with noticeably better word accuracy. Handles most podcast-quality audio well and transcribes a 30-minute episode in under 2 minutes on M1.',
    bestFor: 'Short clips, fast iteration',
    requirements: 'Any Mac',
  },
  {
    id: 'small.en',
    name: 'Small',
    language: 'English only',
    sizeMb: 466,
    speedLabel: 'Medium',
    speedScore: 3,
    accuracyScore: 4,
    recommended: true,
    badge: 'Recommended',
    description:
      'The best starting point for most podcast workflows. High word-level accuracy with reasonable speed on Apple Silicon. Handles moderate accents and light background noise well.',
    bestFor: 'Podcast editing, interviews, solo recordings',
    requirements: 'Any Mac (M1 or later recommended)',
  },
  {
    id: 'medium.en',
    name: 'Medium',
    language: 'English only',
    sizeMb: 1500,
    speedLabel: 'Slow',
    speedScore: 2,
    accuracyScore: 4,
    recommended: false,
    description:
      'Near-production accuracy for demanding content. Worth the extra transcription time for technical vocabulary, dense crosstalk, or strong regional accents.',
    bestFor: 'Technical content, strong accents, dense dialogue',
    requirements: 'M1 Pro / M2 or later recommended',
  },
  {
    id: 'large-v3-turbo',
    name: 'Large Turbo',
    language: 'Multilingual',
    sizeMb: 1600,
    speedLabel: 'Medium',
    speedScore: 3,
    accuracyScore: 5,
    recommended: false,
    badge: 'Best accuracy',
    description:
      'Distilled from Large v3 — virtually identical accuracy at ~8× the speed. The best option if you need maximum quality without waiting hours. Also handles multilingual and non-native English exceptionally well.',
    bestFor: 'Multilingual content, non-native English, maximum accuracy',
    requirements: 'M1 Pro / M2 or later',
  },
  {
    id: 'large-v3',
    name: 'Large v3',
    language: 'Multilingual',
    sizeMb: 3100,
    speedLabel: 'Slowest',
    speedScore: 1,
    accuracyScore: 5,
    recommended: false,
    description:
      "OpenAI's most capable model. The gold standard for accuracy in any language. Transcription runs at roughly real-time on M2 Ultra. Reserve for critical productions where accuracy is non-negotiable.",
    bestFor: 'Critical productions, multiple languages',
    requirements: 'M2 Pro / M3 Pro or later, 16 GB+ RAM',
  },
];

export function getCatalogEntry(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

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
