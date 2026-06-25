mod models;
mod projects;
mod settings;
mod transcription;

use models::DownloadManager;

/// Write arbitrary text to a file path chosen by the frontend (via save dialog).
#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DownloadManager::new())
        .invoke_handler(tauri::generate_handler![
            models::list_models,
            models::start_model_download,
            models::cancel_model_download,
            models::delete_model,
            projects::list_projects,
            projects::create_project,
            projects::rename_project,
            projects::delete_project,
            projects::import_audio,
            projects::get_audio_path,
            projects::get_playback_audio_path,
            projects::load_peaks,
            projects::save_peaks,
            projects::load_edits,
            projects::save_edits,
            projects::generate_preview,
            projects::export_audio,
            settings::get_settings,
            settings::set_settings,
            transcription::transcribe,
            transcription::get_transcript,
            save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
