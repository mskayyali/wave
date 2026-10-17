use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use crate::encode::ExportFormat;

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

// ─── Audio path ───────────────────────────────────────────────────────────────

/// The absolute path of the project's `audio_16k.wav`, the 16 kHz mono copy
/// that transcription and the AI tools read. The editor plays it only when the
/// WebView can't decode the original (OGG, Opus, WMA).
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

// ─── Leftovers ────────────────────────────────────────────────────────────────

/// Delete what nothing reads any more from every project folder: files of
/// earlier versions (`peaks.json`, the waveform cache before `waveform.bin`;
/// `preview_*.wav`, from before the editor played edits itself; `fillers.json`,
/// from when Wave detected fillers) and the `.part`
/// files of writes a quit interrupted (`waveform.bin.part`,
/// `audio_enhanced-*.wav.part`). Runs once at launch, before any job can be
/// writing one.
pub fn remove_leftovers(app: &AppHandle) {
    let Ok(root) = projects_root(app) else { return };
    let Ok(projects) = std::fs::read_dir(&root) else { return };
    for dir in projects.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let Ok(files) = std::fs::read_dir(&dir) else { continue };
        for file in files.flatten() {
            if is_leftover(&file.file_name().to_string_lossy()) {
                let _ = std::fs::remove_file(file.path());
            }
        }
    }
}

fn is_leftover(name: &str) -> bool {
    name == "peaks.json"
        || name == "fillers.json"
        || (name.starts_with("preview_") && name.ends_with(".wav"))
        || name.ends_with(".part")
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

        // Detect interrupted transcriptions: status says "transcribing" but the
        // app restarted (the worker thread died with it), so the card would
        // otherwise spin forever with no way out.
        if matches!(project.status, ProjectStatus::Transcribing) {
            if dir.join("transcript.json").exists() {
                // Transcription finished; only the final status write was lost.
                project.status = ProjectStatus::Ready;
            } else {
                project.status = ProjectStatus::Error {
                    message: "Transcription was interrupted. Please try again.".into(),
                };
            }
            let _ = write_project(&dir, &project);
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
    // Progress moves 15 → 60 % as the file is read, so a long file doesn't
    // look stuck.
    // The waveform the editor draws is built in the same pass (waveform.rs).
    let decode_path = original_path.clone();
    let waveform_path = crate::waveform::waveform_path(&dir);
    let (emitter, id) = (app.clone(), project_id.clone());
    let (pcm_mono, src_rate, duration_secs) =
        tokio::task::spawn_blocking(move || {
            let mut last = 15u8;
            let mut waveform: Option<crate::waveform::WaveformBuilder> = None;
            let (mono, rate, _, secs) = decode_f32(&decode_path, true, &mut |share| {
                let pct = 15 + (share * 45.0) as u8;
                if pct > last {
                    last = pct;
                    let _ = emitter.emit("project:import_progress", serde_json::json!({ "projectId": id, "percentage": pct }));
                }
            }, &mut |samples, info| {
                waveform.get_or_insert_with(|| crate::waveform::WaveformBuilder::new(info.rate)).push(samples, info.channels);
            })?;
            if let Some(w) = waveform {
                // Not fatal: the editor builds it on first open if this failed.
                if let Err(e) = w.write(&waveform_path) { eprintln!("Waveform not saved: {e}"); }
            }
            Ok::<_, String>((mono, rate, secs))
        })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Audio decode failed: {}", e))?;

    emit_progress(&app, &project_id, 60).await;

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

/// Decode any supported audio format to **interleaved** f32 PCM at its native
/// sample rate and channel count.
/// Returns (interleaved_samples, sample_rate_hz, channels, duration_secs).
#[cfg(test)]
pub(crate) fn decode_to_interleaved_f32(path: &Path) -> Result<(Vec<f32>, u32, usize, f64), String> {
    decode_f32(path, false, &mut |_| {}, &mut |_, _| {})
}

/// A file that shares how far into it the decoder has read, for progress.
struct ProgressFile {
    file: std::fs::File,
    len:  u64,
    pos:  std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl std::io::Read for ProgressFile {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        self.pos.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
        Ok(n)
    }
}

impl std::io::Seek for ProgressFile {
    fn seek(&mut self, to: std::io::SeekFrom) -> std::io::Result<u64> {
        let at = self.file.seek(to)?;
        self.pos.store(at, std::sync::atomic::Ordering::Relaxed);
        Ok(at)
    }
}

impl symphonia::core::io::MediaSource for ProgressFile {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.len) }
}

/// What a decoded stream is, passed with every packet.
pub(crate) struct StreamInfo {
    pub rate:     u32,
    /// Channels of this packet.
    pub channels: usize,
    /// Total frames, when the container says.
    pub frames:   Option<u64>,
}

/// Decode a file packet by packet at its native rate: `on_packet` gets each
/// packet's interleaved samples; `on_progress` the share of the file read (0–1).
fn decode_stream(
    path:        &Path,
    on_progress: &mut dyn FnMut(f32),
    on_packet:   &mut dyn FnMut(&[f32], &StreamInfo),
) -> Result<(), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::core::errors::Error as SE;

    let file = std::fs::File::open(path)
        .map_err(|e| format!("Cannot open file: {}", e))?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0).max(1);
    let read_pos = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let source = ProgressFile { file, len, pos: read_pos.clone() };
    let mss = MediaSourceStream::new(Box::new(source), Default::default());

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

    let track_id = track.id;
    let rate     = track.codec_params.sample_rate.ok_or("Unknown sample rate")?;
    let frames   = track.codec_params.n_frames;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported codec: {}", e))?;

    // Reused across packets; only re-made when a packet needs more room.
    let mut buf: Option<SampleBuffer<f32>> = None;

    loop {
        on_progress((read_pos.load(std::sync::atomic::Ordering::Relaxed) as f64 / len as f64).min(1.0) as f32);
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
                let needed = decoded.capacity() as u64;
                if buf.as_ref().is_none_or(|b| b.capacity() < needed as usize * spec.channels.count()) {
                    buf = Some(SampleBuffer::<f32>::new(needed, spec));
                }
                let buf = buf.as_mut().expect("just made");
                buf.copy_interleaved_ref(decoded);
                let info = StreamInfo { rate, channels: spec.channels.count().max(1), frames };
                on_packet(buf.samples(), &info);
            }
            Err(SE::DecodeError(_)) => continue, // skip corrupted packets gracefully
            Err(e) => return Err(format!("Decode error: {}", e)),
        }
    }
    Ok(())
}

/// Decode at the native sample rate; `mono` downmixes packet by packet, so the
/// interleaved file is never held. `on_packet` also sees every packet as
/// decoded (interleaved), e.g. to build the waveform in the same pass.
/// Returns (samples, rate, channels, secs).
fn decode_f32(
    path:        &Path,
    mono:        bool,
    on_progress: &mut dyn FnMut(f32),
    on_packet:   &mut dyn FnMut(&[f32], &StreamInfo),
) -> Result<(Vec<f32>, u32, usize, f64), String> {
    let mut pcm: Vec<f32> = Vec::new();
    let mut rate = 0u32;
    let mut out_ch = 1usize;
    decode_stream(path, on_progress, &mut |samples, info| {
        if pcm.is_empty() {
            rate   = info.rate;
            out_ch = if mono { 1 } else { info.channels };
            // Frames × channels, so a long file isn't reallocated over and over.
            let frames = info.frames.map(|f| f as usize).unwrap_or(info.rate as usize * 60 * 5);
            pcm.reserve(frames * out_ch);
        }
        let ch = info.channels;
        if mono && ch > 1 {
            pcm.extend(samples.chunks_exact(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
        } else {
            // Keep every channel, interleaved.
            pcm.extend_from_slice(samples);
        }
        on_packet(samples, info);
    })?;

    if pcm.is_empty() {
        return Err("Audio file appears to be empty".into());
    }

    let duration = (pcm.len() / out_ch) as f64 / rate as f64;
    Ok((pcm, rate, out_ch, duration))
}

/// Decode only `[start_s, end_s)` of a file to mono at its native rate,
/// seeking to the start first: a preview needn't read a long episode through.
/// Returns (samples, rate).
pub(crate) fn decode_window_mono(path: &Path, start_s: f64, end_s: f64) -> Result<(Vec<f32>, u32), String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
    use symphonia::core::errors::Error as SE;
    use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;
    use symphonia::core::units::Time;

    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open file: {}", e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) { hint.with_extension(ext); }
    let mut fmt = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Unsupported audio format: {}", e))?
        .format;
    let track = fmt.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or("No audio track found in file")?.clone();
    let rate = track.codec_params.sample_rate.ok_or("Unknown sample rate")?;
    let time_base = track.codec_params.time_base;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Unsupported codec: {}", e))?;

    let start_s = start_s.max(0.0);
    if start_s > 0.0 {
        let time = Time::new(start_s.floor() as u64, start_s.fract());
        // A file that can't seek is read from the top instead.
        if fmt.seek(SeekMode::Accurate, SeekTo::Time { time, track_id: Some(track.id) }).is_ok() {
            decoder.reset();
        }
    }

    let mut out: Vec<f32> = Vec::with_capacity(((end_s - start_s).max(0.0) * rate as f64) as usize + 1);
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match fmt.next_packet() {
            Ok(p) => p,
            Err(SE::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SE::ResetRequired) => { decoder.reset(); continue; }
            Err(e) => return Err(format!("Read error: {}", e)),
        };
        if packet.track_id() != track.id { continue; }
        let packet_s = time_base.map_or(0.0, |tb| { let t = tb.calc_time(packet.ts()); t.seconds as f64 + t.frac });
        if packet_s >= end_s { break; }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SE::DecodeError(_)) => continue,
            Err(e) => return Err(format!("Decode error: {}", e)),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        if buf.as_ref().is_none_or(|b| b.capacity() < decoded.capacity() * channels) {
            buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let buf = buf.as_mut().expect("just made");
        buf.copy_interleaved_ref(decoded);
        for (i, frame) in buf.samples().chunks_exact(channels).enumerate() {
            let t = packet_s + i as f64 / rate as f64;
            if t < start_s { continue; }
            if t >= end_s { break; }
            out.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    Ok((out, rate))
}

/// Decode a file only to look at it, packet by packet (interleaved samples,
/// channels, rate): nothing is kept.
pub(crate) fn decode_interleaved_with(path: &Path, on_packet: &mut dyn FnMut(&[f32], usize, u32)) -> Result<(), String> {
    decode_stream(path, &mut |_| {}, &mut |samples, info| on_packet(samples, info.channels, info.rate))
}

/// Decode any supported audio format to f32 **mono** PCM (channels downmixed).
/// Returns (samples, sample_rate_hz, duration_secs).
pub(crate) fn decode_to_mono_f32(path: &Path) -> Result<(Vec<f32>, u32, f64), String> {
    decode_to_mono_f32_with_progress(path, &mut |_| {})
}

/// `decode_to_mono_f32`, reporting the share of the file decoded (0–1).
pub(crate) fn decode_to_mono_f32_with_progress(path: &Path, on_progress: &mut dyn FnMut(f32)) -> Result<(Vec<f32>, u32, f64), String> {
    let (mono, src_rate, _, duration) = decode_f32(path, true, on_progress, &mut |_, _| {})?;
    Ok((mono, src_rate, duration))
}

/// Resample mono f32 PCM from `from_hz` to `to_hz` using rubato.
pub(crate) fn resample_mono(samples: &[f32], from_hz: u32, to_hz: u32) -> Result<Vec<f32>, String> {
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

// ─── Audio export ─────────────────────────────────────────────────────────────

/// A range the edits cut, in milliseconds of the original audio.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOp {
    pub start_ms: f64,
    pub end_ms:   f64,
}

/// A pause added in the editor: `ms` of room tone at `at_ms` (original time),
/// looping `[tone_start_ms, tone_end_ms)` of the same recording, or silence.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertOp {
    pub at_ms:         f64,
    pub ms:            f64,
    #[serde(default)]
    pub tone_start_ms: Option<f64>,
    #[serde(default)]
    pub tone_end_ms:   Option<f64>,
}

/// Export the edited audio straight to the path the save dialog chose, in
/// `format` (16-bit WAV when it's left out). Sends `export:progress`.
#[tauri::command]
pub async fn export_audio(
    app:        AppHandle,
    project_id: String,
    ops:        Vec<EditOp>,
    inserts:    Option<Vec<InsertOp>>,
    dest_path:  String,
    enhanced:   Option<bool>,
    format:     Option<ExportFormat>,
) -> Result<(), String> {
    let dir  = project_dir(&app, &project_id)?;
    let dest = PathBuf::from(dest_path);
    let inserts = inserts.unwrap_or_default();
    let format = format.unwrap_or_default();
    format.checked()?;
    let name = format.name();
    let events = app.clone();
    let mut progress = ExportProgress::new(&format, move |phase, p| {
        let _ = events.emit("export:progress", serde_json::json!({
            "projectId": project_id, "phase": phase, "format": name, "progress": p,
        }));
    });

    // Sort ops for a single linear pass through the file.
    let mut sorted = ops;
    sorted.sort_by(|a, b| a.start_ms.partial_cmp(&b.start_ms).unwrap_or(std::cmp::Ordering::Equal));

    // With speech enhancement on, export what's playing: the enhanced audio
    // (48 kHz mono), spliced the same way.
    if enhanced == Some(true) {
        let src = crate::enhance::enhanced_audio_path(&dir).ok_or("The enhanced audio is missing: enhance again or turn it off")?;
        return tokio::task::spawn_blocking(move || {
            let (samples, rate, channels) = read_wav(&src, &mut progress)?;
            write_spliced(&samples, channels, rate, &sorted, &inserts, &format, &dest, &mut progress)
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    // Prefer full fidelity: the original imported file at its native sample
    // rate and channels. Only if it's missing or can't be decoded here, the
    // 16 kHz mono WAV made for transcription.
    let original = find_original_audio(&dir);
    let wav_16k  = dir.join("audio_16k.wav");

    tokio::task::spawn_blocking(move || {
        let read = original
            .ok_or_else(|| "no original".to_string())
            .and_then(|orig| decode_f32(&orig, false, &mut |p| progress.reading(p), &mut |_, _| {}))
            .map(|(samples, rate, channels, _)| (samples, rate, channels));
        let (samples, rate, channels) = match read {
            Ok(audio) => audio,
            Err(e) => {
                eprintln!("Full-fidelity export failed ({e}); falling back to 16 kHz mono");
                if !wav_16k.exists() {
                    return Err("Audio file not found — import audio first".into());
                }
                read_wav(&wav_16k, &mut progress)?
            }
        };
        write_spliced(&samples, channels, rate, &sorted, &inserts, &format, &dest, &mut progress)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Export's progress as one 0–1, sent as `export:progress`: reading the audio,
/// then writing the file. Encoding is most of the work for MP3 and AAC; for
/// WAV and FLAC it's quick, and reading is most of it.
struct ExportProgress {
    emit:       Box<dyn FnMut(&'static str, f32) + Send>,
    read_share: f32,
    sent:       (&'static str, f32),
}

impl ExportProgress {
    fn new(format: &ExportFormat, emit: impl FnMut(&'static str, f32) + Send + 'static) -> Self {
        let read_share = match format { ExportFormat::Mp3 { .. } | ExportFormat::Aac { .. } => 0.25, _ => 0.6 };
        Self { emit: Box::new(emit), read_share, sent: ("", -1.0) }
    }

    fn reading(&mut self, p: f32) { self.send("reading", p * self.read_share); }

    fn writing(&mut self, p: f32) {
        let share = self.read_share;
        self.send("writing", share + p * (1.0 - share));
    }

    /// At most one event per percent, and one when the phase changes.
    fn send(&mut self, phase: &'static str, p: f32) {
        if phase == self.sent.0 && p < 1.0 && p - self.sent.1 < 0.01 { return; }
        self.sent = (phase, p);
        (self.emit)(phase, p);
    }
}

/// Locate the preserved original import (`audio_original.<ext>`) in a project dir.
pub(crate) fn find_original_audio(dir: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with("audio_original.") {
            return Some(entry.path());
        }
    }
    None
}

/// A WAV (the enhanced audio, or the 16 kHz copy) as interleaved f32: the
/// samples, the rate and the channels.
fn read_wav(src: &std::path::Path, progress: &mut ExportProgress) -> Result<(Vec<f32>, u32, usize), String> {
    let mut reader = hound::WavReader::open(src)
        .map_err(|e| format!("Open audio: {}", e))?;
    let in_spec  = reader.spec();
    let channels = (in_spec.channels as usize).max(1);

    let samples: Vec<f32> = match in_spec.sample_format {
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
    progress.reading(1.0);
    Ok((samples, in_spec.sample_rate, channels))
}

/// The edited audio, interleaved: the kept pieces (cut edges snapped to zero
/// crossings) and the added pauses, joined with 8 ms equal-power crossfades.
fn splice(samples: &[f32], channels: usize, sr_hz: u32, ops: &[EditOp], inserts: &[InsertOp]) -> Vec<f32> {
    let ch = channels.max(1);
    let sr = sr_hz as f64;
    let total_frames = samples.len() / ch;

    // ── Convert op boundaries (ms → frame indices), clamp, filter, sort, merge ─
    let mut cuts: Vec<(usize, usize)> = ops
        .iter()
        .map(|op| {
            let s = ((op.start_ms / 1000.0) * sr).round() as usize;
            let e = ((op.end_ms   / 1000.0) * sr).round() as usize;
            (s.min(total_frames), e.min(total_frames))
        })
        .filter(|(s, e)| e > s)
        .collect();
    cuts.sort_by_key(|&(s, _)| s);

    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in cuts {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }

    // ── Snap each cut edge to a nearby zero-crossing (±2 ms, on channel 0) ────
    let snap_win = ((2.0 / 1000.0) * sr).round() as usize;
    for (s, e) in merged.iter_mut() {
        *s = nearest_zero_crossing_frame(samples, ch, *s, snap_win);
        *e = nearest_zero_crossing_frame(samples, ch, *e, snap_win);
    }
    merged.retain(|&(s, e)| e > s);

    // ── Build the kept frame segments (complement of the cut ranges) ──────────
    let mut kept: Vec<(usize, usize)> = Vec::new();
    let mut cursor = 0usize;
    for &(s, e) in &merged {
        if s > cursor {
            kept.push((cursor, s));
        }
        cursor = e.max(cursor);
    }
    if cursor < total_frames {
        kept.push((cursor, total_frames));
    }

    // ── Added pauses go between kept pieces: at their point, or at the join
    //    of the cut they fall in (as the player places them) ─────────────────
    let mut pauses: Vec<(usize, usize, Option<(usize, usize)>)> = inserts
        .iter()
        .filter(|p| p.ms > 0.0)
        .map(|p| {
            let mut at = (((p.at_ms / 1000.0) * sr).round() as usize).min(total_frames);
            if let Some(&(_, e)) = merged.iter().find(|&&(s, e)| at >= s && at < e) { at = e; }
            let frames = ((p.ms / 1000.0) * sr).round() as usize;
            let tone = match (p.tone_start_ms, p.tone_end_ms) {
                (Some(a), Some(b)) => {
                    let (a, b) = ((((a / 1000.0) * sr) as usize).min(total_frames), (((b / 1000.0) * sr) as usize).min(total_frames));
                    (b > a + 1).then_some((a, b))
                }
                _ => None,
            };
            (at, frames, tone)
        })
        .collect();
    pauses.sort_by_key(|&(at, _, _)| at);

    enum Piece { Audio(usize, usize), Pause(usize, Option<(usize, usize)>) }
    let mut pieces: Vec<Piece> = Vec::new();
    let mut next = 0;
    for &(s, e) in &kept {
        let mut from = s;
        while next < pauses.len() && pauses[next].0 < e {
            let (at, frames, tone) = pauses[next];
            if at > from { pieces.push(Piece::Audio(from, at)); from = at; }
            pieces.push(Piece::Pause(frames, tone));
            next += 1;
        }
        if e > from { pieces.push(Piece::Audio(from, e)); }
    }
    for &(_, frames, tone) in &pauses[next..] { pieces.push(Piece::Pause(frames, tone)); }

    // ── Assemble output frames with an equal-power crossfade at every join ────
    let xfade = ((8.0 / 1000.0) * sr).round() as usize; // fade length in frames
    let mut out: Vec<f32> = Vec::with_capacity(samples.len());

    for (seg_idx, piece) in pieces.iter().enumerate() {
        // A pause is room tone looped to length (frame i reads tone frame i mod its length), or silence.
        let generated: Vec<f32>;
        let seg: &[f32] = match *piece {
            Piece::Audio(s, e) => &samples[s * ch..e * ch],
            Piece::Pause(frames, tone) => {
                generated = match tone {
                    Some((a, b)) => (0..frames).flat_map(|i| {
                        let f = a + i % (b - a);
                        samples[f * ch..(f + 1) * ch].iter().copied()
                    }).collect(),
                    None => vec![0.0; frames * ch],
                };
                &generated
            }
        };
        let seg_frames = seg.len() / ch;
        if seg_idx == 0 || out.is_empty() {
            out.extend_from_slice(seg);
            continue;
        }
        let out_frames = out.len() / ch;
        // Overlap is bounded by the fade length, the incoming segment, and what
        // has already been written.
        let f = xfade.min(seg_frames).min(out_frames);
        if f == 0 {
            out.extend_from_slice(seg);
            continue;
        }
        let base_frame = out_frames - f;
        for k in 0..f {
            let t     = (k as f32 + 0.5) / f as f32;            // 0 → 1 across fade
            let g_out = (t * std::f32::consts::FRAC_PI_2).cos(); // 1 → 0
            let g_in  = (t * std::f32::consts::FRAC_PI_2).sin(); // 0 → 1
            for c in 0..ch {
                let oi = (base_frame + k) * ch + c;
                let si = k * ch + c;
                out[oi] = out[oi] * g_out + seg[si] * g_in;
            }
        }
        out.extend_from_slice(&seg[f * ch..]);
    }
    out
}


/// Splice interleaved f32 PCM by removing `ops` time ranges, joining the kept
/// segments with an equal-power crossfade, and writing the result as a 16-bit
/// PCM WAV with `channels` channels at `sr_hz`.
///
/// ## Why a gentle (crossfade) join
/// A hard splice jumps the amplitude discontinuously → a click.  Fading both
/// sides to silence removes the click but leaves an audible dip.  Instead we
/// overlap the outgoing tail and incoming head and blend them with
/// constant-power gains (cos/sin) so loudness stays flat across the join.  Each
/// cut edge is first snapped to a nearby zero-crossing so there is almost
/// nothing to smooth over.
///
/// ## Why 16-bit PCM output
/// WebKit / Safari mis-handle 32-bit float WAV (they can misread the bit depth
/// and play at 3× speed or emit static).  16-bit signed PCM (WAVE_FORMAT_PCM,
/// 0x0001) is universally supported by every browser engine and audio player.
#[allow(clippy::too_many_arguments)]
fn write_spliced(
    samples:  &[f32],
    channels: usize,
    sr_hz:    u32,
    ops:      &[EditOp],
    inserts:  &[InsertOp],
    format:   &ExportFormat,
    dst:      &std::path::Path,
    progress: &mut ExportProgress,
) -> Result<(), String> {
    let out = splice(samples, channels, sr_hz, ops, inserts);
    crate::encode::write(&out, channels.max(1), sr_hz, format, dst, &mut |p| progress.writing(p))
}

/// Find the frame index nearest `frame` (within ±`window` frames) where channel
/// 0 of the interleaved signal crosses zero.  Falls back to `frame` (clamped)
/// when no crossing is found in the window.
fn nearest_zero_crossing_frame(samples: &[f32], ch: usize, frame: usize, window: usize) -> usize {
    let total_frames = samples.len() / ch;
    if total_frames == 0 { return 0; }
    let idx = frame.min(total_frames - 1);
    if window == 0 { return idx; }

    let lo = idx.saturating_sub(window);
    let hi = (idx + window).min(total_frames - 1);

    let mut best      = idx;
    let mut best_dist = usize::MAX;
    let mut i = lo;
    while i < hi {
        let a = samples[i * ch];        // channel 0 of frame i
        let b = samples[(i + 1) * ch];  // channel 0 of frame i+1
        if (a <= 0.0 && b >= 0.0) || (a >= 0.0 && b <= 0.0) {
            let dist = if i >= idx { i - idx } else { idx - i };
            if dist < best_dist {
                best_dist = dist;
                best = i;
            }
        }
        i += 1;
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn added_pauses_are_spliced_in() {
        let sr = 48_000u32;
        let mut x: Vec<f32> = (0..sr as usize).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        for v in x[43_200..].iter_mut() { *v *= 0.01; } // a quiet stretch to use as room tone
        let xf = 384; // the 8 ms crossfade, overlapped at each join

        // 250 ms at 0.5 s, room tone from 0.9–1.0 s: the file grows by it.
        let inserts = [InsertOp { at_ms: 500.0, ms: 250.0, tone_start_ms: Some(900.0), tone_end_ms: Some(1000.0) }];
        let out = splice(&x, 1, sr, &[], &inserts);
        assert_eq!(out.len(), 48_000 + 12_000 - 2 * xf);
        assert!(out[24_000 + 1_000..24_000 + 10_000].iter().all(|v| v.abs() < 0.01), "the pause is the quiet room tone");
        assert!(out[34_000..].iter().take(2_000).any(|v| v.abs() > 0.3), "the audio carries on after it");

        // Inside a cut, it goes at the cut's join.
        let ops = [EditOp { start_ms: 400.0, end_ms: 600.0 }];
        let inserts = [InsertOp { at_ms: 500.0, ms: 100.0, tone_start_ms: None, tone_end_ms: None }];
        let out = splice(&x, 1, sr, &ops, &inserts);
        let expected = 48_000 - 9_600 + 4_800 - 2 * xf;
        assert!((out.len() as i64 - expected as i64).abs() < 200, "length {} vs {expected}", out.len());
    }

    /// The export path end to end, without the app: read, splice, encode, and
    /// report progress in order.
    #[test]
    fn exports_the_edit_as_mp3_with_progress() {
        let sr = 44_100u32;
        let x: Vec<f32> = (0..2 * sr as usize).flat_map(|i| {
            let v = (i as f32 * 0.03).sin() * 0.4;
            [v, -v]
        }).collect();
        let dir = std::env::temp_dir().join(format!("wave-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dst = dir.join("edit.mp3");
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = events.clone();
        let format = ExportFormat::Mp3 { kbps: 128, mono: false };
        let mut progress = ExportProgress::new(&format, move |phase, p| seen.lock().unwrap().push((phase, p)));
        progress.reading(1.0);
        // Half a second cut from the middle.
        write_spliced(&x, 2, sr, &[EditOp { start_ms: 750.0, end_ms: 1250.0 }], &[], &format, &dst, &mut progress).unwrap();

        let (y, rate, ch, _) = decode_to_interleaved_f32(&dst).unwrap();
        assert_eq!((rate, ch), (sr, 2));
        let secs = y.len() as f64 / 2.0 / sr as f64;
        assert!((1.49..1.56).contains(&secs), "{secs:.3} s after a 0.5 s cut from 2 s");

        let events = events.lock().unwrap();
        assert_eq!(events.first().map(|e| e.0), Some("reading"));
        assert_eq!(events.last().copied(), Some(("writing", 1.0)));
        assert!(events.windows(2).all(|w| w[1].1 >= w[0].1), "progress went backwards: {events:?}");
        assert!(!dir.join(".edit.mp3.part").exists());
    }

    #[test]
    fn leftovers_are_only_the_dead_files() {
        for name in ["peaks.json", "fillers.json", "preview_1712345678901.wav", "waveform.bin.part", "audio_enhanced-1712345678901.wav.part"] {
            assert!(is_leftover(name), "{name}");
        }
        for name in [
            "project.json", "transcript.json", "edits.json", "speakers.json", "enhance.json",
            "waveform.bin", "audio_16k.wav", "audio_original.mp3", "audio_enhanced-1712345678901.wav", "preview.json",
        ] {
            assert!(!is_leftover(name), "{name}");
        }
    }

    /// How long decoding and resampling take (not run by default):
    /// `AUDIO=…/file.mp3 cargo test import_speed -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn import_speed() {
        let path = std::env::var("AUDIO").expect("AUDIO");
        let t0 = std::time::Instant::now();
        let (mono, rate, secs) = decode_to_mono_f32(Path::new(&path)).unwrap();
        let decode = t0.elapsed().as_secs_f64();
        let t1 = std::time::Instant::now();
        let out = resample_mono(&mono, rate, 16_000).unwrap();
        println!("{secs:.0} s of audio: decode {decode:.1} s, resample {:.1} s ({} samples)", t1.elapsed().as_secs_f64(), out.len());
    }
}
