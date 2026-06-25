use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

// ─── Model catalog ────────────────────────────────────────────────────────────

const HF_BASE: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

struct ModelSpec {
    id: &'static str,
    filename: &'static str,
}

const KNOWN_MODELS: &[ModelSpec] = &[
    ModelSpec { id: "tiny.en",          filename: "ggml-tiny.en.bin"          },
    ModelSpec { id: "base.en",          filename: "ggml-base.en.bin"          },
    ModelSpec { id: "small.en",         filename: "ggml-small.en.bin"         },
    ModelSpec { id: "medium.en",        filename: "ggml-medium.en.bin"        },
    ModelSpec { id: "large-v3-turbo",   filename: "ggml-large-v3-turbo.bin"   },
    ModelSpec { id: "large-v3",         filename: "ggml-large-v3.bin"         },
];

fn spec_for(model_id: &str) -> Option<&'static ModelSpec> {
    KNOWN_MODELS.iter().find(|m| m.id == model_id)
}

// ─── Shared types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ModelStatus {
    NotDownloaded,
    Partial {
        #[serde(rename = "downloadedBytes")]
        downloaded_bytes: u64,
    },
    Downloading,
    Ready {
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub filename: String,
    pub status: ModelStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percentage: f32,
    /// bytes/sec
    pub speed_bps: f64,
    /// estimated seconds remaining
    pub eta_secs: u64,
    pub resuming: bool,
}

// ─── App state ────────────────────────────────────────────────────────────────

/// Tauri managed state — lives for the entire app lifetime.
pub struct DownloadManager {
    /// model_id → cancellation flag. Flag set to `true` = cancel requested.
    cancellers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            cancellers: Mutex::new(HashMap::new()),
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn format_download_error(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "Cannot connect — check your internet connection".to_string()
    } else if e.is_timeout() {
        "Connection timed out — check your internet and try again".to_string()
    } else if e.is_request() {
        "Request failed — try again".to_string()
    } else {
        format!("Network error: {}", e)
    }
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Return the status of every known model. Always returns all 6 entries.
#[tauri::command]
pub fn list_models(
    app: AppHandle,
    state: tauri::State<DownloadManager>,
) -> Result<Vec<ModelInfo>, String> {
    let dir = models_dir(&app)?;
    let active = state.cancellers.lock().unwrap();

    let infos = KNOWN_MODELS
        .iter()
        .map(|spec| {
            let final_path = dir.join(spec.filename);
            let part_path  = dir.join(format!("{}.part", spec.filename));
            let is_active  = active.contains_key(spec.id);

            let status = if is_active {
                ModelStatus::Downloading
            } else if final_path.exists() {
                let size = std::fs::metadata(&final_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                ModelStatus::Ready { size_bytes: size }
            } else if part_path.exists() {
                let size = std::fs::metadata(&part_path)
                    .map(|m| m.len())
                    .unwrap_or(0);
                ModelStatus::Partial { downloaded_bytes: size }
            } else {
                ModelStatus::NotDownloaded
            };

            ModelInfo {
                id: spec.id.to_string(),
                filename: spec.filename.to_string(),
                status,
            }
        })
        .collect();

    Ok(infos)
}

/// Start downloading a model. Returns immediately; progress comes via events:
///   `model:progress`   → DownloadProgress
///   `model:complete`   → model_id: String
///   `model:error`      → { modelId, message }
///   `model:cancelled`  → model_id: String
#[tauri::command]
pub async fn start_model_download(
    app: AppHandle,
    state: tauri::State<'_, DownloadManager>,
    model_id: String,
) -> Result<(), String> {
    let spec = spec_for(&model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let dir = models_dir(&app)?;
    let final_path = dir.join(spec.filename);
    let part_path  = dir.join(format!("{}.part", spec.filename));

    if final_path.exists() {
        return Err("already_downloaded".to_string());
    }

    {
        let active = state.cancellers.lock().unwrap();
        if active.contains_key(&model_id) {
            return Err("already_downloading".to_string());
        }
    }

    // Register a cancellation flag before spawning
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.cancellers.lock().unwrap();
        active.insert(model_id.clone(), cancel_flag.clone());
    }

    let url         = format!("{}/{}", HF_BASE, spec.filename);
    let app_clone   = app.clone();
    let mid         = model_id.clone();

    tokio::spawn(async move {
        let result = do_download(
            app_clone.clone(),
            mid.clone(),
            url,
            part_path,
            final_path,
            cancel_flag,
        )
        .await;

        // Always clean up the canceller entry
        {
            let dm = app_clone.state::<DownloadManager>();
            let mut active = dm.cancellers.lock().unwrap();
            active.remove(&mid);
        }

        match result {
            Ok(()) => {
                let _ = app_clone.emit("model:complete", &mid);
            }
            Err(ref e) if e == "cancelled" => {
                let _ = app_clone.emit("model:cancelled", &mid);
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "model:error",
                    serde_json::json!({ "modelId": &mid, "message": e }),
                );
            }
        }
    });

    Ok(())
}

/// Signal a running download to stop. The .part file is kept for resuming.
#[tauri::command]
pub fn cancel_model_download(
    state: tauri::State<DownloadManager>,
    model_id: String,
) -> Result<(), String> {
    let active = state.cancellers.lock().unwrap();
    match active.get(&model_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("no_active_download".to_string()),
    }
}

/// Remove a downloaded model (or any partial file) from disk.
#[tauri::command]
pub fn delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let spec = spec_for(&model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let dir       = models_dir(&app)?;
    let path      = dir.join(spec.filename);
    let part_path = dir.join(format!("{}.part", spec.filename));
    let mut deleted = false;

    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        deleted = true;
    }
    if part_path.exists() {
        std::fs::remove_file(&part_path).map_err(|e| e.to_string())?;
        deleted = true;
    }

    if deleted { Ok(()) } else { Err("file_not_found".to_string()) }
}

// ─── Core download logic ──────────────────────────────────────────────────────

async fn do_download(
    app: AppHandle,
    model_id: String,
    url: String,
    part_path: PathBuf,
    final_path: PathBuf,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {

    // ── Resume support ────────────────────────────────────────────────────────
    let resume_from: u64 = if part_path.exists() {
        tokio::fs::metadata(&part_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    let resuming = resume_from > 0;

    // ── Build request ─────────────────────────────────────────────────────────
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&url);
    if resume_from > 0 {
        req = req.header("Range", format!("bytes={}-", resume_from));
    }

    let response = req.send().await.map_err(|e| format_download_error(&e))?;

    let status = response.status();
    // 200 OK (full) or 206 Partial Content (resume) are both fine
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => "Model file not found on server — try again later".to_string(),
            429 => "Rate limited by server — wait a moment and try again".to_string(),
            503 => "Server unavailable — try again later".to_string(),
            s   => format!("Server returned HTTP {}", s),
        });
    }

    let content_length = response.content_length().unwrap_or(0);
    let total_bytes = content_length + resume_from;

    // ── Open file ─────────────────────────────────────────────────────────────
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(resuming)
        .write(!resuming)
        .open(&part_path)
        .await
        .map_err(|e| format!("Cannot open file for writing: {}", e))?;

    // ── Stream ────────────────────────────────────────────────────────────────
    let mut downloaded    = resume_from;
    let mut stream        = response.bytes_stream();
    let start_time        = std::time::Instant::now();
    let mut last_emit     = std::time::Instant::now();

    while let Some(chunk_result) = stream.next().await {
        // Check cancellation between every chunk
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = file.flush().await;
            return Err("cancelled".to_string());
        }

        let bytes = chunk_result.map_err(|e| {
            if e.is_connect() || e.is_timeout() {
                "Connection lost — try again to resume".to_string()
            } else {
                format!("Download interrupted: {}", e)
            }
        })?;

        file.write_all(&bytes).await.map_err(|e| {
            // ENOSPC = errno 28
            if e.raw_os_error() == Some(28) {
                "Not enough disk space — free up space and try again".to_string()
            } else {
                format!("Write error: {}", e)
            }
        })?;

        downloaded += bytes.len() as u64;

        // Emit progress at ~4 Hz to avoid flooding the frontend
        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            last_emit = std::time::Instant::now();
            let elapsed_secs = start_time.elapsed().as_secs_f64();
            let net_downloaded = downloaded - resume_from;
            let speed_bps = if elapsed_secs > 0.0 {
                net_downloaded as f64 / elapsed_secs
            } else {
                0.0
            };
            let eta_secs = if speed_bps > 0.0 && total_bytes > downloaded {
                ((total_bytes - downloaded) as f64 / speed_bps) as u64
            } else {
                0
            };

            let _ = app.emit("model:progress", DownloadProgress {
                model_id:         model_id.clone(),
                downloaded_bytes: downloaded,
                total_bytes,
                percentage: if total_bytes > 0 {
                    (downloaded as f64 / total_bytes as f64 * 100.0) as f32
                } else {
                    0.0
                },
                speed_bps,
                eta_secs,
                resuming,
            });
        }
    }

    // ── Finalize ──────────────────────────────────────────────────────────────
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    // Sanity-check: if server gave us a Content-Length, verify we got it all
    if content_length > 0 {
        let actual = tokio::fs::metadata(&part_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        if actual < total_bytes {
            return Err(format!(
                "Download incomplete ({} of {} bytes) — try again to resume",
                actual, total_bytes
            ));
        }
    }

    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| format!("Could not finalize file: {}", e))?;

    Ok(())
}
