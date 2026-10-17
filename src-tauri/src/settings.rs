use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// The model id to use for transcription (e.g. "large-v3-turbo").
    /// None means no model has been selected yet.
    pub selected_model_id: Option<String>,
    /// AI agents may connect through `wave mcp` (agent.rs). Off until turned on.
    #[serde(default)]
    pub agent_access: bool,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn read(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

/// Save Wave's settings into the file, keeping any other keys already in it.
pub fn write(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = merged(std::fs::read_to_string(&path).ok().as_deref(), settings)?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

/// `existing` (the file as it is) with Wave's settings written over it.
fn merged(existing: Option<&str>, settings: &AppSettings) -> Result<String, String> {
    let mut file = existing
        .and_then(|raw| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw).ok())
        .unwrap_or_default();
    if let serde_json::Value::Object(ours) = serde_json::to_value(settings).map_err(|e| e.to_string())? {
        file.extend(ours);
    }
    serde_json::to_string_pretty(&file).map_err(|e| e.to_string())
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    read(&app)
}

/// Save the model choice. Agent access has its own command (set_agent_access),
/// so it's kept as it is on disk.
#[tauri::command]
pub fn set_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let mut current = read(&app)?;
    current.selected_model_id = settings.selected_model_id;
    write(&app, &current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saving_keeps_keys_wave_does_not_know() {
        let settings = AppSettings { selected_model_id: Some("large-v3-turbo".into()), agent_access: true };
        let out = merged(Some(r#"{ "selectedModelId": null, "someoneElses": "keep me" }"#), &settings).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["someoneElses"], "keep me");
        assert_eq!(v["selectedModelId"], "large-v3-turbo");
        assert_eq!(v["agentAccess"], true);
        // A missing or unreadable file is just replaced.
        assert!(merged(None, &settings).unwrap().contains("agentAccess"));
        assert!(merged(Some("not json"), &settings).unwrap().contains("agentAccess"));
    }
}
