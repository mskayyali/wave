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
        match run_transcription(app2.clone(), pid.clone(), model_path, dir).await {
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

    // ── 2. Run whisper in a blocking thread ───────────────────────────────────
    let app_cb   = app.clone();
    let pid_cb   = project_id.clone();
    let words = tokio::task::spawn_blocking(move || {
        run_whisper(&model_path, &audio, app_cb, pid_cb)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Transcription failed: {}", e))?;

    emit_progress(&app, &project_id, 95).await;

    // ── 3. Determine detected language (approximate from model_id) ────────────
    let language = "en".to_string();

    // ── 4. Save transcript.json ───────────────────────────────────────────────
    let transcript = Transcript { words, language, duration_ms };
    let json = serde_json::to_string_pretty(&transcript).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("transcript.json"), json).map_err(|e| e.to_string())?;

    // ── 5. Update project status ──────────────────────────────────────────────
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

// ─── Onset refinement ─────────────────────────────────────────────────────────

/// For words preceded by a silence gap of ≥ `ONSET_GAP_MS`, scan the raw PCM
/// audio to find the actual energy onset and push `start_ms` forward to it.
///
/// This corrects Whisper's habit of assigning t0 = segment-window-start for the
/// first token in a segment, which places the timestamp inside the leading silence
/// rather than at the moment speech begins.
fn refine_word_onsets(audio: &[f32], words: &mut Vec<Word>) {
    /// Only refine words preceded by at least this much silence (ms).
    /// Small enough to catch inter-sentence gaps; large enough not to
    /// interfere with in-word sub-token gaps.
    const ONSET_GAP_MS:   i64   = 150;
    /// 16 kHz mono — all whisper input is resampled to this.
    const SR:             i64   = 16_000;
    /// RMS window in samples (10 ms at 16 kHz).
    const WIN:            usize = 160;
    /// RMS amplitude threshold.  ≈ −42 dBFS — comfortably above a quiet room's
    /// noise floor while still catching soft consonant onsets (/h/, /w/, /y/).
    const THRESHOLD:      f32   = 0.008;
    /// Number of consecutive windows above threshold required to confirm onset.
    /// Two windows = 20 ms, which filters brief noise transients.
    const CONFIRM:        usize = 2;
    /// How far past Whisper's reported start_ms we're willing to search (ms).
    /// Caps the scan so one bad segment can't consume large amounts of audio.
    const MAX_SEARCH_MS:  i64   = 300;

    let total = audio.len();

    for i in 0..words.len() {
        let prev_end_ms = if i == 0 { 0 } else { words[i - 1].end_ms };
        let gap_ms      = words[i].start_ms - prev_end_ms;

        // Skip words in the middle of continuous speech.
        if gap_ms < ONSET_GAP_MS { continue; }

        // Scan from the end of the previous word up to (start_ms + MAX_SEARCH_MS).
        let scan_start = (prev_end_ms * SR / 1000) as usize;
        let scan_end   = (((words[i].start_ms + MAX_SEARCH_MS) * SR / 1000) as usize)
            .min(total);

        let mut consecutive = 0usize;
        let mut onset_ms: Option<i64> = None;
        let mut s = scan_start;

        while s + WIN <= scan_end {
            if rms_window(&audio[s..s + WIN]) >= THRESHOLD {
                consecutive += 1;
                if consecutive >= CONFIRM {
                    // Back up to the first window in this run.
                    let first = s + WIN - CONFIRM * WIN;
                    onset_ms = Some((first as i64 * 1000) / SR);
                    break;
                }
            } else {
                consecutive = 0;
            }
            s += WIN;
        }

        if let Some(actual_start) = onset_ms {
            // Only push start_ms *later* — highlighting during silence is the
            // reported problem.  If the VAD onset is earlier than Whisper's
            // estimate (Whisper was already a bit late), keep Whisper's value.
            if actual_start > words[i].start_ms {
                // Safety: don't push start past the word's own end.
                if actual_start < words[i].end_ms {
                    words[i].start_ms = actual_start;
                }
            }
        }
    }
}

#[inline]
fn rms_window(samples: &[f32]) -> f32 {
    if samples.is_empty() { return 0.0; }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

// ─────────────────────────────────────────────────────────────────────────────

fn read_wav_f32(path: &Path) -> Result<Vec<f32>, String> {
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

fn run_whisper(
    model_path: &Path,
    audio:      &[f32],
    app:        AppHandle,
    project_id: String,
) -> Result<Vec<Word>, String> {
    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
    };

    // ── Load model ────────────────────────────────────────────────────────────
    let ctx = WhisperContext::new_with_params(
        model_path,
        WhisperContextParameters::default(), // use_gpu defaults to true when metal feature enabled
    )
    .map_err(|e| format!("Failed to load model: {}", e))?;

    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Failed to create whisper state: {}", e))?;

    // ── Configure params ──────────────────────────────────────────────────────
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_token_timestamps(true);
    params.set_language(Some("auto"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // Ask Whisper to split segments at word boundaries where possible.
    // This improves token-level timestamp accuracy, especially with turbo models.
    params.set_split_on_word(true);
    params.set_n_threads(
        std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .min(8),
    );

    // Emit progress ticks as whisper processes (0 → 100)
    params.set_progress_callback_safe(move |progress: i32| {
        // Map whisper's 0–100 → our 10–90 range
        let pct = 10 + (progress * 80 / 100);
        let _ = app.emit("transcription:progress", serde_json::json!({
            "projectId": project_id,
            "percentage": pct,
        }));
    });

    // ── Run transcription ─────────────────────────────────────────────────────
    state
        .full(params, audio)
        .map_err(|e| format!("Whisper inference failed: {}", e))?;

    // ── Extract word-level tokens ─────────────────────────────────────────────
    let mut words: Vec<Word> = Vec::new();
    let n_segments = state.full_n_segments();

    for seg_idx in 0..n_segments {
        let Some(segment) = state.get_segment(seg_idx) else { continue };
        let n_tokens = segment.n_tokens();

        // Accumulate sub-word tokens into full words
        let mut current_text   = String::new();
        let mut current_start  = 0i64;
        let mut current_end    = 0i64;
        let mut current_conf   = 0.0f32;
        let mut token_count    = 0u32;

        for tok_idx in 0..n_tokens {
            let Some(token) = segment.get_token(tok_idx) else { continue };

            let text = match token.to_str_lossy() {
                Ok(t) => t.into_owned(),
                Err(_) => continue,
            };

            let data = token.token_data();

            // Skip special tokens (timing markers, control tokens)
            if text.starts_with('[') || text.starts_with('<') || text.trim().is_empty() {
                continue;
            }
            // Skip tokens without valid timestamps
            if data.t0 < 0 || data.t1 < 0 {
                continue;
            }

            // t0/t1 are in centiseconds → convert to ms
            let t0_ms = data.t0 * 10;
            let t1_ms = data.t1 * 10;
            let prob  = token.token_probability();

            // ── Word-boundary detection ───────────────────────────────────────
            //
            // Two complementary signals are used instead of relying solely on
            // the leading-space convention.  The turbo/distilled model sometimes
            // omits the leading space on word-starting tokens, causing adjacent
            // words to be concatenated into one.
            //
            // Signal 1 — leading space: standard Whisper word-start marker.
            //
            // Signal 2 — timestamp gap: if the new token's t0 is more than
            // 80 ms after current_end, an acoustic gap exists between them and
            // they belong to different words even if no space is present.
            // 80 ms is chosen to be larger than typical inter-subword gaps
            // (~0 ms) but smaller than the shortest inter-word pause (~100 ms).

            let gap_ms = if token_count > 0 { t0_ms - current_end } else { 0 };
            let is_new_word = !current_text.is_empty()
                && (text.starts_with(' ') || gap_ms > 80);

            if is_new_word {
                // Flush the completed word
                words.push(Word {
                    text:       current_text.trim().to_string(),
                    start_ms:   current_start,
                    end_ms:     current_end,
                    confidence: current_conf / token_count.max(1) as f32,
                });
                // Begin the new word at this token
                current_text  = text.trim_start().to_string();
                current_start = t0_ms;
                current_end   = t1_ms;
                current_conf  = prob;
                token_count   = 1;
            } else {
                // Continue accumulating sub-word tokens into the current word
                if current_text.is_empty() {
                    current_start = t0_ms;
                }
                current_text.push_str(text.trim_start());
                current_end  = t1_ms;
                current_conf += prob;
                token_count  += 1;
            }
        }

        // Flush the last word in the segment
        if !current_text.is_empty() {
            words.push(Word {
                text:       current_text.trim().to_string(),
                start_ms:   current_start,
                end_ms:     current_end,
                confidence: current_conf / token_count.max(1) as f32,
            });
        }
    }

    // Remove any empty words that slipped through
    words.retain(|w| !w.text.is_empty());

    // ── Post-process 1: onset refinement via energy detection ─────────────────
    //
    // Whisper assigns the first token of a new segment a t0 equal to the
    // segment's window start.  When a segment begins during silence (e.g. the
    // first segment of the file, or a segment that opens after a long pause)
    // the first word's start_ms lands inside the silence — causing it to be
    // highlighted before the speaker actually begins the word.
    //
    // We address this by scanning the raw audio for the actual energy onset
    // for every word that is preceded by ≥ ONSET_GAP_MS of silence.  If the
    // real onset (first run of frames above the RMS threshold) is *later* than
    // Whisper's estimate, we push start_ms forward to match.  We never move
    // start_ms earlier (Whisper being slightly late is imperceptible; Whisper
    // being early causes visible pre-highlight during silence).
    refine_word_onsets(audio, &mut words);

    // ── Post-process 2: enforce monotonic, non-overlapping timestamps ─────────
    //
    // Whisper's token-level timestamps can be noisy, especially with the turbo
    // model.  A token's t0 sometimes equals or precedes the previous token's t1,
    // producing overlapping word ranges that make chips appear at wrong positions
    // in the waveform (e.g. "comprehension" visually starting where "and" was).
    //
    // Pass 1: ensure each word starts no earlier than the previous word ends.
    // Pass 2: ensure end >= start (degenerate timestamps become 1 ms wide).
    let mut prev_end = 0i64;
    for word in &mut words {
        if word.start_ms < prev_end {
            word.start_ms = prev_end;
        }
        if word.end_ms < word.start_ms + 1 {
            word.end_ms = word.start_ms + 1;
        }
        prev_end = word.end_ms;
    }

    Ok(words)
}
