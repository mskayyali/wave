import { convertFileSrc, invoke } from '@tauri-apps/api/core';

// The waveform built natively (src-tauri/src/waveform.rs) and cached with the
// project: drawn at once, before the audio itself has been decoded.

export interface WaveformPeaks {
  /** [max, min] per millisecond, across channels: wavesurfer's peaks. */
  envelope:    Float32Array;
  /** RMS per 10 ms frame (for easing cut edges). */
  energy:      Float32Array;
  durationSec: number;
}

/** Parse `waveform.bin` (layout in waveform.rs). */
export function parseWaveform(data: ArrayBuffer): WaveformPeaks {
  const view = new DataView(data);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'WVF1' || view.getUint32(4, true) !== 1) throw new Error('Unknown waveform file');
  const rate    = view.getUint32(8, true);
  const frames  = Number(view.getBigUint64(12, true));
  const points  = view.getUint32(20, true);
  const nEnergy = view.getUint32(24, true);
  const quantised = new Int16Array(data, 28, points * 2);
  const envelope  = new Float32Array(points * 2);
  for (let i = 0; i < quantised.length; i++) envelope[i] = quantised[i] / 32767;
  return {
    envelope,
    energy:      new Float32Array(data, 28 + points * 4, nEnergy),
    durationSec: frames / Math.max(1, rate),
  };
}

/** The project's waveform, built first if needed (a second or two, once). */
export async function loadWaveform(projectId: string): Promise<WaveformPeaks> {
  const path = await invoke<string>('get_waveform', { projectId });
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseWaveform(await response.arrayBuffer());
}
