// One pass over the decoded audio produces everything the editor needs:
//
//  • envelope — per-millisecond [max, min] pairs across channels. Drawn as the
//    waveform it is indistinguishable from the full signal up to 1000 px/s, at
//    1/24th of the samples (48 kHz), so zooming and scrolling stay smooth.
//  • energy   — RMS per 10 ms frame, used to place cut edges at the quietest
//    point near a word boundary ("gentle" cuts).

export const ENERGY_FRAME_MS = 10;

export interface AudioAnalysis {
  envelope: Float32Array;
  energy:   Float32Array;
}

export function analyzeAudio(buffer: AudioBuffer): AudioAnalysis {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const n        = buffer.length;
  const block    = Math.max(1, Math.round(buffer.sampleRate / 1000));
  const frame    = Math.max(1, Math.round((buffer.sampleRate * ENERGY_FRAME_MS) / 1000));
  const blocks   = Math.ceil(n / block);
  const frames   = Math.ceil(n / frame);

  const envelope = new Float32Array(blocks * 2);
  const sumSq    = new Float64Array(frames);
  const scale    = 1 / channels.length;

  for (let b = 0; b < blocks; b++) {
    const start = b * block;
    const end   = Math.min(n, start + block);
    let max = -Infinity;
    let min = Infinity;
    for (const data of channels) {
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v > max) max = v;
        if (v < min) min = v;
        sumSq[(i / frame) | 0] += v * v * scale;
      }
    }
    envelope[2 * b]     = max;
    envelope[2 * b + 1] = min;
  }

  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const len = Math.min(frame, n - f * frame);
    energy[f] = Math.sqrt(sumSq[f] / Math.max(1, len));
  }
  return { envelope, energy };
}

/**
 * The quietest moment (ms) within [aroundMs − beforeMs, aroundMs + afterMs], or
 * null when nothing there is clearly quieter (≥ 3 dB) than at `aroundMs` itself
 * — then the boundary is already as good a cut point as any nearby.
 */
export function quietestPoint(
  energy:   Float32Array,
  aroundMs: number,
  beforeMs: number,
  afterMs:  number,
): number | null {
  const at   = (ms: number) => Math.min(energy.length - 1, Math.max(0, Math.floor(ms / ENERGY_FRAME_MS)));
  const from = at(aroundMs - beforeMs);
  const to   = at(aroundMs + afterMs);
  let best = at(aroundMs);
  for (let f = from; f <= to; f++) {
    if (energy[f] < energy[best]) best = f;
  }
  // 3 dB ≈ a factor of √2 in RMS
  if (energy[best] * Math.SQRT2 > energy[at(aroundMs)]) return null;
  return best * ENERGY_FRAME_MS + ENERGY_FRAME_MS / 2;
}
