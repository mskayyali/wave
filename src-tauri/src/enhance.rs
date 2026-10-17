//! Speech enhancement: a recording made ready to publish, in three steps, each
//! the user's choice.
//!
//!  1. Clean-up with DPDFNet (Ceva, dpdfnet.rs), which takes out background
//!     noise and room echo. Its strength mixes the cleaned audio back with the
//!     original (1 is fully cleaned); both are sample-aligned, so the mix is a
//!     plain sum.
//!  2. An EQ preset (eq.rs).
//!  3. A loudness target (one gain, up to +24 dB), with the true peak kept
//!     under −1.5 dBTP (master.rs).
//!
//! Everything runs at 48 kHz mono: the original import is decoded, mixed down
//! and resampled first. The result is a new 16-bit WAV in the project folder;
//! the original is untouched. Nothing shifts the audio in time (tested), so
//! edits apply to either version and playback can switch between them.
//!
//! `preview_enhancement` runs the same on a short stretch, written beside the
//! untouched stretch brought to the same loudness, for listening first.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::projects::{decode_to_mono_f32, decode_window_mono, find_original_audio, project_dir, resample_mono};

pub const SAMPLE_RATE: u32 = 48_000;

/// Loudness stage: the most one gain may lift a quiet recording, and the
/// true-peak ceiling (headroom for lossy encoding). Enough for a recording at
/// −43 LUFS to reach −19: quiet recordings are common, the clean-up has taken
/// their noise out, and the limiter guards the peaks. The cap only stops a
/// file of near silence being blown up.
const MAX_GAIN_DB: f64 = 24.0;
const CEILING_DBTP: f64 = -1.5;

// ─── Options and saved state ──────────────────────────────────────────────────

/// What to do. Changing any of these needs a new run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceOptions {
    /// The clean-up: `dpdfnet` | `none`. Runs saved by earlier versions may
    /// say `clear` or `both` (models Wave no longer has), and those from
    /// before this field existed were Clear runs; they still play, but can't
    /// be run again as they were.
    #[serde(default = "legacy_models")]
    pub models:    String,
    /// Loudness target: `podcast` (−19 LUFS, AES's figure for mono podcasts) |
    /// `streaming` (−14, Spotify and YouTube) | `broadcast` (−23, EBU R 128) | `off`.
    pub loudness:  String,
    /// How much of the clean-up to keep, 0–1 (the rest is the original).
    pub strength:  f32,
    /// EQ preset (eq.rs), or `off`.
    #[serde(default = "off")]
    pub eq:        String,
    /// How much of it: `subtle` | `medium` | `strong`.
    #[serde(default = "medium")]
    pub eq_amount: String,
}

fn legacy_models() -> String { "clear".into() }
fn off() -> String { "off".into() }
fn medium() -> String { "medium".into() }

impl Default for EnhanceOptions {
    fn default() -> Self {
        Self { models: "dpdfnet".into(), loudness: "podcast".into(), strength: 1.0, eq: off(), eq_amount: medium() }
    }
}

impl EnhanceOptions {
    fn cleans(&self) -> bool { self.models == "dpdfnet" }

    fn target_lufs(&self) -> Option<f64> {
        match self.loudness.as_str() {
            "podcast"   => Some(-19.0),
            "streaming" => Some(-14.0),
            "broadcast" => Some(-23.0),
            _           => None,
        }
    }

    /// What made it, as saved: `dpdfnet@dd6818d+eq:clearer`, `eq:warmer`, `none`.
    fn label(&self) -> String {
        let mut parts = Vec::new();
        if self.cleans() { parts.push(format!("{}@{}", crate::models::DPDFNET_ID, crate::dpdfnet::MODEL_REVISION)); }
        if self.eq != "off" { parts.push(format!("eq:{}", self.eq)); }
        if parts.is_empty() { "none".into() } else { parts.join("+") }
    }

    /// Something Wave can run, with something to do.
    fn checked(&self) -> Result<(), String> {
        match self.models.as_str() {
            "dpdfnet" | "none" => {}
            "clear" | "both" => return Err("Clear is no longer part of Wave: clean up with DPDFNet instead".into()),
            other => return Err(format!("Unknown clean-up \"{other}\"")),
        }
        if !crate::eq::is_known(&self.eq) { return Err(format!("Unknown EQ preset \"{}\"", self.eq)); }
        if !self.cleans() && self.eq == "off" && self.target_lufs().is_none() {
            return Err("Nothing to do: choose a clean-up, an EQ or a loudness target".into());
        }
        Ok(())
    }

    /// The DPDFNet model, if this run cleans up (or which download is missing).
    fn model(&self, app: &AppHandle) -> Result<Option<PathBuf>, String> {
        if !self.cleans() { return Ok(None); }
        crate::models::installed_model_path(app, crate::models::DPDFNET_ID)
            .map(Some)
            .ok_or_else(|| "Download DPDFNet in Settings first".into())
    }
}

/// `enhance.json`: the last run and whether it's switched on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enhancement {
    pub version:        u32,
    /// What produced it (`EnhanceOptions::label`).
    pub model:          String,
    /// The enhanced audio in the project folder: 48 kHz mono 16-bit WAV. A new
    /// name per run, so the WebView never plays a cached copy.
    pub file:           String,
    pub options:        EnhanceOptions,
    /// Play and export the enhanced audio instead of the original.
    pub enabled:        bool,
    pub duration_ms:    i64,
    /// Integrated loudness before the loudness stage (LUFS).
    pub measured_lufs:  Option<f64>,
    /// True peak of the result (dBTP), when a loudness target was set.
    pub true_peak_dbfs: Option<f64>,
    pub elapsed_ms:     u64,
}

/// What the frontend gets: the saved state plus where the audio is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancementState {
    #[serde(flatten)]
    pub info:       Enhancement,
    pub audio_path: String,
}

fn read_info(dir: &Path) -> Option<Enhancement> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("enhance.json")).ok()?).ok()
}

fn write_info(dir: &Path, info: &Enhancement) -> Result<(), String> {
    let json = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("enhance.json"), json).map_err(|e| e.to_string())
}

fn state_of(dir: &Path, info: Enhancement) -> Option<EnhancementState> {
    let path = dir.join(&info.file);
    path.exists().then(|| EnhancementState { audio_path: path.to_string_lossy().into_owned(), info })
}

/// The enhanced audio of a project, if it has one (whether or not it's on).
pub fn enhanced_audio_path(dir: &Path) -> Option<PathBuf> {
    let path = dir.join(read_info(dir)?.file);
    path.exists().then_some(path)
}

/// Projects whose run should stop.
static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn set_cancelled(project_id: &str, cancelled: bool) {
    let mut guard = CANCELLED.lock().unwrap_or_else(|e| e.into_inner());
    let set = guard.get_or_insert_with(HashSet::new);
    if cancelled { set.insert(project_id.to_string()); } else { set.remove(project_id); }
}

fn is_cancelled(project_id: &str) -> bool {
    CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(project_id))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Enhance a project's original audio and switch the enhancement on. Emits
/// `enhance:progress` → { projectId, phase: "decoding" | "enhancing" |
/// "mastering", progress (0–1 overall) }.
#[tauri::command]
pub async fn enhance_audio(app: AppHandle, project_id: String, options: EnhanceOptions) -> Result<EnhancementState, String> {
    let dir = project_dir(&app, &project_id)?;
    options.checked()?;
    let model = options.model(&app)?;
    let source = find_original_audio(&dir)
        .or_else(|| Some(dir.join("audio_16k.wav")).filter(|p| p.exists()))
        .ok_or("No audio to enhance: import audio first")?;
    let previous = read_info(&dir);
    set_cancelled(&project_id, false);

    let file = format!("audio_enhanced-{}.wav", now_ms());
    let dest = dir.join(&file);
    let (events, id, run) = (app.clone(), project_id.clone(), options.clone());
    let result = tokio::task::spawn_blocking(move || {
        let emit = |phase: &str, progress: f32| {
            let _ = events.emit("enhance:progress", serde_json::json!({ "projectId": id, "phase": phase, "progress": progress }));
        };
        enhance_file(model.as_deref(), &source, &dest, &run, &emit, &|| is_cancelled(&id))
    })
    .await
    .map_err(|e| e.to_string())?;
    set_cancelled(&project_id, false);
    let report = result?;

    let info = Enhancement {
        version:        1,
        model:          options.label(),
        file:           file.clone(),
        options,
        enabled:        true,
        duration_ms:    report.duration_ms,
        measured_lufs:  report.measured_lufs,
        true_peak_dbfs: report.true_peak,
        elapsed_ms:     report.elapsed_ms,
    };
    write_info(&dir, &info)?;
    if let Some(old) = previous.filter(|p| p.file != file) {
        let _ = std::fs::remove_file(dir.join(old.file));
    }
    state_of(&dir, info).ok_or_else(|| "The enhanced audio wasn't written".into())
}

/// Stop a running enhancement; `enhance_audio` then fails with "Cancelled".
#[tauri::command]
pub fn cancel_enhance(project_id: String) {
    set_cancelled(&project_id, true);
}

/// The project's enhancement, if it has one.
#[tauri::command]
pub fn get_enhancement(app: AppHandle, project_id: String) -> Result<Option<EnhancementState>, String> {
    let dir = project_dir(&app, &project_id)?;
    Ok(read_info(&dir).and_then(|info| state_of(&dir, info)))
}

/// Switch between the enhanced and the original audio (saved).
#[tauri::command]
pub fn set_enhancement_enabled(app: AppHandle, project_id: String, enabled: bool) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    let mut info = read_info(&dir).ok_or("This project hasn't been enhanced")?;
    info.enabled = enabled;
    write_info(&dir, &info)
}

/// Delete the enhanced audio and go back to the original.
#[tauri::command]
pub fn remove_enhancement(app: AppHandle, project_id: String) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    if let Some(info) = read_info(&dir) {
        let _ = std::fs::remove_file(dir.join(info.file));
    }
    match std::fs::remove_file(dir.join("enhance.json")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

// ─── The steps ────────────────────────────────────────────────────────────────

struct Report {
    duration_ms:   i64,
    measured_lufs: Option<f64>,
    true_peak:     Option<f64>,
    elapsed_ms:    u64,
}

/// Decode `source`, enhance it and write `dest` (through a `.part` file).
/// Progress: decoding to 5 %, the clean-up to 95 %, the rest after.
fn enhance_file(
    model:     Option<&Path>,
    source:    &Path,
    dest:      &Path,
    options:   &EnhanceOptions,
    emit:      &dyn Fn(&str, f32),
    cancelled: &dyn Fn() -> bool,
) -> Result<Report, String> {
    let started = Instant::now();
    emit("decoding", 0.0);
    let mut audio = decode_48k(source)?;
    if audio.is_empty() { return Err("The audio is empty".into()); }
    if cancelled() { return Err("Cancelled".into()); }

    emit("enhancing", 0.05);
    clean_up(model, &mut audio, options.strength, &mut |p| emit("enhancing", 0.05 + 0.9 * p), cancelled)?;
    shape(&mut audio, options);
    emit("mastering", 0.95);
    let (measured_lufs, true_peak) = level(&mut audio, options);

    let part = dest.with_extension("wav.part");
    write_wav(&part, &audio)?;
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    emit("mastering", 1.0);
    Ok(Report {
        duration_ms: (audio.len() as u64 * 1000 / SAMPLE_RATE as u64) as i64,
        measured_lufs,
        true_peak,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// The whole file at 48 kHz, mixed to mono.
fn decode_48k(source: &Path) -> Result<Vec<f32>, String> {
    let (audio, rate, _) = decode_to_mono_f32(source)?;
    if rate == SAMPLE_RATE { Ok(audio) } else { resample_mono(&audio, rate, SAMPLE_RATE) }
}

/// Step 1, in place: DPDFNet if there's a model, then `strength` of it mixed
/// with the original. Progress 0–1.
fn clean_up(model: Option<&Path>, audio: &mut [f32], strength: f32, progress: &mut dyn FnMut(f32),
            cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let Some(model) = model else { return Ok(()) };
    let keep = strength.clamp(0.0, 1.0);
    let original = (keep < 1.0).then(|| audio.to_vec());
    crate::dpdfnet::Dpdfnet::load(model)?.enhance(audio, progress, cancelled)?;
    if let Some(original) = original {
        for (cleaned, plain) in audio.iter_mut().zip(original) {
            *cleaned = keep * *cleaned + (1.0 - keep) * plain;
        }
    }
    Ok(())
}

/// Step 2, in place: the EQ preset, if any.
fn shape(audio: &mut [f32], options: &EnhanceOptions) {
    crate::eq::apply(audio, SAMPLE_RATE as f64, &options.eq, crate::eq::amount_scale(&options.eq_amount));
}

/// Step 3, in place: the loudness target, if any. Returns (loudness before,
/// true peak after).
fn level(audio: &mut [f32], options: &EnhanceOptions) -> (Option<f64>, Option<f64>) {
    match options.target_lufs() {
        Some(target) => {
            let done = crate::master::master(audio, SAMPLE_RATE as f64, target, MAX_GAIN_DB, CEILING_DBTP);
            (done.measured_lufs, done.true_peak_dbtp)
        }
        None => (crate::master::integrated_loudness(audio, SAMPLE_RATE as f64), None),
    }
}

/// 48 kHz mono 16-bit PCM, which WebKit decodes reliably.
fn write_wav(path: &Path, audio: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec { channels: 1, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| format!("Couldn't write the enhanced audio: {e}"))?;
    for &x in audio {
        writer.write_sample((x.clamp(-1.0, 1.0) * 32767.0).round() as i16).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}

// ─── Preview ──────────────────────────────────────────────────────────────────

/// A stretch run through the chosen enhancement, and the same stretch untouched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhancePreview {
    /// The original at the enhanced version's loudness, so listening compares
    /// the sound, not the volume.
    pub original:  String,
    pub enhanced:  String,
    pub start_ms:  i64,
    pub length_ms: i64,
}

/// Seconds decoded before the previewed stretch, so the clean-up has settled
/// by the part you hear.
const PREVIEW_LEAD_S: f64 = 4.0;

/// Run `options` on `length_ms` (5–30 s) from `start_ms`. Only that stretch
/// (and the lead before it) is decoded; loudness is measured on it alone.
#[tauri::command]
pub async fn preview_enhancement(app: AppHandle, project_id: String, start_ms: f64, length_ms: f64, options: EnhanceOptions) -> Result<EnhancePreview, String> {
    let dir = project_dir(&app, &project_id)?;
    options.checked()?;
    let model = options.model(&app)?;
    let source = find_original_audio(&dir).ok_or("No audio to preview: import audio first")?;
    let length_s = (length_ms / 1000.0).clamp(5.0, 30.0);
    let start_s = (start_ms / 1000.0).max(0.0);

    // Only the latest preview is kept (any left over go at launch).
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("preview_enh_") { let _ = std::fs::remove_file(entry.path()); }
        }
    }
    let stamp = now_ms();
    let original = dir.join(format!("preview_enh_{stamp}_original.wav"));
    let enhanced = dir.join(format!("preview_enh_{stamp}_enhanced.wav"));
    let (a, b) = (original.clone(), enhanced.clone());
    let length = tokio::task::spawn_blocking(move || render_preview(model.as_deref(), &source, start_s, length_s, &options, &a, &b))
        .await
        .map_err(|e| e.to_string())??;

    Ok(EnhancePreview {
        original:  original.to_string_lossy().into_owned(),
        enhanced:  enhanced.to_string_lossy().into_owned(),
        start_ms:  (start_s * 1000.0) as i64,
        length_ms: length,
    })
}

/// Write the enhanced stretch and the untouched one at its loudness (limited
/// the same way). Returns the length (ms).
fn render_preview(model: Option<&Path>, source: &Path, start_s: f64, length_s: f64, options: &EnhanceOptions,
                  original: &Path, enhanced: &Path) -> Result<i64, String> {
    let lead = PREVIEW_LEAD_S.min(start_s);
    let (raw, rate) = decode_window_mono(source, start_s - lead, start_s + length_s)?;
    let mut audio = if rate == SAMPLE_RATE { raw } else { resample_mono(&raw, rate, SAMPLE_RATE)? };
    let skip = ((lead * SAMPLE_RATE as f64) as usize).min(audio.len());
    if audio.len() - skip < SAMPLE_RATE as usize / 2 { return Err("There's no audio to preview here".into()); }
    let mut plain = audio[skip..].to_vec();

    clean_up(model, &mut audio, options.strength, &mut |_| {}, &|| false)?;
    shape(&mut audio, options);
    let mut out = audio[skip..].to_vec();
    level(&mut out, options);

    // The untouched stretch at the enhanced one's loudness.
    let rate = SAMPLE_RATE as f64;
    if let (Some(a), Some(b)) = (crate::master::integrated_loudness(&plain, rate), crate::master::integrated_loudness(&out, rate)) {
        let gain = 10f64.powf((b - a).clamp(-24.0, 24.0) / 20.0) as f32;
        plain.iter_mut().for_each(|x| *x *= gain);
        crate::master::limit(&mut plain, rate, CEILING_DBTP);
    }
    write_wav(original, &plain)?;
    write_wav(enhanced, &out)?;
    Ok((plain.len() as u64 * 1000 / SAMPLE_RATE as u64) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(models: &str, eq: &str, loudness: &str) -> EnhanceOptions {
        EnhanceOptions { models: models.into(), eq: eq.into(), loudness: loudness.into(), ..Default::default() }
    }

    #[test]
    fn options_say_what_runs_and_refuse_what_cant() {
        assert_eq!(options("dpdfnet", "clearer", "podcast").label(), format!("dpdfnet@{}+eq:clearer", crate::dpdfnet::MODEL_REVISION));
        assert_eq!(options("none", "warmer", "off").label(), "eq:warmer");
        assert!(options("dpdfnet", "off", "off").checked().is_ok());
        assert!(options("none", "off", "podcast").checked().is_ok());
        assert!(options("none", "off", "off").checked().is_err(), "nothing to do");
        assert!(options("clear", "off", "podcast").checked().unwrap_err().contains("no longer"));
        assert!(options("both", "off", "podcast").checked().is_err());
        assert!(options("dpdfnet", "telephone", "podcast").checked().is_err());
    }

    #[test]
    fn runs_saved_by_earlier_versions_still_read() {
        // Before `models` existed (a Clear run), with Clear's `variant`.
        let old: EnhanceOptions = serde_json::from_str(r#"{"variant":"studio","loudness":"podcast","strength":0.7}"#).unwrap();
        assert_eq!((old.models.as_str(), old.eq.as_str(), old.eq_amount.as_str()), ("clear", "off", "medium"));
    }

    #[test]
    fn without_a_clean_up_the_steps_keep_time_and_reach_the_target() {
        let rate = SAMPLE_RATE as f64;
        let x: Vec<f32> = (0..(6.0 * rate) as usize).map(|i| (0.02 * (2.0 * std::f64::consts::PI * 300.0 * i as f64 / rate).sin()) as f32).collect();
        let mut y = x.clone();
        let o = options("none", "off", "podcast");
        clean_up(None, &mut y, 1.0, &mut |_| {}, &|| false).unwrap();
        shape(&mut y, &o);
        let (before, peak) = level(&mut y, &o);
        assert_eq!(y.len(), x.len());
        assert!(before.unwrap() < -30.0);
        let after = crate::master::integrated_loudness(&y, rate).unwrap();
        assert!((after - -19.0).abs() < 0.1, "reaches the target: {after:.2} LUFS (from {:.1})", before.unwrap());
        assert!(peak.unwrap() <= CEILING_DBTP + 0.05);
    }

    /// The enhanced audio stays in step with the original (not run by
    /// default; needs DPDFNet and a real file): the same length, and no offset
    /// anywhere, with any strength and EQ. Offsets would comb-filter the
    /// strength mix and move edits.
    /// `DPDFNET_MODEL=… ENHANCE_IN=… cargo test enhance::tests::stays_in_step -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn stays_in_step() {
        let model = PathBuf::from(std::env::var("DPDFNET_MODEL").expect("DPDFNET_MODEL"));
        let input = PathBuf::from(std::env::var("ENHANCE_IN").expect("ENHANCE_IN"));
        let original = decode_48k(&input).unwrap();

        /// The offset (samples) where `y` best matches `x` within ±10 ms of
        /// `at`, over 2 s.
        fn offset(x: &[f32], y: &[f32], at: usize) -> i64 {
            let len = 2 * SAMPLE_RATE as usize;
            (-480i64..=480).map(|lag| {
                let (mut xy, mut xx, mut yy) = (0f64, 0f64, 0f64);
                for i in at..at + len {
                    let j = i as i64 + lag;
                    if j < 0 || j as usize >= y.len() { continue; }
                    let (a, b) = (x[i] as f64, y[j as usize] as f64);
                    xy += a * b; xx += a * a; yy += b * b;
                }
                (lag, xy / (xx * yy).sqrt().max(1e-12))
            }).max_by(|a, b| a.1.total_cmp(&b.1)).unwrap().0
        }

        let dir = std::env::temp_dir().join(format!("wave-step-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (models, strength, eq) in [("dpdfnet", 1.0, "off"), ("dpdfnet", 0.7, "off"), ("dpdfnet", 0.4, "clearer"), ("none", 1.0, "brighter")] {
            let o = EnhanceOptions { models: models.into(), strength, eq: eq.into(), ..Default::default() };
            let out = dir.join(format!("{models}-{strength}-{eq}.wav"));
            enhance_file((models == "dpdfnet").then_some(model.as_path()), &input, &out, &o, &|_, _| {}, &|| false).unwrap();
            let y = crate::transcription::read_wav_f32(&out).unwrap();
            // Compared through the same EQ: the EQ reshapes the waveform (phase)
            // without moving it in time.
            let mut reference = original.clone();
            shape(&mut reference, &o);
            let points: Vec<usize> = (1..=8).map(|k| k * (reference.len() - 3 * SAMPLE_RATE as usize) / 9).collect();
            let lags: Vec<i64> = points.iter().map(|&at| offset(&reference, &y, at)).collect();
            println!("{models:<8} strength {strength:.1} EQ {eq:<9} length {:+} · offsets {lags:?}", y.len() as i64 - reference.len() as i64);
            assert_eq!(y.len(), reference.len());
            assert!(lags.iter().all(|&l| l.abs() <= 2), "offsets {lags:?}");
        }
    }

    /// DPDFNet on a real recording with noise and room echo mixed in (not run
    /// by default): SI-SDR against the clean recording (higher is closer) and
    /// how much noise is left in the pauses. A yardstick for any other model.
    /// `DPDFNET_MODEL=… ENHANCE_IN=… cargo test enhance::tests::clean_up_yardstick -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn clean_up_yardstick() {
        let model = PathBuf::from(std::env::var("DPDFNET_MODEL").expect("DPDFNET_MODEL"));
        let input = PathBuf::from(std::env::var("ENHANCE_IN").expect("ENHANCE_IN"));
        let speech = decode_48k(&input).unwrap();
        let rate = SAMPLE_RATE as f64;
        let rms = |x: &[f32]| (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();

        // Broadband hiss: white noise through three one-pole low-passes summed
        // with some of it unfiltered, which tilts it towards pink.
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut lows = [0f64; 3];
        let hiss: Vec<f32> = (0..speech.len()).map(|_| {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
            let w = (seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5;
            for (low, a) in lows.iter_mut().zip([0.997, 0.96, 0.6]) { *low = a * *low + (1.0 - a) * w; }
            (lows[0] * 8.0 + lows[1] * 3.0 + lows[2] + 0.2 * w) as f32
        }).collect();
        // A room: four feedback delays (0.6 s decay), mixed 6 dB under the voice.
        let mut wet = vec![0f32; speech.len()];
        for ms in [29.7f64, 37.1, 41.1, 43.7] {
            let d = (ms / 1000.0 * rate) as usize;
            let g = 10f64.powf(-3.0 * (ms / 1000.0) / 0.6) as f32;
            let mut y = vec![0f32; speech.len()];
            for i in 0..speech.len() { y[i] = speech[i] + if i >= d { g * y[i - d] } else { 0.0 }; }
            for i in 0..speech.len() { wet[i] += y[i] / 4.0; }
        }
        let wet_gain = (rms(&speech) / rms(&wet) / 2.0) as f32;
        let room: Vec<f32> = speech.iter().zip(&wet).map(|(s, w)| s + wet_gain * w).collect();

        let si_sdr = |y: &[f32]| {
            let k = y.iter().zip(&speech).map(|(a, b)| *a as f64 * *b as f64).sum::<f64>() / speech.iter().map(|b| (*b as f64).powi(2)).sum::<f64>();
            let (t, e) = y.iter().zip(&speech).fold((0f64, 0f64), |(t, e), (a, b)| {
                let target = k * *b as f64;
                (t + target * target, e + (*a as f64 - target).powi(2))
            });
            10.0 * (t / e).log10()
        };
        let frame = SAMPLE_RATE as usize / 50;
        let frames: Vec<f64> = speech.chunks(frame).map(|f| rms(f)).collect();
        let loudest = frames.iter().cloned().fold(0.0, f64::max);
        let pauses: Vec<usize> = (0..frames.len()).filter(|&i| frames[i] < loudest * 10f64.powf(-45.0 / 20.0)).collect();
        let pause_rms = |x: &[f32]| (pauses.iter().map(|&i| x[i * frame..((i + 1) * frame).min(x.len())].iter().map(|v| (*v as f64).powi(2)).sum::<f64>()).sum::<f64>() / (pauses.len() * frame) as f64).sqrt();

        let noisy = |base: &[f32], snr_db: f64| -> Vec<f32> {
            let g = (rms(&speech) / rms(&hiss) / 10f64.powf(snr_db / 20.0)) as f32;
            base.iter().zip(&hiss).map(|(s, n)| s + g * n).collect()
        };
        for (label, mixed) in [("hiss, 10 dB SNR", noisy(&speech, 10.0)), ("hiss, 0 dB SNR", noisy(&speech, 0.0)), ("room echo", room.clone()), ("hiss and room, 10 dB", noisy(&room, 10.0))] {
            let mut y = mixed.clone();
            let started = Instant::now();
            clean_up(Some(&model), &mut y, 1.0, &mut |_| {}, &|| false).unwrap();
            println!("{label:<22} SI-SDR {:5.1} → {:5.1} dB · pauses {:+6.1} dB · {:.1} s",
                si_sdr(&mixed), si_sdr(&y), 20.0 * (pause_rms(&y) / pause_rms(&mixed).max(1e-12)).log10(), started.elapsed().as_secs_f64());
        }
    }

    /// A preview from the middle of a real file (not run by default): both
    /// versions the same length and loudness. `PREVIEW_AT` (s) picks where.
    /// `DPDFNET_MODEL=… ENHANCE_IN=… ENHANCE_OUT=/tmp/p cargo test enhance::tests::preview_window -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn preview_window() {
        let model = PathBuf::from(std::env::var("DPDFNET_MODEL").expect("DPDFNET_MODEL"));
        let input = PathBuf::from(std::env::var("ENHANCE_IN").expect("ENHANCE_IN"));
        let out = PathBuf::from(std::env::var("ENHANCE_OUT").expect("ENHANCE_OUT"));
        let at: f64 = std::env::var("PREVIEW_AT").ok().and_then(|v| v.parse().ok()).unwrap_or(30.0);
        let (a, b) = (out.with_extension("original.wav"), out.with_extension("enhanced.wav"));
        let started = Instant::now();
        let ms = render_preview(Some(&model), &input, at, 15.0, &EnhanceOptions::default(), &a, &b).unwrap();
        let (x, y) = (crate::transcription::read_wav_f32(&a).unwrap(), crate::transcription::read_wav_f32(&b).unwrap());
        let rate = SAMPLE_RATE as f64;
        let (lx, ly) = (crate::master::integrated_loudness(&x, rate).unwrap(), crate::master::integrated_loudness(&y, rate).unwrap());
        println!("{ms} ms from {at} s in {:.2} s · original {lx:.1} LUFS · enhanced {ly:.1} LUFS", started.elapsed().as_secs_f64());
        assert_eq!(x.len(), y.len());
        assert!((14_500..=15_000).contains(&ms));
        assert!((lx - ly).abs() < 1.0, "not loudness-matched: {lx:.1} vs {ly:.1}");
    }

    /// A whole real file with the default options (not run by default): speed,
    /// loudness and peak. `DPDFNET_MODEL=… ENHANCE_IN=… ENHANCE_OUT=/tmp/out.wav
    /// [EQ=brighter] cargo test enhance::tests::real_audio -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_audio() {
        let model = PathBuf::from(std::env::var("DPDFNET_MODEL").expect("DPDFNET_MODEL"));
        let input = PathBuf::from(std::env::var("ENHANCE_IN").expect("ENHANCE_IN"));
        let out = PathBuf::from(std::env::var("ENHANCE_OUT").expect("ENHANCE_OUT"));
        let o = EnhanceOptions { eq: std::env::var("EQ").unwrap_or_else(|_| "off".into()), ..Default::default() };
        let report = enhance_file(Some(&model), &input, &out, &o, &|_, _| {}, &|| false).unwrap();
        let secs = report.duration_ms as f64 / 1000.0;
        let after = crate::master::integrated_loudness(&crate::transcription::read_wav_f32(&out).unwrap(), SAMPLE_RATE as f64);
        println!("{secs:.1} s in {:.1} s ({:.0}× real time) · {:?} LUFS before, {after:?} after · true peak {:?} dBTP",
            report.elapsed_ms as f64 / 1000.0, secs / (report.elapsed_ms as f64 / 1000.0), report.measured_lufs, report.true_peak);
    }
}
