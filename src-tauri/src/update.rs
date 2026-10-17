//! The app side of updates. The updater plugin checks, downloads, verifies and
//! installs; src/lib/updater.ts drives it. Here: whether this copy of Wave can
//! update itself, and the menu item that follows an update along.

use std::path::Path;

use serde::Serialize;
use tauri::menu::MenuItem;
use tauri::{AppHandle, State, Wry};

/// The Wave menu's "Check for Updates…" item, renamed as an update moves along.
pub struct UpdateMenuItem(pub MenuItem<Wry>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSupport {
    /// Why this copy can't update itself, or none when it can:
    /// - `unsigned`: built without the updater's public key (a local build);
    /// - `not-bundled`: not running from an app bundle (`tauri dev`);
    /// - `translocated`: opened from where it was downloaded, which macOS runs
    ///   from a read-only copy until it's moved;
    /// - `read-only`: running from the DMG, or another read-only disk.
    reason: Option<&'static str>,
}

#[tauri::command]
pub fn update_support(app: AppHandle) -> UpdateSupport {
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or("");
    let bundle = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf));
    let reason = match bundle {
        _ if pubkey.trim().is_empty() => Some("unsigned"),
        None => Some("not-bundled"),
        Some(path) if path.to_string_lossy().contains("/AppTranslocation/") => Some("translocated"),
        Some(path) if read_only(&path) => Some("read-only"),
        Some(_) => None,
    };
    UpdateSupport { reason }
}

/// Whether the disk holding `path` is mounted read-only (a DMG, for one).
fn read_only(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    // SAFETY: statvfs fills the struct it's given, and c_path is a valid C string.
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) == 0 && stats.f_flag & libc::ST_RDONLY != 0 }
}

#[tauri::command]
pub fn set_update_menu_label(item: State<UpdateMenuItem>, label: String) -> Result<(), String> {
    item.0.set_text(label).map_err(|e| e.to_string())
}
