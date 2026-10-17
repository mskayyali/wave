//! Speaker detection ("who spoke when") with NVIDIA Nemotron 3 Diarization
//! (OpenMDW 1.1): a Streaming Sortformer that labels up to 8 speakers, ordered
//! by when they first speak.
//!
//! The ONNX export (onnx-community) is one step of the model: a chunk of mel
//! features plus the cached context in, per-10 ms speaker logits and the
//! chunk's encoder frames out. This module is the rest, ported from the
//! transformers implementation (`Nemotron3DiarizationForAudioFrameClassification`,
//! offline mode) and checked against it:
//!
//!  1. Features (`NemotronAsrStreamingFeatureExtractor`): pre-emphasis 0.97,
//!     512-point STFT of a 400-sample symmetric Hann window every 10 ms,
//!     centred with zero padding, power → 128 Slaney mel bands → ln(x + 2⁻²⁴).
//!     Not normalised. The last frame is padding and is zeroed and masked.
//!  2. Chunks of 340 encoder frames (8 mel frames each, 27.2 s) with 40 frames
//!     of look-ahead. Each step attends to the speaker cache and the FIFO queue
//!     of recent frames before the chunk.
//!  3. After each step the chunk joins the FIFO (40 frames); on overflow its
//!     oldest 300 frames move to the speaker cache, which is compressed to 264
//!     frames by the Arrival-Order Speaker Cache policy: per-frame scores from
//!     the speaker probabilities, boosts so every speaker keeps frames, a
//!     reserved silence slot per speaker, and frames kept in time order within
//!     each speaker.
//!
//! The result is saved as segments per speaker (probability > 0.5); the editor
//! gives each word the speaker it overlaps most.

use std::path::Path;
use std::sync::Arc;

use ort::{session::Session, value::Tensor};
use realfft::{RealFftPlanner, RealToComplex};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::projects::project_dir;
use crate::transcription::read_wav_f32;

/// The onnx-community commit the model files are pinned to.
pub const MODEL_REVISION: &str = "353b6f8";

const SAMPLE_RATE: usize = 16_000;
const N_FFT:       usize = 512;
const WIN:         usize = 400;
const HOP:         usize = 160;
const N_MELS:      usize = 128;
const N_BINS:      usize = N_FFT / 2 + 1;
const PREEMPHASIS: f32   = 0.97;
const LOG_GUARD:   f32   = 5.960_464_5e-8; // 2⁻²⁴
const FRAME_MS:    i64   = 10;

/// Mel frames per encoder frame.
const SUB:        usize = 8;
const N_SPEAKERS: usize = 8;
const HIDDEN:     usize = 512;

// Offline chunking (`config.json`: chunk_length, chunk_right_context,
// fifo_length, speaker_cache_update_period).
const CHUNK:         usize = 340;
const RIGHT_CONTEXT: usize = 40;
const FIFO_LEN:      usize = 40;
const UPDATE_PERIOD: usize = 300;

// Speaker cache policy (`streaming_config`).
const CACHE_LEN:     usize = 264;
const SILENCE_SLOTS: usize = 1;
const SCORE_FLOOR:   f32   = 0.25;
const LATEST_BOOST:  f32   = 0.05;
/// Per-speaker share of the cache, less its silence slot (264 / 8 − 1 = 32),
/// and the frame counts the policy spends it on: ⌊32 · 0.5⌋, ⌊32 · 0.75⌋, ⌊32 · 1.5⌋.
const BUDGET:        usize = CACHE_LEN / N_SPEAKERS - SILENCE_SLOTS;
const MIN_POSITIVE:  usize = BUDGET / 2;
const STRONG_BOOSTS: usize = BUDGET * 3 / 4;
const WEAK_BOOSTS:   usize = BUDGET * 3 / 2;

// ─── Saved results ────────────────────────────────────────────────────────────

/// One stretch of one speaker talking.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    pub speaker:  usize,
    pub start_ms: i64,
    pub end_ms:   i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    /// Channel of the model: speakers are numbered by when they first speak.
    pub id:      usize,
    pub name:    String,
    /// Total talk time.
    pub talk_ms: i64,
    /// Merged by the user into another speaker (its id): their words count as
    /// that speaker's. The segments keep the detected speaker, so it can be
    /// split back.
    #[serde(default)]
    pub merged_into: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSettings {
    /// Show speakers in the transcript and exports.
    pub show: bool,
}

impl Default for SpeakerSettings {
    fn default() -> Self {
        Self { show: true }
    }
}

/// `speakers.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerAnalysis {
    pub version:     u32,
    /// Model and pinned revision, e.g. `nemotron3-diarization@353b6f8`.
    pub model:       String,
    pub duration_ms: i64,
    /// Only the speakers who were heard, in order of first appearance.
    pub speakers:    Vec<Speaker>,
    /// Sorted by start; overlapping speech gives overlapping segments.
    pub segments:    Vec<SpeakerSegment>,
    #[serde(default)]
    pub settings:    SpeakerSettings,
}

fn read_analysis(dir: &Path) -> Option<SpeakerAnalysis> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("speakers.json")).ok()?).ok()
}

fn write_analysis(dir: &Path, analysis: &SpeakerAnalysis) -> Result<(), String> {
    let json = serde_json::to_string_pretty(analysis).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("speakers.json"), json).map_err(|e| e.to_string())
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Detect speakers in a project's audio and save them to `speakers.json`.
/// Names given before are kept for the same speaker numbers. Emits
/// `speakers:progress` → { projectId, progress } (0–1) per chunk.
#[tauri::command]
pub async fn detect_speakers(app: AppHandle, project_id: String) -> Result<SpeakerAnalysis, String> {
    let dir   = project_dir(&app, &project_id)?;
    let model = crate::models::diarization_model_path(&app)
        .ok_or("Download Speaker Detection in Settings first")?;
    let previous = read_analysis(&dir);
    let wav      = dir.join("audio_16k.wav");
    let emitter  = app.clone();
    let id       = project_id.clone();

    let (segments, duration_ms) = tokio::task::spawn_blocking(move || -> Result<(Vec<SpeakerSegment>, i64), String> {
        let audio = read_wav_f32(&wav)?;
        let probs = diarize(&model, &audio, |progress| {
            let _ = emitter.emit("speakers:progress", serde_json::json!({ "projectId": id, "progress": progress }));
        })?;
        Ok((segments_of(&probs), (audio.len() * 1000 / SAMPLE_RATE) as i64))
    })
    .await
    .map_err(|e| e.to_string())??;

    // Names and merges given before carry over: speakers are numbered by
    // first arrival, so the same audio gives the same numbers.
    let before = |id: usize| previous.as_ref().and_then(|p| p.speakers.iter().find(|s| s.id == id));
    let mut speakers: Vec<Speaker> = Vec::new();
    for seg in &segments {
        match speakers.iter_mut().find(|s| s.id == seg.speaker) {
            Some(s) => s.talk_ms += seg.end_ms - seg.start_ms,
            None => speakers.push(Speaker {
                id:          seg.speaker,
                name:        before(seg.speaker).map(|s| s.name.clone()).unwrap_or_else(|| format!("Speaker {}", seg.speaker + 1)),
                talk_ms:     seg.end_ms - seg.start_ms,
                merged_into: before(seg.speaker).and_then(|s| s.merged_into),
            }),
        }
    }
    speakers.sort_by_key(|s| s.id);
    let heard: Vec<usize> = speakers.iter().map(|s| s.id).collect();
    for s in &mut speakers {
        s.merged_into = s.merged_into.filter(|t| *t != s.id && heard.contains(t));
    }

    let analysis = SpeakerAnalysis {
        version: 1,
        model: format!("{}@{MODEL_REVISION}", crate::models::DIARIZATION_ID),
        duration_ms,
        speakers,
        segments,
        settings: previous.map(|p| p.settings).unwrap_or_default(),
    };
    write_analysis(&dir, &analysis)?;
    Ok(analysis)
}

/// The saved speakers of a project, if detected.
#[tauri::command]
pub fn get_speakers(app: AppHandle, project_id: String) -> Result<Option<SpeakerAnalysis>, String> {
    Ok(read_analysis(&project_dir(&app, &project_id)?))
}

/// Save speaker names, merges and whether speakers are shown.
#[tauri::command]
pub fn save_speakers(app: AppHandle, project_id: String, speakers: Vec<Speaker>, settings: SpeakerSettings) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    let mut analysis = read_analysis(&dir).ok_or("No speakers to update")?;
    let ids: Vec<usize> = analysis.speakers.iter().map(|s| s.id).collect();
    for saved in &mut analysis.speakers {
        if let Some(s) = speakers.iter().find(|s| s.id == saved.id) {
            saved.name = s.name.trim().to_string();
            // Only into another detected speaker; chains are resolved by the editor.
            saved.merged_into = s.merged_into.filter(|t| *t != saved.id && ids.contains(t));
        }
    }
    analysis.settings = settings;
    write_analysis(&dir, &analysis)
}

// ─── Segments ─────────────────────────────────────────────────────────────────

/// Per-speaker runs of probability > 0.5, at 10 ms (`extract_speaker_dict`).
fn segments_of(probs: &[[f32; N_SPEAKERS]]) -> Vec<SpeakerSegment> {
    let mut segments = Vec::new();
    for speaker in 0..N_SPEAKERS {
        let mut start: Option<usize> = None;
        for (t, row) in probs.iter().enumerate() {
            match (row[speaker] > 0.5, start) {
                (true, None) => start = Some(t),
                (false, Some(s)) => {
                    segments.push(SpeakerSegment { speaker, start_ms: s as i64 * FRAME_MS, end_ms: t as i64 * FRAME_MS });
                    start = None;
                }
                _ => {}
            }
        }
        if let Some(s) = start {
            segments.push(SpeakerSegment { speaker, start_ms: s as i64 * FRAME_MS, end_ms: probs.len() as i64 * FRAME_MS });
        }
    }
    segments.sort_by_key(|s| (s.start_ms, s.speaker));
    segments
}

// ─── Diarization ──────────────────────────────────────────────────────────────

/// Speaker probabilities for every 10 ms of 16 kHz mono `audio`.
pub fn diarize(model: &Path, audio: &[f32], mut on_progress: impl FnMut(f32)) -> Result<Vec<[f32; N_SPEAKERS]>, String> {
    if audio.is_empty() {
        return Ok(Vec::new());
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut session = Session::builder()
        .map_err(|e| e.to_string())?
        .with_intra_threads(threads)
        .map_err(|e| e.to_string())?
        .commit_from_file(model)
        .map_err(|e| format!("Failed to load the speaker model: {e}"))?;

    let frontend = MelFrontEnd::new(audio);
    let n_frames = frontend.n_frames();
    let n_valid  = frontend.n_valid();
    let n_embeds = n_frames.div_ceil(SUB);
    let mut cache = SpeakerCache::default();
    let mut probs: Vec<[f32; N_SPEAKERS]> = Vec::with_capacity(n_frames);
    let mut silence: Vec<f32> = Vec::new();

    let mut start = 0;
    while start < n_embeds {
        let end  = (start + CHUNK).min(n_embeds);
        let stop = (end + RIGHT_CONTEXT).min(n_embeds);
        let (f0, f1) = (start * SUB, (stop * SUB).min(n_frames));
        let features = frontend.frames(f0, f1);

        let cached = cache.context();
        let n_cached = cached.len() / HIDDEN;
        // An encoder frame is valid when its first mel frame is (`attention_mask[::8]`).
        let mut mask = vec![1i64; n_cached];
        mask.extend((start..stop).map(|e| (e * SUB < n_valid) as i64));

        let outputs = session
            .run(ort::inputs![
                "input_features" => Tensor::from_array((vec![1i64, (f1 - f0) as i64, N_MELS as i64], features)).map_err(|e| e.to_string())?,
                "cached_embeds"  => Tensor::from_array((vec![1i64, n_cached as i64, HIDDEN as i64], cached)).map_err(|e| e.to_string())?,
                "attention_mask" => Tensor::from_array((vec![1i64, mask.len() as i64], mask.clone())).map_err(|e| e.to_string())?,
            ])
            .map_err(|e| format!("Speaker detection failed: {e}"))?;
        let (_, logits) = outputs["logits"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        let (_, chunk)  = outputs["chunk_embeds"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        if silence.is_empty() {
            let (_, s) = outputs["silence_embeds"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
            silence = s.to_vec();
        }

        // This step's frames, in order: the cached context, then the chunk and its look-ahead.
        let step_len = mask.len();
        let n_logit_frames = (logits.len() / N_SPEAKERS).min(step_len * SUB);
        for t in n_cached * SUB..((n_cached + end - start) * SUB).min(n_logit_frames) {
            let mut row = [0f32; N_SPEAKERS];
            for (s, p) in row.iter_mut().enumerate() {
                *p = sigmoid(logits[t * N_SPEAKERS + s]);
            }
            probs.push(row);
        }
        let mut step_embeds = cache.context();
        step_embeds.extend_from_slice(chunk);
        cache.update(&step_embeds, &logits[..n_logit_frames * N_SPEAKERS], &silence, end - start, &mask);

        start = end;
        on_progress(start as f32 / n_embeds as f32);
    }
    probs.truncate(n_frames);
    // The padding frame isn't audio.
    for row in probs.iter_mut().skip(n_valid) {
        *row = [0.0; N_SPEAKERS];
    }
    Ok(probs)
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// The Arrival-Order Speaker Cache and FIFO queue
/// (`Nemotron3DiarizationSpeakerCache`), batch of one; frames are `HIDDEN`
/// floats, stored flat.
#[derive(Default)]
struct SpeakerCache {
    embeds:     Vec<f32>,
    probs:      Vec<[f32; N_SPEAKERS]>,
    fifo:       Vec<f32>,
    compressed: bool,
}

impl SpeakerCache {
    /// What the next chunk attends to: the cache, then the FIFO.
    fn context(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.embeds.len() + self.fifo.len());
        out.extend_from_slice(&self.embeds);
        out.extend_from_slice(&self.fifo);
        out
    }

    /// Push the step's chunk into the FIFO; on overflow move its oldest frames
    /// to the cache, compressing that when it's over capacity.
    fn update(&mut self, step_embeds: &[f32], step_logits: &[f32], silence: &[f32], n_chunk: usize, mask: &[i64]) {
        let n_cache = self.embeds.len() / HIDDEN;
        let n_fifo  = self.fifo.len() / HIDDEN;

        // Speaker probabilities per encoder frame: the mean over its 8 mel frames.
        let n_groups = (step_logits.len() / N_SPEAKERS / SUB).min(mask.len());
        let probs: Vec<[f32; N_SPEAKERS]> = (0..n_groups)
            .map(|g| {
                let mut row = [0f32; N_SPEAKERS];
                for t in g * SUB..(g + 1) * SUB {
                    for s in 0..N_SPEAKERS {
                        row[s] += sigmoid(step_logits[t * N_SPEAKERS + s]) / SUB as f32;
                    }
                }
                if mask[g] == 0 { [0.0; N_SPEAKERS] } else { row }
            })
            .collect();

        let chunk_start = n_cache + n_fifo;
        let mut fifo = std::mem::take(&mut self.fifo);
        fifo.extend_from_slice(&step_embeds[chunk_start * HIDDEN..(chunk_start + n_chunk) * HIDDEN]);
        let fifo_frames = fifo.len() / HIDDEN;

        let popped = if fifo_frames <= FIFO_LEN { 0 } else { UPDATE_PERIOD.max(fifo_frames - FIFO_LEN).min(fifo_frames) };
        if popped > 0 {
            // An uncompressed cache holds plain chunk frames, which this step re-scores.
            let mut cache_probs = if self.compressed { std::mem::take(&mut self.probs) } else { probs[..n_cache.min(probs.len())].to_vec() };
            let mut cache_embeds = std::mem::take(&mut self.embeds);
            cache_embeds.extend_from_slice(&fifo[..popped * HIDDEN]);
            for f in 0..popped {
                cache_probs.push(probs.get(n_cache + f).copied().unwrap_or([0.0; N_SPEAKERS]));
            }
            fifo.drain(..popped * HIDDEN);

            if cache_embeds.len() / HIDDEN > CACHE_LEN {
                (cache_embeds, cache_probs) = compress(&cache_embeds, &cache_probs, silence);
                self.compressed = true;
            }
            self.embeds = cache_embeds;
            self.probs  = cache_probs;
        }
        self.fifo = fifo;
    }
}

/// Keep the `CACHE_LEN` most useful frames, grouped by speaker and in time
/// order within a speaker, with a silence frame reserved per speaker.
fn compress(embeds: &[f32], probs: &[[f32; N_SPEAKERS]], silence: &[f32]) -> (Vec<f32>, Vec<[f32; N_SPEAKERS]>) {
    let n = probs.len();
    let mut scores = frame_scores(probs);
    for row in scores.iter_mut().skip(CACHE_LEN) {
        for v in row.iter_mut() { *v += LATEST_BOOST; }
    }
    boost(&mut scores, STRONG_BOOSTS, -2.0 * 0.5f32.ln());
    boost(&mut scores, WEAK_BOOSTS, -0.5f32.ln());
    // The silence slots always win.
    for _ in 0..SILENCE_SLOTS { scores.push([f32::INFINITY; N_SPEAKERS]); }

    let scored = n + SILENCE_SLOTS;
    let sentinel = scored * N_SPEAKERS;
    // Speaker-major flat index, as `scores.transpose(1, 2).reshape(-1)`.
    let mut flat: Vec<(f32, usize)> = (0..N_SPEAKERS)
        .flat_map(|s| (0..scored).map(move |f| (s, f)))
        .map(|(s, f)| (scores[f][s], s * scored + f))
        .collect();
    flat.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    let mut picked: Vec<usize> = flat[..CACHE_LEN.min(flat.len())]
        .iter()
        .map(|&(score, i)| if score == f32::NEG_INFINITY { sentinel } else { i })
        .collect();
    picked.sort_unstable();

    let mut out_embeds = Vec::with_capacity(CACHE_LEN * HIDDEN);
    let mut out_probs  = Vec::with_capacity(CACHE_LEN);
    for i in picked {
        // Frame n is the silence embedding (with zero probabilities).
        let frame = if i == sentinel { n } else { (i % scored).min(n) };
        if frame == n {
            out_embeds.extend_from_slice(silence);
            out_probs.push([0.0; N_SPEAKERS]);
        } else {
            out_embeds.extend_from_slice(&embeds[frame * HIDDEN..(frame + 1) * HIDDEN]);
            out_probs.push(probs[frame]);
        }
    }
    (out_embeds, out_probs)
}

/// How much a frame says about each speaker: log odds of that speaker against
/// the others, only for frames where they speak; overlapped frames are dropped
/// for a speaker who has enough clean ones.
fn frame_scores(probs: &[[f32; N_SPEAKERS]]) -> Vec<[f32; N_SPEAKERS]> {
    let mut scores: Vec<[f32; N_SPEAKERS]> = probs
        .iter()
        .map(|p| {
            let log_c: [f32; N_SPEAKERS] = std::array::from_fn(|s| (1.0 - p[s]).max(SCORE_FLOOR).ln());
            let sum_c: f32 = log_c.iter().sum();
            std::array::from_fn(|s| {
                if p[s] > 0.5 { p[s].max(SCORE_FLOOR).ln() - log_c[s] + sum_c - 0.5f32.ln() } else { f32::NEG_INFINITY }
            })
        })
        .collect();
    for s in 0..N_SPEAKERS {
        let positive = scores.iter().filter(|r| r[s] > 0.0).count();
        if positive >= MIN_POSITIVE {
            for (row, p) in scores.iter_mut().zip(probs) {
                if p[s] > 0.5 && row[s] <= 0.0 { row[s] = f32::NEG_INFINITY; }
            }
        }
    }
    scores
}

/// Add `amount` to each speaker's `k` best frames.
fn boost(scores: &mut [[f32; N_SPEAKERS]], k: usize, amount: f32) {
    for s in 0..N_SPEAKERS {
        let mut order: Vec<usize> = (0..scores.len()).collect();
        order.sort_by(|&a, &b| scores[b][s].total_cmp(&scores[a][s]).then(a.cmp(&b)));
        for &f in order.iter().take(k) {
            scores[f][s] += amount;
        }
    }
}

// ─── Features ─────────────────────────────────────────────────────────────────

/// Log-mel features of a whole recording, computed a range of frames at a time.
struct MelFrontEnd {
    /// The pre-emphasised signal.
    signal:  Vec<f32>,
    /// The 400-sample symmetric Hann window, centred in 512.
    window:  Vec<f32>,
    /// Each band's non-zero weights: (first bin, weights).
    filters: Vec<(usize, Vec<f32>)>,
    fft:     Arc<dyn RealToComplex<f32>>,
}

impl MelFrontEnd {
    fn new(audio: &[f32]) -> Self {
        let mut signal = Vec::with_capacity(audio.len());
        let mut prev = 0f32;
        for (i, &x) in audio.iter().enumerate() {
            signal.push(if i == 0 { x } else { x - PREEMPHASIS * prev });
            prev = x;
        }
        let mut window = vec![0f32; N_FFT];
        let offset = (N_FFT - WIN) / 2;
        for n in 0..WIN {
            window[offset + n] = (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (WIN - 1) as f64).cos()) as f32;
        }
        Self { signal, window, filters: mel_filters(), fft: RealFftPlanner::<f32>::new().plan_fft_forward(N_FFT) }
    }

    /// Frames of `torch.stft(center=True)`: one more than the valid ones.
    fn n_frames(&self) -> usize {
        self.signal.len() / HOP + 1
    }

    fn n_valid(&self) -> usize {
        self.signal.len() / HOP
    }

    /// Frames `[from, to)`, [frame × N_MELS]; the padding frame is zeros.
    fn frames(&self, from: usize, to: usize) -> Vec<f32> {
        let mut out = vec![0f32; (to - from) * N_MELS];
        let mut input   = self.fft.make_input_vec();
        let mut spec    = self.fft.make_output_vec();
        let mut scratch = self.fft.make_scratch_vec();
        let mut power   = vec![0f32; N_BINS];
        let n_valid = self.n_valid();
        for t in from..to.min(n_valid) {
            // Centred: frame t spans samples [t·hop − n_fft/2, t·hop + n_fft/2).
            let origin = (t * HOP) as isize - (N_FFT / 2) as isize;
            for (i, v) in input.iter_mut().enumerate() {
                let idx = origin + i as isize;
                let x = if idx >= 0 && (idx as usize) < self.signal.len() { self.signal[idx as usize] } else { 0.0 };
                *v = x * self.window[i];
            }
            let _ = self.fft.process_with_scratch(&mut input, &mut spec, &mut scratch);
            for (p, z) in power.iter_mut().zip(&spec) {
                *p = z.re * z.re + z.im * z.im;
            }
            let row = &mut out[(t - from) * N_MELS..(t - from + 1) * N_MELS];
            for (v, (first, weights)) in row.iter_mut().zip(&self.filters) {
                let mel: f32 = weights.iter().zip(&power[*first..]).map(|(w, p)| w * p).sum();
                *v = (mel + LOG_GUARD).ln();
            }
        }
        out
    }
}

/// librosa's `filters.mel(sr=16000, n_fft=512, n_mels=128, norm="slaney")`
/// (Slaney mel scale, area-normalised triangles), each band trimmed to its
/// non-zero bins.
fn mel_filters() -> Vec<(usize, Vec<f32>)> {
    const F_SP: f64 = 200.0 / 3.0;
    const MIN_LOG_HZ: f64 = 1000.0;
    let min_log_mel = MIN_LOG_HZ / F_SP;
    let logstep = 6.4f64.ln() / 27.0;
    let hz_to_mel = |f: f64| if f >= MIN_LOG_HZ { min_log_mel + (f / MIN_LOG_HZ).ln() / logstep } else { f / F_SP };
    let mel_to_hz = |m: f64| if m >= min_log_mel { MIN_LOG_HZ * (logstep * (m - min_log_mel)).exp() } else { F_SP * m };

    let max_mel = hz_to_mel(SAMPLE_RATE as f64 / 2.0);
    let mel_f: Vec<f64> = (0..N_MELS + 2)
        .map(|i| mel_to_hz(max_mel * i as f64 / (N_MELS + 1) as f64))
        .collect();
    let fft_freqs: Vec<f64> = (0..N_BINS).map(|k| k as f64 * SAMPLE_RATE as f64 / N_FFT as f64).collect();

    let mut filters = vec![0f32; N_MELS * N_BINS];
    for m in 0..N_MELS {
        let enorm = 2.0 / (mel_f[m + 2] - mel_f[m]);
        for (k, &f) in fft_freqs.iter().enumerate() {
            let lower = (f - mel_f[m]) / (mel_f[m + 1] - mel_f[m]);
            let upper = (mel_f[m + 2] - f) / (mel_f[m + 2] - mel_f[m + 1]);
            filters[m * N_BINS + k] = (lower.min(upper).max(0.0) * enorm) as f32;
        }
    }
    filters
        .chunks(N_BINS)
        .map(|band| {
            let first = band.iter().position(|&w| w != 0.0).unwrap_or(0);
            let last  = band.iter().rposition(|&w| w != 0.0).unwrap_or(first);
            (first, band[first..=last].to_vec())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_follow_the_threshold() {
        let mut probs = vec![[0f32; N_SPEAKERS]; 10];
        for row in &mut probs[2..5] { row[0] = 0.9; }
        for row in &mut probs[4..10] { row[1] = 0.7; }
        assert_eq!(segments_of(&probs), vec![
            SpeakerSegment { speaker: 0, start_ms: 20, end_ms: 50 },
            SpeakerSegment { speaker: 1, start_ms: 40, end_ms: 100 },
        ]);
    }

    #[test]
    fn compression_keeps_the_cache_size_and_groups_by_speaker() {
        // 300 frames: speaker 0 then speaker 1, with distinct embeddings.
        let n = 300;
        let probs: Vec<[f32; N_SPEAKERS]> = (0..n)
            .map(|f| { let mut r = [0.01; N_SPEAKERS]; r[if f < 150 { 0 } else { 1 }] = 0.9; r })
            .collect();
        let embeds: Vec<f32> = (0..n).flat_map(|f| std::iter::repeat(f as f32).take(HIDDEN)).collect();
        let silence = vec![-1f32; HIDDEN];
        let (e, p) = compress(&embeds, &probs, &silence);
        assert_eq!(p.len(), CACHE_LEN);
        assert_eq!(e.len(), CACHE_LEN * HIDDEN);
        let frames: Vec<f32> = (0..CACHE_LEN).map(|i| e[i * HIDDEN]).collect();
        // Speaker 0's frames come before speaker 1's, each in time order.
        let first_of_1 = frames.iter().position(|&f| f >= 150.0).unwrap();
        assert!(frames[..first_of_1].iter().all(|&f| f < 150.0 || f == -1.0));
        assert!(frames.iter().filter(|&&f| f == -1.0).count() >= N_SPEAKERS);
    }

    /// Parity with the transformers reference on real audio (not run by default):
    /// `DIAR_MODEL=…/model_quantized.onnx DIAR_WAV=…/16k.wav DIAR_REF=…/ref_probs.f32 cargo test diar_parity -- --ignored --nocapture`
    /// `DIAR_REF` is the reference probabilities, raw little-endian f32 [frames × 8].
    #[test]
    #[ignore]
    fn diar_parity() {
        let model = std::env::var("DIAR_MODEL").expect("DIAR_MODEL");
        let wav   = std::env::var("DIAR_WAV").expect("DIAR_WAV");
        let audio = read_wav_f32(Path::new(&wav)).unwrap();
        let secs: f64 = std::env::var("DIAR_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let audio = if secs > 0.0 { &audio[..(secs * SAMPLE_RATE as f64) as usize] } else { &audio[..] };

        if let Ok(feats) = std::env::var("DIAR_FEATS") {
            let reference: Vec<f32> = std::fs::read(feats).unwrap().chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
            let fe = MelFrontEnd::new(audio);
            let mine = fe.frames(0, fe.n_frames());
            let n = mine.len().min(reference.len());
            let max = mine[..n].iter().zip(&reference[..n]).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            println!("features: {} vs {} values · max |Δ| {max:.5}", mine.len(), reference.len());
        }

        let t0 = std::time::Instant::now();
        let fe = MelFrontEnd::new(audio);
        let _ = fe.frames(0, fe.n_frames());
        println!("features alone: {:.1} s", t0.elapsed().as_secs_f64());
        let t0 = std::time::Instant::now();
        let probs = diarize(Path::new(&model), audio, |_| {}).unwrap();
        let secs_taken = t0.elapsed().as_secs_f64();
        let reference: Vec<f32> = std::fs::read(std::env::var("DIAR_REF").expect("DIAR_REF")).unwrap()
            .chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        let n = probs.len().min(reference.len() / N_SPEAKERS);
        let (mut agree, mut max_diff) = (0usize, 0f32);
        for t in 0..n {
            for s in 0..N_SPEAKERS {
                let r = reference[t * N_SPEAKERS + s];
                let m = probs[t][s];
                max_diff = max_diff.max((r - m).abs());
                agree += ((r > 0.5) == (m > 0.5)) as usize;
            }
        }
        let segments = segments_of(&probs);
        let mut talk = [0i64; N_SPEAKERS];
        for s in &segments { talk[s.speaker] += s.end_ms - s.start_ms; }
        println!("{:.1} s of audio in {secs_taken:.1} s ({:.0}× real time) · {} frames vs {} · decisions agree {:.3}% · max |Δp| {max_diff:.3}",
            audio.len() as f64 / SAMPLE_RATE as f64, audio.len() as f64 / SAMPLE_RATE as f64 / secs_taken,
            probs.len(), reference.len() / N_SPEAKERS, 100.0 * agree as f64 / (n * N_SPEAKERS) as f64);
        println!("talk time (s): {:?} · {} segments", talk.map(|ms| ms / 1000), segments.len());
    }
}
