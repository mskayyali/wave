mod agent;
mod alignment;
mod dpdfnet;
mod encode;
mod enhance;
mod eq;
mod lame;
mod master;
pub mod mcp;
mod menu;
mod models;
mod projects;
mod settings;
mod speakers;
mod transcription;
mod update;
mod waveform;

use models::DownloadManager;
use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

/// Write arbitrary text to a file path chosen by the frontend (via save dialog).
#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .menu(|app| menu::build(app))
        .on_menu_event(|app, event| menu::handle(app, event))
        // Window size and position are remembered. Not its visibility: it
        // starts hidden and the frontend shows it once drawn.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE - StateFlags::DECORATIONS)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Updates: checked, downloaded, verified against the public key in
        // tauri.conf.json and installed by the plugin; process relaunches.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(DownloadManager::new())
        .manage(agent::AgentState::default())
        .setup(|app| {
            projects::remove_leftovers(app.handle());
            models::remove_retired(app.handle());
            agent::restore(app.handle());
            // The window starts hidden and the frontend shows it once it has
            // painted (main.tsx). If it never does (a broken build), show it
            // anyway rather than leave the app invisible.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent::agent_reply,
            agent::agent_status,
            agent::set_agent_access,
            models::list_models,
            models::start_model_download,
            models::cancel_model_download,
            models::delete_model,
            enhance::enhance_audio,
            enhance::preview_enhancement,
            enhance::cancel_enhance,
            enhance::get_enhancement,
            enhance::set_enhancement_enabled,
            enhance::remove_enhancement,
            projects::list_projects,
            projects::create_project,
            projects::rename_project,
            projects::delete_project,
            projects::import_audio,
            projects::get_audio_path,
            projects::get_playback_audio_path,
            projects::load_edits,
            projects::save_edits,
            projects::export_audio,
            speakers::detect_speakers,
            speakers::get_speakers,
            speakers::save_speakers,
            settings::get_settings,
            settings::set_settings,
            waveform::get_waveform,
            waveform::get_waveform_overview,
            transcription::transcribe,
            transcription::get_transcript,
            transcription::realign_transcript,
            update::update_support,
            update::set_update_menu_label,
            save_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
