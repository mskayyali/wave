//! DPDFNet (Ceva; Apache-2.0 code and weights): speech enhancement's clean-up,
//! `dpdfnet8_48khz_hr` (DeepFilterNet 2 with eight dual-path RNN blocks,
//! 48 kHz). It takes out background noise and room echo and leaves the voice
//! as recorded.
//!
//! The ONNX graph is the streaming model: one STFT frame per call, its whole
//! state (feature normalisers, conv buffers, RNN states) passed out and back in
//! as one flat tensor. Features, the mask and the deep filter all run inside;
//! outside are only the STFT and its inverse (`onnx_model/infer_dpdfnet_onnx.py`
//! in github.com/ceva-ip/DPDFNet):
//!
//!  1. Vorbis window, n_fft 960, hop 480, no scaling (the graph applies 1/960
//!     on the way in and 960 on the way out), frames centred: 480 zeros in
//!     front.
//!  2. Per frame: `spec` [1,1,481,2] (re, im) and `state_in` → `spec_e`,
//!     `state_out`. The initial state is zeros except the two normaliser
//!     vectors stored in the model's metadata (`erb_norm_init`,
//!     `spec_norm_init`).
//!  3. The output lags the input by 4 frames (1920 samples), so frame t of
//!     the result is call t + 4; the tail is padded far enough to flush it.
//!  4. Inverse STFT (×1/960 for the unnormalised inverse), overlap-add.
//!
//! A frame takes about 3 ms on one core, so a file is cut into segments (5–30 s,
//! enough to keep every core busy) run in parallel, one session per core; each
//! is fed the 4 s before it first, so its state has settled, and the 200 ms
//! after it, which the model looks ahead into.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use ort::{session::Session, value::Tensor};
use realfft::{num_complex::Complex32, RealFftPlanner};

/// The Hugging Face revision the model is pinned to (Ceva-IP/DPDFNet).
pub const MODEL_REVISION: &str = "dd6818d";

const FFT:          usize = 960;
const HOP:          usize = 480;
const N_FREQ:       usize = FFT / 2 + 1;
const DELAY_FRAMES: usize = 4;
const RATE:         usize = 48_000;
/// Segments run in parallel, each fed the 4 s before it first. Their length
/// spreads the file over the sessions, within these bounds. All on the hop
/// grid, so every segment frames the signal the same way.
const MIN_SEGMENT: usize = 5 * RATE;
const MAX_SEGMENT: usize = 30 * RATE;
const WARMUP:      usize = 4 * RATE;
/// …and the audio after it: the model looks a few frames ahead, so a segment
/// that ends in padding would end differently from one pass through.
const LOOKAHEAD:   usize = 20 * HOP;

pub struct Dpdfnet {
    sessions: Vec<Session>,
    initial:  Vec<f32>,
    window:   Vec<f32>,
}

impl Dpdfnet {
    pub fn load(model: &Path) -> Result<Self, String> {
        // One thread per session is fastest (more slows a single frame down).
        let cores   = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let workers = cores.saturating_sub(1).clamp(1, 8);
        let sessions = (0..workers)
            .map(|_| {
                Session::builder()
                    .map_err(|e| e.to_string())?
                    .with_intra_threads(1)
                    .map_err(|e| e.to_string())?
                    .commit_from_file(model)
                    .map_err(|e| format!("Failed to load DPDFNet: {e}"))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let initial = {
            let meta = sessions[0].metadata().map_err(|e| e.to_string())?;
            let read = |key: &str| meta.custom(key).ok_or_else(|| format!("DPDFNet is missing its {key}"));
            let numbers = |key: &str| -> Result<Vec<f32>, String> {
                read(key)?.split(',').map(|v| v.trim().parse::<f32>().map_err(|e| e.to_string())).collect()
            };
            let size: usize = read("state_size")?.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
            let (erb, spec) = (numbers("erb_norm_init")?, numbers("spec_norm_init")?);
            if erb.len() + spec.len() > size { return Err("DPDFNet's state doesn't fit its normalisers".into()); }
            let mut state = vec![0f32; size];
            state[..erb.len()].copy_from_slice(&erb);
            state[erb.len()..erb.len() + spec.len()].copy_from_slice(&spec);
            state
        };

        let half = (FFT / 2) as f64;
        let window = (0..FFT).map(|n| {
            let s = (0.5 * std::f64::consts::PI * (n as f64 + 0.5) / half).sin();
            (0.5 * std::f64::consts::PI * s * s).sin() as f32
        }).collect();
        Ok(Self { sessions, initial, window })
    }

    /// Enhance `audio` (mono, 48 kHz) in place. Progress 0–1; stops with
    /// "Cancelled" when `cancelled` says so.
    pub fn enhance(&mut self, audio: &mut [f32], on_progress: &mut dyn FnMut(f32), cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        if audio.is_empty() { return Ok(()); }
        let total    = audio.len();
        let spread   = total.div_ceil(self.sessions.len()).div_ceil(HOP) * HOP;
        let segment  = spread.clamp(MIN_SEGMENT, MAX_SEGMENT);
        let segments = total.div_ceil(segment);
        let next     = AtomicUsize::new(0);
        let done     = AtomicUsize::new(0);
        let stop     = AtomicBool::new(false);
        let results: Mutex<Vec<(usize, Vec<f32>)>> = Mutex::new(Vec::with_capacity(segments));
        let failure: Mutex<Option<String>> = Mutex::new(None);
        let (initial, window, input) = (&self.initial, &self.window, &*audio);
        let workers = self.sessions.len().min(segments);

        std::thread::scope(|scope| {
            let handles: Vec<_> = self.sessions.iter_mut().take(workers).map(|session| {
                let (next, done, stop, results, failure) = (&next, &done, &stop, &results, &failure);
                scope.spawn(move || loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= segments || stop.load(Ordering::Relaxed) { break; }
                    let start = i * segment;
                    let end   = (start + segment).min(total);
                    let lead  = WARMUP.min(start);
                    let tail  = (end + LOOKAHEAD).min(total);
                    match run(session, initial, window, &input[start - lead..tail], stop, done) {
                        Ok(mut out) => {
                            out.truncate(end - start + lead);
                            out.drain(..lead);
                            results.lock().unwrap().push((i, out));
                        }
                        Err(e) => { stop.store(true, Ordering::Relaxed); failure.lock().unwrap().get_or_insert(e); break; }
                    }
                })
            }).collect();
            // Report from here: the callbacks aren't for other threads.
            while !handles.iter().all(|h| h.is_finished()) {
                if cancelled() { stop.store(true, Ordering::Relaxed); }
                on_progress((done.load(Ordering::Relaxed) as f32 / total as f32).min(1.0));
                std::thread::sleep(Duration::from_millis(100));
            }
        });

        if cancelled() { return Err("Cancelled".into()); }
        if let Some(e) = failure.into_inner().unwrap() { return Err(e); }
        for (i, out) in results.into_inner().unwrap() {
            let start = i * segment;
            audio[start..start + out.len()].copy_from_slice(&out);
        }
        on_progress(1.0);
        Ok(())
    }
}

/// One stretch through the streaming model from its initial state; the same
/// length out. `done` counts the samples finished, for progress.
fn run(session: &mut Session, initial: &[f32], window: &[f32], input: &[f32], stop: &AtomicBool, done: &AtomicUsize) -> Result<Vec<f32>, String> {
    let pre = FFT - HOP;
    // The prepad, whole hops of signal, then enough zeros to flush the delay.
    let mut padded = vec![0f32; pre + input.len().div_ceil(HOP) * HOP + FFT + DELAY_FRAMES * HOP];
    padded[pre..pre + input.len()].copy_from_slice(input);
    let n_frames = (padded.len() - FFT) / HOP + 1;

    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(FFT);
    let inverse = planner.plan_fft_inverse(FFT);
    let mut frame = forward.make_input_vec();
    let mut spectrum = forward.make_output_vec();
    let mut enhanced = vec![0f32; n_frames * N_FREQ * 2];
    let mut state = initial.to_vec();

    for t in 0..n_frames {
        if stop.load(Ordering::Relaxed) { return Err("Cancelled".into()); }
        for ((d, &s), &w) in frame.iter_mut().zip(&padded[t * HOP..t * HOP + FFT]).zip(window) { *d = s * w; }
        forward.process(&mut frame, &mut spectrum).map_err(|e| e.to_string())?;
        let mut spec = vec![0f32; N_FREQ * 2];
        for (k, z) in spectrum.iter().enumerate() { spec[2 * k] = z.re; spec[2 * k + 1] = z.im; }
        let outputs = session.run(ort::inputs![
            "spec"     => Tensor::from_array((vec![1i64, 1, N_FREQ as i64, 2], spec)).map_err(|e| e.to_string())?,
            "state_in" => Tensor::from_array((vec![state.len() as i64], std::mem::take(&mut state))).map_err(|e| e.to_string())?,
        ]).map_err(|e| format!("DPDFNet failed: {e}"))?;
        let (_, out) = outputs["spec_e"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        enhanced[t * N_FREQ * 2..(t + 1) * N_FREQ * 2].copy_from_slice(out);
        let (_, next) = outputs["state_out"].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
        state = next.to_vec();
        if t >= DELAY_FRAMES { done.fetch_add(HOP, Ordering::Relaxed); }
    }

    // Frame c of the result is call c + 4. Unnormalised inverse, so ÷960.
    let frames = n_frames - DELAY_FRAMES;
    let mut out = vec![0f32; (frames - 1) * HOP + FFT];
    let mut bins = inverse.make_input_vec();
    let mut time = inverse.make_output_vec();
    for c in 0..frames {
        let src = &enhanced[(c + DELAY_FRAMES) * N_FREQ * 2..(c + DELAY_FRAMES + 1) * N_FREQ * 2];
        for (k, z) in bins.iter_mut().enumerate() { *z = Complex32::new(src[2 * k], src[2 * k + 1]); }
        bins[0].im = 0.0;
        bins[N_FREQ - 1].im = 0.0;
        inverse.process(&mut bins, &mut time).map_err(|e| e.to_string())?;
        for ((d, &v), &w) in out[c * HOP..c * HOP + FFT].iter_mut().zip(&time).zip(window) { *d += v * w / FFT as f32; }
    }
    out.drain(..pre);
    out.truncate(input.len());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &str) -> Vec<f32> {
        crate::transcription::read_wav_f32(Path::new(path)).unwrap()
    }

    /// The port against the reference implementation's output for the same
    /// noisy speech, both 48 kHz mono WAVs (not run by default):
    /// `DPDFNET_MODEL=…onnx DPDFNET_IN=noisy.wav DPDFNET_REF=enhanced.wav cargo test dpdfnet -- --ignored --nocapture`.
    /// Same length, no delay, and the same audio to well under the noise floor.
    #[test]
    #[ignore]
    fn matches_the_reference() {
        let model = std::env::var("DPDFNET_MODEL").expect("DPDFNET_MODEL");
        let input = read(&std::env::var("DPDFNET_IN").expect("DPDFNET_IN"));
        let reference = read(&std::env::var("DPDFNET_REF").expect("DPDFNET_REF"));
        let mut out = input.clone();
        let mut net = Dpdfnet::load(Path::new(&model)).unwrap();
        let t0 = std::time::Instant::now();
        net.enhance(&mut out, &mut |_| {}, &|| false).unwrap();
        let secs = t0.elapsed().as_secs_f64();
        let n = out.len().min(reference.len());
        let (sig, err): (f64, f64) = reference[..n].iter().zip(&out[..n])
            .fold((0.0, 0.0), |(s, e), (&r, &o)| (s + (r as f64).powi(2), e + ((o - r) as f64).powi(2)));
        let match_db = 10.0 * (sig / err.max(1e-20)).log10();
        println!("{:.1} s in {secs:.2} s ({:.0}× real time, {} sessions) · matches the reference to {match_db:.1} dB",
            input.len() as f64 / RATE as f64, input.len() as f64 / RATE as f64 / secs, net.sessions.len());
        assert_eq!(out.len(), input.len());
        assert!(match_db > 40.0, "differs from the reference: {match_db:.1} dB");
    }
}
