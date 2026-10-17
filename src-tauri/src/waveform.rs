//! The waveform the editor draws, built natively so it can appear at once.
//!
//! The editor used to decode the whole recording in the WebView and scan every
//! sample in JavaScript before drawing anything: about 7 s for a 40-minute MP3.
//! This module computes the same two things in Rust, while the file is decoded
//! anyway (at import), and caches them in `waveform.bin`:
//!
//!  • envelope — the [max, min] of all channels over each millisecond (1 ms
//!    windows on absolute sample positions), as i16;
//!  • energy   — RMS per 10 ms frame, the mean of the channels' squares, which
//!    places cut edges at the quietest point near a word boundary.
//!
//! Projects imported before this get the file built on first open.
//!
//! `waveform.bin` (little-endian): `WVF1`, u32 version, u32 sample rate,
//! u64 frames, u32 envelope points, u32 energy frames, then the envelope as
//! i16 pairs and the energy as f32. The header is 28 bytes, so both arrays are
//! aligned for typed-array views.

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::projects::{decode_interleaved_with, find_original_audio, project_dir};

const MAGIC:   &[u8; 4] = b"WVF1";
const VERSION: u32 = 1;
const FILE:    &str = "waveform.bin";

/// Accumulates the envelope and energy over interleaved samples fed in pieces.
pub struct WaveformBuilder {
    rate:      u64,
    frames:    u64,
    // Current 1 ms window.
    block:     u64,
    block_end: u64,
    max:       f32,
    min:       f32,
    envelope:  Vec<i16>,
    // Current 10 ms frame.
    frame:     u64,
    frame_end: u64,
    frame_len: u64,
    sum_sq:    f64,
    energy:    Vec<f32>,
}

impl WaveformBuilder {
    pub fn new(sample_rate: u32) -> Self {
        let rate = sample_rate.max(1) as u64;
        Self {
            rate,
            frames: 0,
            block: 0,
            block_end: Self::boundary(rate, 1, 1000),
            max: f32::NEG_INFINITY,
            min: f32::INFINITY,
            envelope: Vec::new(),
            frame: 0,
            frame_end: Self::boundary(rate, 1, 100),
            frame_len: 0,
            sum_sq: 0.0,
            energy: Vec::new(),
        }
    }

    /// First sample of window `index` when windows are `1/per_second` s long.
    fn boundary(rate: u64, index: u64, per_second: u64) -> u64 {
        (index * rate).div_ceil(per_second).max(index)
    }

    /// Feed interleaved samples with `channels` channels.
    pub fn push(&mut self, interleaved: &[f32], channels: usize) {
        let ch = channels.max(1);
        let scale = 1.0 / ch as f64;
        for frame in interleaved.chunks_exact(ch) {
            for &v in frame {
                if v > self.max { self.max = v; }
                if v < self.min { self.min = v; }
                self.sum_sq += v as f64 * v as f64 * scale;
            }
            self.frame_len += 1;
            self.frames += 1;
            if self.frames >= self.block_end { self.end_block(); }
            if self.frames >= self.frame_end { self.end_frame(); }
        }
    }

    fn end_block(&mut self) {
        let q = |v: f32| (v.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        self.envelope.push(q(self.max));
        self.envelope.push(q(self.min));
        self.max = f32::NEG_INFINITY;
        self.min = f32::INFINITY;
        self.block += 1;
        self.block_end = Self::boundary(self.rate, self.block + 1, 1000);
    }

    fn end_frame(&mut self) {
        self.energy.push((self.sum_sq / self.frame_len.max(1) as f64).sqrt() as f32);
        self.sum_sq = 0.0;
        self.frame_len = 0;
        self.frame += 1;
        self.frame_end = Self::boundary(self.rate, self.frame + 1, 100);
    }

    /// Close the last partial windows and write `waveform.bin`.
    pub fn write(mut self, path: &Path) -> Result<(), String> {
        if self.max >= self.min { self.end_block(); }
        if self.frame_len > 0 { self.end_frame(); }
        let mut out = Vec::with_capacity(28 + self.envelope.len() * 2 + self.energy.len() * 4);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&(self.rate as u32).to_le_bytes());
        out.extend_from_slice(&self.frames.to_le_bytes());
        out.extend_from_slice(&((self.envelope.len() / 2) as u32).to_le_bytes());
        out.extend_from_slice(&(self.energy.len() as u32).to_le_bytes());
        for v in &self.envelope { out.extend_from_slice(&v.to_le_bytes()); }
        for v in &self.energy { out.extend_from_slice(&v.to_le_bytes()); }
        // Via a temporary file, so a reader never sees half of it.
        let part = path.with_extension("bin.part");
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        file.write_all(&out).map_err(|e| e.to_string())?;
        std::fs::rename(&part, path).map_err(|e| e.to_string())
    }
}

/// Whether `path` is a waveform file this version can read.
fn is_current(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else { return false };
    bytes.len() >= 28 && &bytes[..4] == MAGIC && u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) == VERSION
}

/// Build `waveform.bin` from a project's audio (for projects imported before it existed).
fn build(dir: &Path) -> Result<PathBuf, String> {
    let source = find_original_audio(dir)
        .or_else(|| Some(dir.join("audio_16k.wav")).filter(|p| p.exists()))
        .ok_or("No audio found: import audio first")?;
    let mut builder: Option<WaveformBuilder> = None;
    decode_interleaved_with(&source, &mut |samples, channels, rate| {
        builder.get_or_insert_with(|| WaveformBuilder::new(rate)).push(samples, channels);
    })?;
    let path = dir.join(FILE);
    builder.ok_or("The audio is empty")?.write(&path)?;
    Ok(path)
}

/// The project's `waveform.bin`, built first if it's missing or outdated.
#[tauri::command]
pub async fn get_waveform(app: AppHandle, project_id: String) -> Result<String, String> {
    let dir  = project_dir(&app, &project_id)?;
    let path = dir.join(FILE);
    if is_current(&path) {
        return Ok(path.to_string_lossy().into_owned());
    }
    let built = tokio::task::spawn_blocking(move || build(&dir))
        .await
        .map_err(|e| e.to_string())??;
    Ok(built.to_string_lossy().into_owned())
}

/// A project's waveform in brief, for its card: the loudest peak (0–1) in each
/// of `points` equal stretches. None until it has a waveform.bin (projects
/// imported before it existed get one when first opened).
#[tauri::command]
pub fn get_waveform_overview(app: AppHandle, project_id: String, points: usize) -> Result<Option<Vec<f32>>, String> {
    let path = project_dir(&app, &project_id)?.join(FILE);
    let Ok(bytes) = std::fs::read(&path) else { return Ok(None) };
    Ok(overview(&bytes, points.clamp(8, 1024)))
}

fn overview(bytes: &[u8], points: usize) -> Option<Vec<f32>> {
    if bytes.len() < 28 || &bytes[..4] != MAGIC || bytes[4..8] != VERSION.to_le_bytes() {
        return None;
    }
    let pairs = u32::from_le_bytes(bytes[20..24].try_into().ok()?) as usize;
    let envelope = bytes.get(28..28 + pairs * 4)?;
    let mut out = vec![0f32; points];
    for (i, pair) in envelope.chunks_exact(4).enumerate() {
        let max = i16::from_le_bytes([pair[0], pair[1]]).unsigned_abs();
        let min = i16::from_le_bytes([pair[2], pair[3]]).unsigned_abs();
        let slot = &mut out[i * points / pairs.max(1)];
        *slot = slot.max(max.max(min) as f32 / 32767.0);
    }
    Some(out)
}

/// Where a project's waveform file goes (import writes it there).
pub fn waveform_path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_follow_absolute_sample_positions() {
        // 44.1 kHz: 1 ms windows alternate 44 and 45 samples; 10 ms frames are 441.
        let mut b = WaveformBuilder::new(44_100);
        let samples: Vec<f32> = (0..44_100).map(|i| if i % 2 == 0 { 0.5 } else { -0.25 }).collect();
        b.push(&samples[..1000], 1);
        b.push(&samples[1000..], 1);
        assert_eq!(b.envelope.len(), 2 * 1000);
        assert_eq!(b.energy.len(), 100);
        assert_eq!(b.envelope[0], (0.5f32 * 32767.0).round() as i16);
        // The first 10 ms frame is the first 441 samples.
        let rms = (samples[..441].iter().map(|&v| v as f64 * v as f64).sum::<f64>() / 441.0).sqrt() as f32;
        assert!((b.energy[0] - rms).abs() < 1e-6);
    }

    #[test]
    fn overview_keeps_the_loudest_peak_per_stretch() {
        let mut b = WaveformBuilder::new(1000);
        // 4 s at 1 kHz: quiet, loud, quiet, half.
        let level = [0.1f32, 0.9, 0.1, -0.5];
        let samples: Vec<f32> = (0..4000).map(|i| level[i / 1000]).collect();
        b.push(&samples, 1);
        let path = std::env::temp_dir().join("wave-overview-test.bin");
        b.write(&path).unwrap();
        let o = overview(&std::fs::read(&path).unwrap(), 4).unwrap();
        assert_eq!(o.len(), 4);
        assert!((o[1] - 0.9).abs() < 1e-3 && (o[3] - 0.5).abs() < 1e-3 && o[0] < 0.11);
        assert!(overview(b"nope", 4).is_none());
    }

    #[test]
    fn energy_averages_the_channels() {
        let mut b = WaveformBuilder::new(1000);
        // Stereo, 10 frames (one 10 ms energy frame at 1 kHz): left 1.0, right 0.0.
        let samples: Vec<f32> = (0..20).map(|i| if i % 2 == 0 { 1.0 } else { 0.0 }).collect();
        b.push(&samples, 2);
        assert_eq!(b.energy.len(), 1);
        assert!((b.energy[0] - 0.5f32.sqrt()).abs() < 1e-6);
    }
}

#[cfg(test)]
mod speed {
    use super::*;

    /// How long building a waveform takes (not run by default):
    /// `AUDIO=…/file.mp3 cargo test waveform_speed -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn waveform_speed() {
        let audio = std::env::var("AUDIO").expect("AUDIO");
        let t0 = std::time::Instant::now();
        let mut builder: Option<WaveformBuilder> = None;
        decode_interleaved_with(Path::new(&audio), &mut |s, ch, rate| {
            builder.get_or_insert_with(|| WaveformBuilder::new(rate)).push(s, ch);
        }).unwrap();
        let out = std::env::temp_dir().join("wave-waveform-speed.bin");
        builder.unwrap().write(&out).unwrap();
        println!("built in {:.2} s · {:.1} MB", t0.elapsed().as_secs_f64(), std::fs::metadata(&out).unwrap().len() as f64 / 1e6);
    }
}
