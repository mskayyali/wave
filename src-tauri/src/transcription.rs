use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::projects::{project_dir, read_project, write_project, ProjectStatus};

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text:        String,
    pub start_ms:    i64,
    pub end_ms:      i64,
    pub confidence:  f32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub words:       Vec<Word>,
    pub language:    String,
    pub duration_ms: i64,
}

// ─── Read transcript ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_transcript(
    app:        AppHandle,
    project_id: String,
) -> Result<Option<Transcript>, String> {
    let dir  = project_dir(&app, &project_id)?;
    let path = dir.join("transcript.json");
    if !path.exists() {
        return Ok(None);
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let t: Transcript = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(Some(t))
}

// ─── Re-align command ─────────────────────────────────────────────────────────

/// Re-run forced alignment on an existing transcript without re-transcribing.
/// Word text and order are unchanged — only timings move — so index-based edits
/// stay valid, and their cuts now land on the corrected word boundaries.
#[tauri::command]
pub async fn realign_transcript(app: AppHandle, project_id: String) -> Result<Transcript, String> {
    let dir   = project_dir(&app, &project_id)?;
    let model = crate::models::aligner_path(&app)
        .ok_or("Finish the Transcription download in Settings first (it includes word alignment)")?;
    let transcript = get_transcript(app.clone(), project_id)?
        .ok_or("This project has no transcript to align")?;
    if transcript.language != "en" {
        return Err("Word alignment currently supports English only".into());
    }

    let wav = dir.join("audio_16k.wav");
    let aligned = tokio::task::spawn_blocking(move || -> Result<Transcript, String> {
        let audio = read_wav_f32(&wav)?;
        let mut transcript = transcript;
        align_and_tidy(&model, &audio, &mut transcript.words)?;
        Ok(transcript)
    })
    .await
    .map_err(|e| e.to_string())??;

    let json = serde_json::to_string_pretty(&aligned).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("transcript.json"), json).map_err(|e| e.to_string())?;
    Ok(aligned)
}

// ─── Transcribe command ───────────────────────────────────────────────────────

/// Begin async transcription. Returns immediately; results come via events:
///   `transcription:progress`  → { projectId, percentage }
///   `transcription:complete`  → { projectId }
///   `transcription:error`     → { projectId, message }
#[tauri::command]
pub async fn transcribe(
    app:        AppHandle,
    project_id: String,
    model_id:   String,
) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    if !dir.exists() {
        return Err("Project not found".into());
    }

    // Resolve model path
    let model_filename = format!("ggml-{}.bin", model_id);
    let model_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join(&model_filename);

    if !model_path.exists() {
        return Err(format!("Model file not found: {}", model_filename));
    }

    // Mark project as transcribing
    if let Some(mut project) = read_project(&dir) {
        project.status = ProjectStatus::Transcribing;
        let _ = write_project(&dir, &project);
    }

    let _ = app.emit("transcription:progress", serde_json::json!({
        "projectId": project_id,
        "percentage": 0,
    }));

    let app2 = app.clone();
    let pid   = project_id.clone();

    tokio::spawn(async move {
        match run_transcription(app2.clone(), pid.clone(), model_path, model_id, dir).await {
            Ok(()) => {
                let _ = app2.emit("transcription:complete", serde_json::json!({
                    "projectId": pid,
                }));
            }
            Err(e) => {
                // Persist error on project
                if let Ok(d) = project_dir(&app2, &pid) {
                    if let Some(mut p) = read_project(&d) {
                        p.status = ProjectStatus::Error { message: e.clone() };
                        let _ = write_project(&d, &p);
                    }
                }
                let _ = app2.emit("transcription:error", serde_json::json!({
                    "projectId": pid,
                    "message": e,
                }));
            }
        }
    });

    Ok(())
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async fn run_transcription(
    app:        AppHandle,
    project_id: String,
    model_path: PathBuf,
    model_id:   String,
    dir:        PathBuf,
) -> Result<(), String> {
    let wav_path = dir.join("audio_16k.wav");
    if !wav_path.exists() {
        return Err("audio_16k.wav not found — import audio first".into());
    }

    emit_progress(&app, &project_id, 5).await;

    // ── 1. Read WAV into f32 PCM ──────────────────────────────────────────────
    let wav_path2 = wav_path.clone();
    let audio = tokio::task::spawn_blocking(move || read_wav_f32(&wav_path2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("WAV read failed: {}", e))?;

    let duration_ms = (audio.len() as i64 * 1000) / 16_000;

    emit_progress(&app, &project_id, 10).await;

    // ── 2. Run whisper, then refine word timings, in a blocking thread ────────
    let aligner  = crate::models::aligner_path(&app);
    let app_cb   = app.clone();
    let pid_cb   = project_id.clone();
    let app_al   = app.clone();
    let pid_al   = project_id.clone();
    let (words, language) = tokio::task::spawn_blocking(move || {
        let (mut words, language) = run_whisper(&model_path, &model_id, &audio, move |progress: i32| {
            // Map whisper's 0–100 → our 10–90 range
            let _ = app_cb.emit("transcription:progress", serde_json::json!({
                "projectId": pid_cb,
                "percentage": 10 + (progress * 80 / 100),
            }));
        })?;
        let _ = app_al.emit("transcription:progress", serde_json::json!({
            "projectId": pid_al,
            "percentage": 91,
        }));
        finalize_timings(&audio, &mut words, aligner.as_deref(), &language);
        Ok::<_, String>((words, language))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Transcription failed: {}", e))?;

    emit_progress(&app, &project_id, 95).await;

    // ── 3. Save transcript.json ───────────────────────────────────────────────
    let transcript = Transcript { words, language, duration_ms };
    let json = serde_json::to_string_pretty(&transcript).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("transcript.json"), json).map_err(|e| e.to_string())?;

    // ── 4. Update project status ──────────────────────────────────────────────
    if let Some(mut project) = read_project(&dir) {
        project.status = ProjectStatus::Ready;
        write_project(&dir, &project)?;
    }

    emit_progress(&app, &project_id, 100).await;
    Ok(())
}

async fn emit_progress(app: &AppHandle, project_id: &str, pct: u8) {
    let _ = app.emit("transcription:progress", serde_json::json!({
        "projectId": project_id,
        "percentage": pct,
    }));
}

// ─── Blocking helpers ─────────────────────────────────────────────────────────

// ─── Timing refinement against the audio ──────────────────────────────────────

/// Tighten word boundaries against the actual audio (an energy VAD) so no word
/// sits on silence and real pauses become visible, cuttable gaps.
///
/// DTW word starts land in the right place but run ~150 ms late on average, and
/// consecutive words are back-to-back, so pauses get swallowed into the word
/// before them. This pass:
///
/// 1. Computes 10 ms frame energies and a speech threshold adapted to the
///    recording: loud speech (p90) − 25 dB, but at least 10 dB above the noise
///    floor (p10), clamped to [−55, −25] dBFS. Anchoring to the speech level
///    keeps breaths and room tails out of "speech" on clean studio recordings;
///    the noise-floor bound keeps it above hiss on noisy ones.
/// 2. Snaps each word's start to a speech onset (≥ 200 ms of silence followed by
///    a confirmed voiced run) within `snap` = (ms before, ms after) its start:
///    wide for DTW starts, which can be well off; narrow and early-only after
///    forced alignment, whose CTC starts lag soft onsets by a few tens of ms.
/// 3. Ends each word at the first real pause (≥ 150 ms of silence) after its
///    voiced core, so pauses — and breaths — become gaps between words.
///
/// Small pads (20 ms before, 30 ms after) keep soft attacks and decays intact.
fn refine_with_vad(audio: &[f32], words: &mut [Word], snap: Snap) {
    const FRAME_MS:         i64   = 10;
    const FRAME:            usize = 160; // 10 ms at 16 kHz
    const MIN_PAUSE_FRAMES: usize = 20;  // 200 ms of silence before an onset
    const ONSET_WINDOW:     usize = 10;  // look-ahead frames to confirm an onset…
    const ONSET_CONFIRM:    usize = 8;   // …of which at least this many are voiced
    const PRE_PAD_MS:       i64   = 20;
    const POST_PAD_MS:      i64   = 30;
    const TAIL_PAUSE_FRAMES: usize = 15; // 150 ms of silence ends a word

    if words.is_empty() || audio.len() < FRAME {
        return;
    }

    // ── 1. Frame energies + adaptive speech threshold ─────────────────────────
    let rms: Vec<f32> = audio.chunks_exact(FRAME).map(rms_window).collect();
    let threshold = speech_threshold(&rms);

    let voiced: Vec<bool> = rms.iter().map(|&r| r >= threshold).collect();
    let n = voiced.len();
    let audio_end_ms = n as i64 * FRAME_MS;
    let frame_of = |ms: i64| ((ms.max(0) / FRAME_MS) as usize).min(n);

    // Speech onsets: a confirmed voiced run following a real pause.
    let mut onsets: Vec<i64> = Vec::new();
    let mut silent_run = 0usize;
    for k in 0..n {
        if !voiced[k] {
            silent_run += 1;
            continue;
        }
        if silent_run >= MIN_PAUSE_FRAMES {
            let confirm = voiced[k..(k + ONSET_WINDOW).min(n)].iter().filter(|&&v| v).count();
            if confirm >= ONSET_CONFIRM {
                onsets.push(k as i64 * FRAME_MS);
            }
        }
        silent_run = 0;
    }

    // ── 2. Snap starts to speech onsets ───────────────────────────────────────
    // A snapped start stays after the previous word's start and before the next
    // word's original start, so word order is never disturbed.
    let original_starts: Vec<i64> = words.iter().map(|w| w.start_ms).collect();
    let mut prev_start = i64::MIN;
    for i in 0..words.len() {
        let start      = words[i].start_ms;
        let next_start = original_starts.get(i + 1).copied().unwrap_or(i64::MAX);
        let from       = onsets.partition_point(|&o| o < start - snap.before_ms);
        let best = onsets[from..]
            .iter()
            .take_while(|&&o| o <= start + snap.after_ms)
            .filter(|&&o| o > prev_start && o < next_start)
            // An onset the previous word already covers belongs to that word.
            .filter(|&&o| !snap.respect_prev_end || i == 0 || o >= words[i - 1].end_ms - 60)
            .min_by_key(|&&o| (o - start).abs())
            .copied();
        if let Some(onset) = best {
            words[i].start_ms = onset;
        }
        prev_start = words[i].start_ms;
    }

    // ── 3. End each word at the first real pause after its voiced core ────────
    // Scanning forward from the word (rather than back from the next word)
    // keeps the next word's onset ramp or a breath from blocking the trim.
    for i in 0..words.len() {
        let limit = match words.get(i + 1) {
            Some(next) => next.start_ms,
            None       => words[i].end_ms.min(audio_end_ms),
        };
        let start = words[i].start_ms;
        let (mut k, stop) = (frame_of(start), frame_of(limit));
        while k < stop && !voiced[k] {
            k += 1;
        }
        if k >= stop {
            // No speech under this word at all — leave its end where it is.
            words[i].end_ms = words[i].end_ms.min(limit).max(start + 1);
            continue;
        }
        let mut last_voiced = k;
        let mut silent_run  = 0usize;
        while k < stop {
            if voiced[k] {
                last_voiced = k;
                silent_run  = 0;
            } else {
                silent_run += 1;
                if silent_run >= TAIL_PAUSE_FRAMES {
                    break;
                }
            }
            k += 1;
        }
        let end = (last_voiced as i64 + 1) * FRAME_MS + POST_PAD_MS;
        words[i].end_ms = end.min(limit).max(start + 1);
    }

    // ── 4. Pre-pad starts that follow a gap ───────────────────────────────────
    for i in 0..words.len() {
        let floor = if i > 0 { words[i - 1].end_ms } else { 0 };
        let start = words[i].start_ms;
        words[i].start_ms = (start - PRE_PAD_MS).max(floor).min(start);
    }
}

/// The RMS level speech rises above in this recording, from its 10 ms frame
/// levels: loud speech (p90) − 25 dB, but at least 10 dB above the noise floor
/// (p10), within −55 to −25 dBFS.
fn speech_threshold(rms: &[f32]) -> f32 {
    if rms.is_empty() {
        return 0.0;
    }
    let mut sorted = rms.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let pct   = |p: f32| sorted[((sorted.len() - 1) as f32 * p) as usize];
    let to_db = |x: f32| 20.0 * x.max(1e-9).log10();
    let threshold_db = (to_db(pct(0.90)) - 25.0)
        .max(to_db(pct(0.10)) + 10.0)
        .clamp(-55.0, -25.0);
    10f32.powf(threshold_db / 20.0)
}

#[inline]
fn rms_window(samples: &[f32]) -> f32 {
    if samples.is_empty() { return 0.0; }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn read_wav_f32(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path)
        .map_err(|e| format!("Cannot open WAV: {}", e))?;

    let spec = reader.spec();
    match spec.sample_format {
        hound::SampleFormat::Float => {
            reader
                .samples::<f32>()
                .map(|s| s.map_err(|e| format!("Sample read error: {}", e)))
                .collect()
        }
        hound::SampleFormat::Int => {
            // Convert i16/i32 → f32
            let max_val = (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s
                    .map(|v| v as f32 / max_val)
                    .map_err(|e| format!("Sample read error: {}", e)))
                .collect()
        }
    }
}

/// whisper.cpp alignment-head preset for DTW token timestamps. DTW aligns tokens
/// to the audio through cross-attention and places words far more reliably than
/// the legacy timestamp-token heuristic (measured on a podcast excerpt with this
/// model: word starts landing on silence 26% → 8%). A model without a preset
/// falls back to legacy timestamps — add its preset here if one is re-added.
fn dtw_preset_for(model_id: &str) -> Option<whisper_rs::DtwModelPreset> {
    match model_id {
        "large-v3-turbo" => Some(whisper_rs::DtwModelPreset::LargeV3Turbo),
        _ => None,
    }
}

/// Transcribe 16 kHz mono PCM into timed words, the way Wave does
/// (`Decoding::default()`). Returns the words and the detected language code.
/// `on_progress` receives 0–100.
fn run_whisper(
    model_path:  &Path,
    model_id:    &str,
    audio:       &[f32],
    on_progress: impl FnMut(i32) + 'static,
) -> Result<(Vec<Word>, String), String> {
    run_whisper_with(model_path, model_id, audio, on_progress, &Decoding::default())
}

/// Read before each piece of English: speech written the way people talk,
/// fillers and all, so Whisper writes the fillers it hears instead of tidying
/// them away as its training taught it. They're then words like any other, to
/// cut in the text or by an agent.
const FILLER_PROMPT: &str = "Um, so, uh, I was like, hmm, you know. I mean, uh, we should, um, start.";

/// How Whisper decodes. The default is Wave's, chosen on a 21-minute meeting
/// (AMI ES2002a, CC-BY-4.0) against its hand transcript:
///
/// | | words wrong | fillers written | loops |
/// |---|---|---|---|
/// | whole file, greedy (before) | 36.9 % | 19 % | 7 (207 words) |
/// | whole file, beam search | 31.3 % | 21 % | 2 (106 words) |
/// | in pieces, beam search, `FILLER_PROMPT`, loop check 2.8 | 24.7 % | 68 % | none |
/// | in pieces without long silences, beam search, `FILLER_PROMPT` (Wave's) | 25.0 % | 68 % | none |
///
/// Words wrong leaves fillers out on both sides; a filler counts as written when
/// the hand transcript has one within 0.8 s (after the first minute, which it
/// barely covers), and about 70 % of those written do. The prompt on the whole
/// file doubled the fillers but looped (50 % wrong): Whisper reads it only before
/// the first 30 s. Over a long silence it wrote the prompt's end again, so
/// silences are left out (`speech_chunks`). The stricter loop check (entropy
/// 2.8 rather than whisper.cpp's 2.4) gained nothing once in pieces, and on the
/// Sample it took a word out of a run of retakes.
struct Decoding {
    /// Read before each piece, when the language is English.
    prompt:  Option<String>,
    /// The beam width, or greedy decoding.
    beam:    Option<i32>,
    /// In pieces cut at pauses (`speech_chunks`), or the whole file at once.
    chunked: bool,
}

impl Default for Decoding {
    fn default() -> Self {
        Self { prompt: Some(FILLER_PROMPT.into()), beam: Some(5), chunked: true }
    }
}

/// A word being assembled from Whisper's tokens.
struct Pending {
    text:       String,
    start_ms:   i64,
    last_t1_ms: i64,
    conf_sum:   f32,
    tokens:     u32,
}

fn run_whisper_with(
    model_path:  &Path,
    model_id:    &str,
    audio:       &[f32],
    on_progress: impl FnMut(i32) + 'static,
    decoding:    &Decoding,
) -> Result<(Vec<Word>, String), String> {
    use std::{cell::RefCell, rc::Rc};
    use whisper_rs::{
        DtwMode, DtwParameters, FullParams, SamplingStrategy, WhisperContext,
        WhisperContextParameters,
    };

    // ── Load model ────────────────────────────────────────────────────────────
    // use_gpu defaults to true when the metal feature is enabled. DTW token
    // timestamps are switched on when the model has an alignment-head preset.
    let mut ctx_params = WhisperContextParameters::default();
    if let Some(model_preset) = dtw_preset_for(model_id) {
        ctx_params.dtw_parameters(DtwParameters {
            mode: DtwMode::ModelPreset { model_preset },
            ..DtwParameters::default()
        });
    }
    let ctx = WhisperContext::new_with_params(model_path, ctx_params)
        .map_err(|e| format!("Failed to load model: {}", e))?;

    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Failed to create whisper state: {}", e))?;

    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);

    // ── The language ──────────────────────────────────────────────────────────
    // Whisper alone would decide it from the first 30 s; averaging over the
    // first three pieces keeps a music intro from deciding it. It's then held
    // for every piece, so a short piece can't switch it.
    let pieces = speech_chunks(audio);
    let language = detect_language(&mut state, audio, &pieces[..pieces.len().min(3)], threads)?;
    let pieces = if decoding.chunked { pieces } else { vec![0..audio.len()] };

    // ── Run transcription, a piece at a time ──────────────────────────────────
    let on_progress = Rc::new(RefCell::new(on_progress));
    let mut pending: Vec<Pending> = Vec::new();

    for piece in pieces {
        let mut params = FullParams::new(match decoding.beam {
            Some(beam_size) => SamplingStrategy::BeamSearch { beam_size, patience: -1.0 },
            None => SamplingStrategy::Greedy { best_of: 1 },
        });
        if let (Some(prompt), "en") = (&decoding.prompt, language.as_str()) {
            params.set_initial_prompt(prompt);
        }
        params.set_token_timestamps(true);
        params.set_language(Some(&language));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        // Ask Whisper to split segments at word boundaries where possible.
        params.set_split_on_word(true);
        params.set_n_threads(threads as i32);
        // Whisper reports 0–100 for each piece; report it for the whole file.
        let (done, len, total) = (piece.start, piece.len(), audio.len().max(1));
        let report = Rc::clone(&on_progress);
        params.set_progress_callback_safe(move |p: i32| {
            let heard = done + len * p.clamp(0, 100) as usize / 100;
            (report.borrow_mut())((heard * 100 / total) as i32);
        });

        state
            .full(params, &audio[piece.clone()])
            .map_err(|e| format!("Whisper inference failed: {}", e))?;
        collect_words(&state, (piece.start * 1000 / 16_000) as i64, &mut pending);
    }

    // DTW times are monotonic in practice; clamp anyway so ends stay valid.
    for i in 1..pending.len() {
        if pending[i].start_ms < pending[i - 1].start_ms {
            pending[i].start_ms = pending[i - 1].start_ms;
        }
    }

    let words: Vec<Word> = pending
        .iter()
        .enumerate()
        .map(|(i, w)| Word {
            text:       w.text.clone(),
            start_ms:   w.start_ms,
            end_ms:     pending.get(i + 1).map_or(w.last_t1_ms, |next| next.start_ms),
            confidence: w.conf_sum / w.tokens as f32,
        })
        .collect();

    Ok((words, language))
}

/// What Whisper hears, as pieces of at most 30 s: the recording without its
/// silences, cut in pauses.
///
/// - **Silences** of 2 s or more, 10 dB under the speech threshold, are left
///   out, less 300 ms either side. Whisper invents words in silence ("Thank
///   you.", or its prompt again). On a 21-minute meeting (AMI ES2002a) this
///   leaves out 79 s and none of the hand-annotated words.
/// - **Pieces** of 15–30 s, each ending in the middle of the quietest 300 ms of
///   its last 15 s. Whisper reads 30 s at a time, and decoding each piece on its
///   own keeps a repetition loop, should it fall into one, inside its piece. Its
///   own long-form seeking can instead carry a loop on, or decode the same audio
///   twice after a window's timestamps go wrong. It also lets the prompt, which
///   Whisper only reads at the start, reach every piece.
fn speech_chunks(audio: &[f32]) -> Vec<std::ops::Range<usize>> {
    const FRAME:    usize = 160;         // 10 ms at 16 kHz
    const LONGEST:  usize = 30 * 16_000;
    const SHORTEST: usize = 15 * 16_000;
    const QUIET:    usize = 30;          // frames: the 300 ms a cut sits in
    const SILENCE:  usize = 200;         // frames: 2 s
    const MARGIN:   usize = 30;          // frames: 300 ms

    let rms: Vec<f32> = audio.chunks(FRAME).map(rms_window).collect();
    let n = rms.len();
    let silent = speech_threshold(&rms) * 10f32.powf(-10.0 / 20.0);

    // Spans of speech, in frames: whatever lies between the silences.
    let mut spans: Vec<std::ops::Range<usize>> = Vec::new();
    let (mut from, mut k) = (0, 0);
    while k < n {
        if rms[k] >= silent {
            k += 1;
            continue;
        }
        let quiet = k;
        while k < n && rms[k] < silent {
            k += 1;
        }
        if k - quiet >= SILENCE {
            if quiet > from {
                spans.push(from..(quiet + MARGIN).min(n));
            }
            from = if k == n { n } else { k - MARGIN };
        }
    }
    if from < n {
        spans.push(from..n);
    }

    // Each span in pieces of at most 30 s.
    let energy: Vec<f32> = rms.iter().map(|r| r * r).collect();
    let mut pieces = Vec::new();
    for span in spans {
        let (mut start, end) = (span.start * FRAME, (span.end * FRAME).min(audio.len()));
        while end - start > LONGEST {
            let (from, to) = ((start + SHORTEST) / FRAME, (start + LONGEST) / FRAME);
            let quietest = energy[from..to]
                .windows(QUIET)
                .map(|w| w.iter().sum::<f32>())
                .enumerate()
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map_or(0, |(k, _)| k);
            let cut = (from + quietest + QUIET / 2) * FRAME;
            pieces.push(start..cut);
            start = cut;
        }
        pieces.push(start..end);
    }
    pieces
}

/// The language spoken in `pieces`: Whisper's language probabilities, summed
/// over the pieces. English when there's nothing to listen to.
fn detect_language(
    state:   &mut whisper_rs::WhisperState,
    audio:   &[f32],
    pieces:  &[std::ops::Range<usize>],
    threads: usize,
) -> Result<String, String> {
    let mut sum: Vec<f32> = Vec::new();
    for piece in pieces {
        state
            .pcm_to_mel(&audio[piece.clone()], threads)
            .and_then(|()| state.lang_detect(0, threads))
            .map(|(_, probs)| {
                sum.resize(probs.len(), 0.0);
                sum.iter_mut().zip(probs).for_each(|(s, p)| *s += p);
            })
            .map_err(|e| format!("Language detection failed: {}", e))?;
    }
    let likeliest = sum.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(id, _)| id as i32);
    Ok(likeliest.and_then(whisper_rs::get_lang_str).unwrap_or("en").to_string())
}

/// Assemble the words of the segments Whisper just decoded, `offset_ms` into
/// the file.
///
/// Word boundaries follow Whisper's own leading-space convention: a token
/// that starts with ' ' begins a new word; everything else (sub-word pieces,
/// punctuation, apostrophes, hyphens) continues the current one, and each
/// segment's first token starts a new word. (An earlier timestamp-gap
/// heuristic split long words — "lif eline" — and detached punctuation —
/// "browsers ." — whenever token timestamps were noisy.)
///
/// A word starts at its first token's DTW time when available, else the
/// legacy t0. Ends are provisional here — the next word's start, or the last
/// token's t1 for the final word — and are tightened in refine_with_vad.
fn collect_words(state: &whisper_rs::WhisperState, offset_ms: i64, pending: &mut Vec<Pending>) {
    for seg_idx in 0..state.full_n_segments() {
        let Some(segment) = state.get_segment(seg_idx) else { continue };
        let mut first_in_segment = true;

        for tok_idx in 0..segment.n_tokens() {
            let Some(token) = segment.get_token(tok_idx) else { continue };
            let text = match token.to_str_lossy() {
                Ok(t) => t.into_owned(),
                Err(_) => continue,
            };
            let data = token.token_data();

            // Skip special tokens (timing markers, control tokens) and tokens
            // without valid timestamps.
            if text.starts_with('[') || text.starts_with('<') || text.trim().is_empty() {
                continue;
            }
            if data.t0 < 0 || data.t1 < 0 {
                continue;
            }

            // t0 / t1 / t_dtw are in centiseconds → ms
            let start_ms = offset_ms + if data.t_dtw >= 0 { data.t_dtw * 10 } else { data.t0 * 10 };
            let prob     = token.token_probability();
            let is_punct = !text.chars().any(char::is_alphanumeric);
            let continues_word = !pending.is_empty()
                && (is_punct || (!first_in_segment && !text.starts_with(' ')));
            first_in_segment = false;

            if continues_word {
                if let Some(word) = pending.last_mut() {
                    word.text.push_str(text.trim());
                    word.last_t1_ms = data.t1 * 10 + offset_ms;
                    word.conf_sum  += prob;
                    word.tokens    += 1;
                }
            } else {
                pending.push(Pending {
                    text:       text.trim().to_string(),
                    start_ms,
                    last_t1_ms: data.t1 * 10 + offset_ms,
                    conf_sum:   prob,
                    tokens:     1,
                });
            }
        }
    }
}

// ─── Timing pipeline ──────────────────────────────────────────────────────────

/// Word-timing pipeline after Whisper: snap starts to speech onsets and trim
/// ends through silence (VAD), then — for English, when the alignment model is
/// installed — forced alignment for exact word boundaries. Returns how many
/// words the aligner placed (0 when it didn't run).
fn finalize_timings(audio: &[f32], words: &mut [Word], aligner: Option<&Path>, language: &str) -> usize {
    refine_with_vad(audio, words, DTW_SNAP);
    let mut aligned = 0;
    if let (Some(model), "en") = (aligner, language) {
        match align_and_tidy(model, audio, words) {
            Ok(n)  => aligned = n,
            Err(e) => eprintln!("Forced alignment skipped: {e}"),
        }
    }
    enforce_monotonic(words);
    aligned
}

/// How far a word's start may move to land on a speech onset.
#[derive(Clone, Copy)]
struct Snap {
    before_ms: i64,
    after_ms:  i64,
    /// Skip onsets the previous word already covers. Only meaningful once words
    /// have real ends (after alignment); DTW words are back-to-back.
    respect_prev_end: bool,
}

/// DTW starts can be hundreds of ms off in either direction. Aligned starts only
/// ever run late (median +26 ms, p95 +225 ms on a 22-min podcast), so they move
/// earlier only, and never onto an onset the previous word owns.
const DTW_SNAP:     Snap = Snap { before_ms: 450, after_ms: 150, respect_prev_end: false };
const ALIGNED_SNAP: Snap = Snap { before_ms: 300, after_ms: 0,   respect_prev_end: true };

/// Forced alignment, then an early-only onset snap and end trim (VAD), and the
/// monotonic clean-up.
fn align_and_tidy(model: &Path, audio: &[f32], words: &mut [Word]) -> Result<usize, String> {
    let aligned = crate::alignment::align_words(model, audio, words)?;
    refine_with_vad(audio, words, ALIGNED_SNAP);
    enforce_monotonic(words);
    Ok(aligned)
}

/// Each word starts no earlier than the previous word ends, and lasts ≥ 1 ms.
fn enforce_monotonic(words: &mut [Word]) {
    let mut prev_end = 0i64;
    for word in words.iter_mut() {
        if word.start_ms < prev_end {
            word.start_ms = prev_end;
        }
        if word.end_ms < word.start_ms + 1 {
            word.end_ms = word.start_ms + 1;
        }
        prev_end = word.end_ms;
    }
}



#[cfg(test)]
mod tests {
    use super::*;

    /// Transcribe a 16 kHz WAV the way the app does, to a `transcript.json`
    /// (not run by default):
    /// `WHISPER_MODEL=…/ggml-large-v3-turbo.bin ALIGNER=…/wav2vec2….onnx WAV=…/16k.wav OUT=…/transcript.json cargo test transcribe_file -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn transcribe_file() {
        let model   = std::env::var("WHISPER_MODEL").expect("WHISPER_MODEL");
        let wav     = std::env::var("WAV").expect("WAV");
        let out     = std::env::var("OUT").expect("OUT");
        let aligner = std::env::var("ALIGNER").ok();
        let audio   = read_wav_f32(Path::new(&wav)).unwrap();
        let t0 = std::time::Instant::now();
        // Wave's decoding, or an experiment: PROMPT (another prompt, empty for
        // none), BEAM (another beam width, 0 for greedy), WHOLE (the whole file
        // at once).
        let mut decoding = Decoding::default();
        if let Ok(prompt) = std::env::var("PROMPT") {
            decoding.prompt = Some(prompt).filter(|p| !p.is_empty());
        }
        if let Some(beam) = std::env::var("BEAM").ok().and_then(|b| b.parse::<i32>().ok()) {
            decoding.beam = Some(beam).filter(|&b| b > 0);
        }
        decoding.chunked = std::env::var("WHOLE").is_err();
        let (mut words, language) = run_whisper_with(Path::new(&model), "large-v3-turbo", &audio, |p| eprint!("\r{p}%"), &decoding).unwrap();
        let aligned = finalize_timings(&audio, &mut words, aligner.as_deref().map(Path::new), &language);
        let transcript = Transcript { words, language, duration_ms: (audio.len() * 1000 / 16_000) as i64 };
        std::fs::write(&out, serde_json::to_string(&transcript).unwrap()).unwrap();
        println!("\n{} words ({aligned} aligned, {}) in {:.0} s", transcript.words.len(), transcript.language, t0.elapsed().as_secs_f64());
    }

    /// Pieces cover the file end to end, run 15–30 s (the last may be
    /// shorter), and are cut in pauses.
    #[test]
    fn pieces_are_cut_in_pauses() {
        // 95 s of "speech" (a tone) with a 400 ms pause every 7 s.
        let (rate, every, pause) = (16_000, 7 * 16_000, 400 * 16);
        let audio: Vec<f32> = (0..95 * rate)
            .map(|i| if i % every < pause { 0.0 } else { 0.3 * (i as f32 * 0.07).sin() })
            .collect();
        let pieces = speech_chunks(&audio);
        assert_eq!(pieces.first().unwrap().start, 0);
        assert_eq!(pieces.last().unwrap().end, audio.len());
        for pair in pieces.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        for piece in &pieces[..pieces.len() - 1] {
            assert!((15 * rate..=30 * rate).contains(&piece.len()), "{piece:?}");
            assert!(piece.end % every < pause, "cut at {} ms, outside a pause", piece.end / 16);
        }
        assert_eq!(speech_chunks(&audio[..30 * rate]), vec![0..30 * rate]);
    }

    /// A silence of 2 s or more is left out, less 300 ms either side; a shorter
    /// one stays in.
    #[test]
    fn long_silences_are_left_out() {
        let rate = 16_000;
        let tone = |n: usize| (0..n).map(|i| 0.3 * (i as f32 * 0.07).sin()).collect::<Vec<f32>>();
        let audio = [tone(10 * rate), vec![0.0; 5 * rate], tone(10 * rate), vec![0.0; rate]].concat();
        let margin = 300 * 16;
        assert_eq!(
            speech_chunks(&audio),
            vec![0..10 * rate + margin, 15 * rate - margin..audio.len()],
        );
        assert!(speech_chunks(&vec![0.0; 5 * rate]).is_empty());
    }
}
