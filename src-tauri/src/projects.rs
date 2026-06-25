use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

// ─── Data model ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProjectStatus {
    /// Created but no audio imported yet
    Empty,
    /// Audio import is in progress
    Importing,
    /// Audio imported and ready for transcription
    ReadyToTranscribe,
    /// Transcription running
    Transcribing,
    /// Fully transcribed
    Ready,
    /// Something went wrong
    Error {
        #[serde(rename = "message")]
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// Unix timestamp in milliseconds
    pub created_at: u64,
    pub original_filename: Option<String>,
    /// Duration of the audio in seconds
    pub duration_secs: Option<f64>,
    pub status: ProjectStatus,
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

pub fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("projects");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(projects_root(app)?.join(id))
}

pub fn read_project(dir: &Path) -> Option<Project> {
    let raw = std::fs::read_to_string(dir.join("project.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_project(dir: &Path, project: &Project) -> Result<(), String> {
    let json = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("project.json"), json).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── Peaks cache ─────────────────────────────────────────────────────────────

// ─── Rename ───────────────────────────────────────────────────────────────────

/// Update the display name of a project.
#[tauri::command]
pub fn rename_project(app: AppHandle, project_id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    let dir = project_dir(&app, &project_id)?;
    let mut project = read_project(&dir).ok_or("Project not found")?;
    project.name = name;
    write_project(&dir, &project)
}

// ─── Edit history cache ───────────────────────────────────────────────────────

/// Persist edit actions so they survive navigation away and back.
#[tauri::command]
pub fn save_edits(app: AppHandle, project_id: String, data: String) -> Result<(), String> {
    let path = project_dir(&app, &project_id)?.join("edits.json");
    std::fs::write(path, data).map_err(|e| e.to_string())
}

/// Load previously saved edit actions (JSON string), or None if none exist.
#[tauri::command]
pub fn load_edits(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    let path = project_dir(&app, &project_id)?.join("edits.json");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(&path).map_err(|e| e.to_string())?))
}

// ─── Peaks cache ─────────────────────────────────────────────────────────────

/// Load cached waveform peaks (JSON string) for fast re-render.
#[tauri::command]
pub fn load_peaks(app: AppHandle, project_id: String) -> Result<Option<String>, String> {
    let path = project_dir(&app, &project_id)?.join("peaks.json");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(&path).map_err(|e| e.to_string())?))
}

/// Persist waveform peaks so subsequent opens skip audio decoding.
#[tauri::command]
pub fn save_peaks(app: AppHandle, project_id: String, data: String) -> Result<(), String> {
    let path = project_dir(&app, &project_id)?.join("peaks.json");
    std::fs::write(path, data).map_err(|e| e.to_string())
}

// ─── Audio path ───────────────────────────────────────────────────────────────

/// Return the absolute filesystem path to `audio_16k.wav` for the given project.
/// Used by the transcription pipeline which requires 16 kHz mono WAV.
#[tauri::command]
pub fn get_audio_path(app: AppHandle, project_id: String) -> Result<String, String> {
    let path = project_dir(&app, &project_id)?.join("audio_16k.wav");
    if !path.exists() {
        return Err("Audio file not found — import audio first".into());
    }
    path.to_str()
        .ok_or_else(|| "Non-UTF-8 path".into())
        .map(|s| s.to_string())
}

/// Return the best audio file for waveform playback.
///
/// Prefers the original imported file (`audio_original.*`) because it is
/// stereo at the native sample rate — playing the 16 kHz mono WAV causes the
/// WebView to route a single-channel signal to the left output only.
///
/// Falls back to `audio_16k.wav` if the original is missing (e.g. older
/// projects created before the original was preserved).
///
/// Note: WebKit supports MP3, AAC/M4A, WAV, AIFF, and FLAC natively.
/// Files in formats the WebView cannot decode (OGG, Opus, WMA…) will fail
/// to load in WaveSurfer; the frontend falls back to the 16 kHz WAV in that
/// case via the `get_audio_path` command.
#[tauri::command]
pub fn get_playback_audio_path(app: AppHandle, project_id: String) -> Result<String, String> {
    let dir = project_dir(&app, &project_id)?;

    // Look for audio_original.<ext> — any extension is fine.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name     = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("audio_original.") {
                return entry
                    .path()
                    .to_str()
                    .ok_or_else(|| "Non-UTF-8 path".into())
                    .map(|s| s.to_string());
            }
        }
    }

    // Fallback: 16 kHz mono WAV (mono, but at least it plays)
    let fallback = dir.join("audio_16k.wav");
    if fallback.exists() {
        return fallback
            .to_str()
            .ok_or_else(|| "Non-UTF-8 path".into())
            .map(|s| s.to_string());
    }

    Err("No audio file found — import audio first".into())
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_projects(app: AppHandle) -> Result<Vec<Project>, String> {
    let root = projects_root(&app)?;
    let mut projects = Vec::new();

    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(mut project) = read_project(&dir) else { continue };

        // Detect interrupted imports: status says "importing" but the app restarted.
        if matches!(project.status, ProjectStatus::Importing) {
            let wav = dir.join("audio_16k.wav");
            if wav.exists() {
                // Convert completed but status was never updated — fix it.
                project.status = ProjectStatus::ReadyToTranscribe;
                let _ = write_project(&dir, &project);
            } else {
                // Genuinely interrupted.
                project.status = ProjectStatus::Error {
                    message: "Import was interrupted. Please try again.".into(),
                };
                let _ = write_project(&dir, &project);
            }
        }

        projects.push(project);
    }

    projects.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(projects)
}

#[tauri::command]
pub fn create_project(app: AppHandle, name: String) -> Result<Project, String> {
    let root  = projects_root(&app)?;
    let id    = uuid::Uuid::new_v4().to_string();
    let dir   = root.join(&id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let project = Project {
        id,
        name,
        created_at: now_ms(),
        original_filename: None,
        duration_secs: None,
        status: ProjectStatus::Empty,
    };
    write_project(&dir, &project)?;
    Ok(project)
}

#[tauri::command]
pub fn delete_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    if !dir.exists() {
        return Err("Project not found".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Could not delete project: {}", e))
}

/// Begin async audio import. Returns immediately; progress/completion comes
/// via Tauri events:
///   `project:import_progress`  → { projectId, percentage }
///   `project:import_complete`  → { project: Project }
///   `project:import_error`     → { projectId, message }
#[tauri::command]
pub async fn import_audio(
    app: AppHandle,
    project_id: String,
    source_path: String,
) -> Result<(), String> {
    let dir = project_dir(&app, &project_id)?;
    if !dir.exists() {
        return Err("Project not found".into());
    }

    let mut project = read_project(&dir).ok_or("Could not read project.json")?;

    // Mark as importing right away so the UI updates immediately
    project.status = ProjectStatus::Importing;
    write_project(&dir, &project)?;

    let _ = app.emit("project:import_progress", serde_json::json!({
        "projectId": project_id,
        "percentage": 0,
    }));

    let app2 = app.clone();
    let pid  = project_id.clone();
    let src  = PathBuf::from(source_path);

    tokio::spawn(async move {
        match run_import(app2.clone(), pid.clone(), src, dir).await {
            Ok(updated) => {
                let _ = app2.emit("project:import_complete", serde_json::json!({
                    "project": updated,
                }));
            }
            Err(e) => {
                // Persist the error so it survives an app restart
                if let Ok(d) = project_dir(&app2, &pid) {
                    if let Some(mut p) = read_project(&d) {
                        p.status = ProjectStatus::Error { message: e.clone() };
                        let _ = write_project(&d, &p);
                    }
                }
                let _ = app2.emit("project:import_error", serde_json::json!({
                    "projectId": pid,
                    "message": e,
                }));
            }
        }
    });

    Ok(())
}

// ─── Import pipeline ──────────────────────────────────────────────────────────

async fn run_import(
    app: AppHandle,
    project_id: String,
    source: PathBuf,
    dir: PathBuf,
) -> Result<Project, String> {
    // ── 1. Copy original file ─────────────────────────────────────────────────
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("audio")
        .to_lowercase();
    let original_name = format!("audio_original.{}", ext);
    let original_path = dir.join(&original_name);

    tokio::fs::copy(&source, &original_path)
        .await
        .map_err(|e| format!("Could not copy audio file: {}", e))?;

    let original_filename = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio")
        .to_string();

    emit_progress(&app, &project_id, 15).await;

    // ── 2. Decode → f32 mono PCM (blocking, CPU-intensive) ───────────────────
    let decode_path = original_path.clone();
    let (pcm_mono, src_rate, duration_secs) =
        tokio::task::spawn_blocking(move || decode_to_mono_f32(&decode_path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Audio decode failed: {}", e))?;

    emit_progress(&app, &project_id, 50).await;

    // ── 3. Resample to 16 kHz if needed ──────────────────────────────────────
    let pcm_16k = if src_rate == 16_000 {
        pcm_mono
    } else {
        tokio::task::spawn_blocking(move || resample_mono(&pcm_mono, src_rate, 16_000))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Resampling failed: {}", e))?
    };

    emit_progress(&app, &project_id, 80).await;

    // ── 4. Write 16 kHz WAV ───────────────────────────────────────────────────
    let wav_path = dir.join("audio_16k.wav");
    let wav_path2 = wav_path.clone();
    tokio::task::spawn_blocking(move || write_wav_f32(&wav_path2, &pcm_16k, 16_000))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("WAV write failed: {}", e))?;

    emit_progress(&app, &project_id, 95).await;

    // ── 5. Persist updated project ────────────────────────────────────────────
    let mut project = read_project(&dir).ok_or("Project disappeared during import")?;
    project.status             = ProjectStatus::ReadyToTranscribe;
    project.original_filename  = Some(original_filename);
    project.duration_secs      = Some(duration_secs);
    write_project(&dir, &project)?;

    emit_progress(&app, &project_id, 100).await;

    Ok(project)
}

async fn emit_progress(app: &AppHandle, project_id: &str, pct: u8) {
    let _ = app.emit("project:import_progress", serde_json::json!({
        "projectId": project_id,
        "percentage": pct,
    }));
}

// ─── Audio processing (sync, run in spawn_blocking) ──────────────────────────

/// Decode any supported audio format to f32 mono PCM.
/// Returns (samples, sample_rate_hz, duration_secs).
fn decode_to_mono_f32(path: &Path) -> Result<(Vec<f32>, u32, f64), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::core::errors::Error as SE;

    let file = std::fs::File::open(path)
        .map_err(|e| format!("Cannot open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Unsupported audio format: {}", e))?;

    let mut fmt = probed.format;

    let track = fmt
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("No audio track found in file")?
        .clone();

    let track_id  = track.id;
    let src_rate  = track.codec_params.sample_rate.ok_or("Unknown sample rate")?;
    let n_ch      = track.codec_params.channels.map(|c| c.count()).unwrap_or(2).max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported codec: {}", e))?;

    // Estimate capacity: avoid massive reallocations for long files
    let cap = track.codec_params.n_frames
        .map(|f| f as usize)
        .unwrap_or(src_rate as usize * 60 * 5); // default 5 min
    let mut pcm: Vec<f32> = Vec::with_capacity(cap);

    loop {
        let packet = match fmt.next_packet() {
            Ok(p) => p,
            Err(SE::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SE::ResetRequired) => { decoder.reset(); continue; }
            Err(e) => return Err(format!("Read error: {}", e)),
        };

        if packet.track_id() != track_id { continue; }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                buf.copy_interleaved_ref(decoded);

                // Mix interleaved channels down to mono
                for frame in buf.samples().chunks_exact(n_ch) {
                    pcm.push(frame.iter().sum::<f32>() / n_ch as f32);
                }
            }
            Err(SE::DecodeError(_)) => continue, // skip corrupted packets gracefully
            Err(e) => return Err(format!("Decode error: {}", e)),
        }
    }

    if pcm.is_empty() {
        return Err("Audio file appears to be empty".into());
    }

    let duration = pcm.len() as f64 / src_rate as f64;
    Ok((pcm, src_rate, duration))
}

/// Resample mono f32 PCM from `from_hz` to `to_hz` using rubato.
fn resample_mono(samples: &[f32], from_hz: u32, to_hz: u32) -> Result<Vec<f32>, String> {
    use audioadapter_buffers::direct::InterleavedSlice;
    use rubato::{Fft, FixedSync, Resampler};

    let channels         = 1_usize;
    let nbr_input_frames = samples.len();

    // Fft resampler: fast, high-quality, perfect for offline file conversion.
    let mut rs = Fft::<f32>::new(
        from_hz as usize,
        to_hz   as usize,
        1024,           // chunk size (hint)
        2,              // sub_chunks
        channels,
        FixedSync::Input,
    )
    .map_err(|e| format!("Resampler init: {}", e))?;

    // Allocate output buffer (generous: delay + max_frames + expected output)
    let out_capacity = rs.process_all_needed_output_len(nbr_input_frames);
    let mut outdata  = vec![0.0_f32; out_capacity];

    // Wrap slices in audioadapter adapters (1-channel interleaved == sequential)
    let input_adapter = InterleavedSlice::new(samples, channels, nbr_input_frames)
        .map_err(|e| format!("Input adapter error: {:?}", e))?;
    let mut output_adapter = InterleavedSlice::new_mut(&mut outdata, channels, out_capacity)
        .map_err(|e| format!("Output adapter error: {:?}", e))?;

    let (_, nbr_out) = rs
        .process_all_into_buffer(&input_adapter, &mut output_adapter, nbr_input_frames, None)
        .map_err(|e| format!("Resampling failed: {:?}", e))?;

    outdata.truncate(nbr_out);
    Ok(outdata)
}

/// Write mono f32 samples to a WAV file.
fn write_wav_f32(path: &Path, samples: &[f32], sample_rate: u32) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels:        1,
        sample_rate,
        bits_per_sample: 32,
        sample_format:   hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("WAV create: {}", e))?;
    for &s in samples {
        w.write_sample(s).map_err(|e| format!("WAV write: {}", e))?;
    }
    w.finalize().map_err(|e| format!("WAV finalize: {}", e))
}

// ─── Preview generation ───────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOp {
    pub start_ms: f64,
    pub end_ms:   f64,
}

/// Splice audio by removing the supplied time ranges.
///
/// Returns the absolute filesystem path to the generated preview file.
///
/// ## Why 16-bit PCM output
/// The source `audio_16k.wav` is 32-bit IEEE float, which is the format whisper
/// needs for inference.  However WebKit (the WebView used by Tauri on macOS) has
/// unreliable support for 32-bit float WAV: it may play at 3× speed or produce
/// garbled audio because it misinterprets the bit depth.  16-bit signed PCM
/// (`WAVE_FORMAT_PCM`, format code 0x0001) is the oldest, most universally
/// supported WAV variant and plays correctly in every browser engine.
///
/// ## Why a timestamp in the filename
/// Tauri's `asset://` protocol is served by the embedded WebView which applies
/// standard HTTP caching keyed on the URL.  If we always write to `preview.wav`
/// the WebView serves stale bytes on subsequent edits.  Using a monotonic counter
/// in the filename makes every new preview a distinct URL.
#[tauri::command]
pub async fn generate_preview(
    app: AppHandle,
    project_id: String,
    ops: Vec<EditOp>,
) -> Result<String, String> {
    let dir        = project_dir(&app, &project_id)?;
    let audio_path = dir.join("audio_16k.wav");

    if !audio_path.exists() {
        return Err("Audio file not found".into());
    }

    // Give every preview a unique filename so the WebView never serves a
    // stale cached version.  We use the current unix timestamp in milliseconds.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let preview_name = format!("preview_{}.wav", ts);
    let preview_path = dir.join(&preview_name);

    // Remove any previously generated preview files to keep the project dir tidy.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("preview_") && name_str.ends_with(".wav") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    // Sort ops so we can scan the file linearly.
    let mut sorted = ops;
    sorted.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));

    let preview_path2 = preview_path.clone();
    tokio::task::spawn_blocking(move || splice_audio(&audio_path, &preview_path2, &sorted))
        .await
        .map_err(|e| e.to_string())??;

    preview_path
        .to_str()
        .ok_or_else(|| "Non-UTF-8 path".to_string())
        .map(|s| s.to_string())
}

// ─── Audio export ─────────────────────────────────────────────────────────────

/// Export the edited audio directly to a user-chosen path.
///
/// Unlike `generate_preview` (which writes to a temp file inside the project
/// dir), this command writes the spliced 16-bit PCM WAV straight to `dest_path`
/// so the user gets the file exactly where their save dialog placed it.
#[tauri::command]
pub async fn export_audio(
    app:        AppHandle,
    project_id: String,
    ops:        Vec<EditOp>,
    dest_path:  String,
) -> Result<(), String> {
    let dir        = project_dir(&app, &project_id)?;
    let audio_path = dir.join("audio_16k.wav");

    if !audio_path.exists() {
        return Err("Audio file not found — import audio first".into());
    }

    let dest = PathBuf::from(dest_path);

    // Sort ops for a single linear pass through the file.
    let mut sorted = ops;
    sorted.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));

    tokio::task::spawn_blocking(move || splice_audio(&audio_path, &dest, &sorted))
        .await
        .map_err(|e| e.to_string())??;

    Ok(())
}

fn splice_audio(src: &std::path::Path, dst: &std::path::Path, ops: &[EditOp]) -> Result<(), String> {
    // ── Read source (32-bit float) ────────────────────────────────────────────
    let mut reader = hound::WavReader::open(src)
        .map_err(|e| format!("Open audio: {}", e))?;

    let in_spec    = reader.spec();
    let sr         = in_spec.sample_rate as f64;

    // Load all samples into memory so we can apply look-ahead/look-behind fades.
    // At 16 kHz / 32-bit float: 60 min ≈ 230 MB — acceptable for editing.
    let mut samples: Vec<f32> = match in_spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.map_err(|e| format!("Read sample: {}", e)))
            .collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let max_val = (1_i64 << (in_spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max_val)
                          .map_err(|e| format!("Read sample: {}", e)))
                .collect::<Result<Vec<_>, _>>()?
        }
    };

    let total = samples.len();

    // ── Convert op boundaries from ms → sample indices ────────────────────────
    let cuts: Vec<(usize, usize)> = ops
        .iter()
        .map(|op| {
            let s = ((op.start_ms / 1000.0) * sr).round() as usize;
            let e = ((op.end_ms   / 1000.0) * sr).round() as usize;
            (s.min(total), e.min(total))
        })
        .collect();

    // ── Apply fade envelopes in-place before removing samples ─────────────────
    // A hard cut (two waveform positions joined directly) almost always produces
    // a click because the amplitude jumps discontinuously.  A short linear
    // fade-out before the cut and fade-in after eliminates this.
    //
    // 10 ms = 160 samples at 16 kHz — imperceptible as loudness change but long
    // enough to cover any pitch period and fully remove the click.
    let fade_samps = ((10.0 / 1000.0) * sr).round() as usize;

    for &(cut_start, cut_end) in &cuts {
        // Fade out: last `fade_samps` samples kept before the cut → 1.0 → 0.0
        let fade_out_begin = cut_start.saturating_sub(fade_samps);
        for i in fade_out_begin..cut_start {
            let t = (i - fade_out_begin) as f32 / fade_samps as f32; // 0 → 1
            samples[i] *= 1.0 - t;  // ramp to silence
        }
        // Fade in: first `fade_samps` samples kept after the cut → 0.0 → 1.0
        let fade_in_end = (cut_end + fade_samps).min(total);
        for i in cut_end..fade_in_end {
            let t = (i - cut_end) as f32 / fade_samps as f32;  // 0 → 1
            samples[i] *= t;  // ramp from silence
        }
    }

    // ── Write output as 16-bit signed PCM ────────────────────────────────────
    // WebKit / Safari have unreliable playback of 32-bit float WAV: they can
    // misinterpret the bit depth and play at 3× speed or produce static.
    // 16-bit signed PCM (WAVE_FORMAT_PCM, format code 0x0001) is universally
    // supported by every browser engine and audio player.
    let out_spec = hound::WavSpec {
        channels:        1,
        sample_rate:     in_spec.sample_rate,
        bits_per_sample: 16,
        sample_format:   hound::SampleFormat::Int,
    };

    let mut writer = hound::WavWriter::create(dst, out_spec)
        .map_err(|e| format!("Create preview: {}", e))?;

    for (idx, &s) in samples.iter().enumerate() {
        // Skip samples in deleted regions.
        if cuts.iter().any(|&(cs, ce)| idx >= cs && idx < ce) {
            continue;
        }

        // Convert f32 [-1.0, 1.0] → i16 [-32768, 32767], clamp to avoid wrap.
        let s_clamped = s.clamp(-1.0, 1.0);
        let s_i16     = (s_clamped * 32767.0).round() as i16;

        writer
            .write_sample(s_i16)
            .map_err(|e| format!("Write sample: {}", e))?;
    }

    writer.finalize().map_err(|e| format!("Finalize: {}", e))
}
