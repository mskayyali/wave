// The audio export formats as Wave offers them: what each is for, and its
// presets with the settings Rust's export_audio takes (src-tauri/src/encode.rs,
// ExportFormat). The agents' export_audio tool takes the same preset ids
// (mcp.rs): keep the three in step.

export type ExportSettings =
  | { format: 'wav';  bits: 16 | 24 }
  | { format: 'flac'; bits: 16 | 24 }
  | { format: 'mp3';  kbps: number; mono: boolean }
  | { format: 'aac';  kbps: number; mono: boolean };

export type AudioFormatId = ExportSettings['format'];

export interface AudioPreset {
  /** "mp3-128": what agents name it by. */
  id:       string;
  name:     string;
  /** Its settings, then what it's for. */
  note:     string;
  settings: ExportSettings;
}

export interface AudioFormat {
  id:       AudioFormatId;
  /** On the switch and the button: "MP3". */
  name:     string;
  ext:      string;
  /** What the format is for, in a line. */
  note:     string;
  presets:  AudioPreset[];
  /** The preset chosen until another is. */
  standard: string;
}

const mp3 = (kbps: number, mono = false): ExportSettings => ({ format: 'mp3', kbps, mono });
const aac = (kbps: number, mono = false): ExportSettings => ({ format: 'aac', kbps, mono });

export const AUDIO_FORMATS: AudioFormat[] = [
  {
    id: 'mp3', name: 'MP3', ext: 'mp3', standard: 'mp3-128',
    note: 'Plays everywhere: what podcast hosts and apps expect.',
    presets: [
      { id: 'mp3-64-mono', name: 'Spoken word',      note: '64 kbps, mono. The smallest file, plenty for voice alone.', settings: mp3(64, true) },
      { id: 'mp3-128',     name: 'Podcast standard', note: '128 kbps. What most podcasts publish.', settings: mp3(128) },
      { id: 'mp3-192',     name: 'High quality',     note: '192 kbps. For shows with music.', settings: mp3(192) },
      { id: 'mp3-320',     name: 'Highest',          note: '320 kbps. The best MP3 can do, in a large file.', settings: mp3(320) },
    ],
  },
  {
    id: 'aac', name: 'AAC', ext: 'm4a', standard: 'aac-128',
    note: 'Apple’s format (.m4a): better sound than MP3 at the same size. Apple Podcasts and most apps play it.',
    presets: [
      { id: 'aac-64-mono', name: 'Spoken word',  note: '64 kbps, mono. The smallest file, plenty for voice alone.', settings: aac(64, true) },
      { id: 'aac-128',     name: 'Standard',     note: '128 kbps. Right for most podcasts.', settings: aac(128) },
      { id: 'aac-256',     name: 'High quality', note: '256 kbps. What Apple Music streams.', settings: aac(256) },
    ],
  },
  {
    id: 'wav', name: 'WAV', ext: 'wav', standard: 'wav-16',
    note: 'Uncompressed: for editing elsewhere, or mastering.',
    presets: [
      { id: 'wav-16', name: '16-bit', note: 'CD quality.', settings: { format: 'wav', bits: 16 } },
      { id: 'wav-24', name: '24-bit', note: 'More headroom, for further editing or mastering.', settings: { format: 'wav', bits: 24 } },
    ],
  },
  {
    id: 'flac', name: 'FLAC', ext: 'flac', standard: 'flac-16',
    note: 'Lossless, at about half the size of WAV: for archiving or handing on.',
    presets: [
      { id: 'flac-16', name: '16-bit', note: 'CD quality, nothing lost.', settings: { format: 'flac', bits: 16 } },
      { id: 'flac-24', name: '24-bit', note: 'More headroom, for further editing or mastering.', settings: { format: 'flac', bits: 24 } },
    ],
  },
];

/** A preset by its id, or a format's standard one by the format's id ("mp3"). */
export function findPreset(id: string): { format: AudioFormat; preset: AudioPreset } | null {
  for (const format of AUDIO_FORMATS) {
    const preset = format.presets.find((p) => p.id === id || (id === format.id && p.id === format.standard));
    if (preset) return { format, preset };
  }
  return null;
}

/** Every id findPreset takes: the formats', then the presets'. */
export const PRESET_IDS = [...AUDIO_FORMATS.map((f) => f.id), ...AUDIO_FORMATS.flatMap((f) => f.presets.map((p) => p.id))];

/** About how many MB a lossy preset makes of `seconds` of audio (its bit rate
 *  is the size); null for WAV and FLAC, which depend on the audio. */
export function estimateMb(settings: ExportSettings, seconds: number): number | null {
  if (settings.format !== 'mp3' && settings.format !== 'aac') return null;
  return settings.kbps * 1000 / 8 * seconds / 1e6;
}
