//! The menu bar. Wave's own items carry their shortcuts and reach the
//! frontend as a `menu` event with the item's id (src/lib/commands.ts); the
//! text-editing items (cut, copy, paste, select all) stay the system's own.
//!
//! WebKit offers a key to the page before the menu: the editor handles
//! ⌘Z/⇧⌘Z itself (and calls preventDefault), so a key press runs once. A click
//! on Undo, or ⌘Z in a text field, arrives here instead.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, shortcut: &str| -> tauri::Result<MenuItem<R>> {
        MenuItemBuilder::with_id(id, text).accelerator(shortcut).build(app)
    };
    // About opens Wave's own panel (the welcome animation, what Wave does, who
    // made it), not the system's plain box.
    let wave = SubmenuBuilder::new(app, "Wave")
        .item(&MenuItemBuilder::with_id("about", "About Wave").build(app)?)
        .separator()
        .item(&item("settings", "Settings…", "CmdOrCtrl+,")?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-project", "New Project…", "CmdOrCtrl+N")?)
        .separator()
        .item(&item("back", "Back to Projects", "CmdOrCtrl+[")?)
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", "CmdOrCtrl+Z")?)
        .item(&item("redo", "Redo", "CmdOrCtrl+Shift+Z")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find…", "CmdOrCtrl+F")?)
        .item(&item("find-next", "Find Next", "CmdOrCtrl+G")?)
        .item(&item("find-previous", "Find Previous", "CmdOrCtrl+Shift+G")?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("view-flow", "Flow", "CmdOrCtrl+1")?)
        .item(&item("view-segments", "Segments", "CmdOrCtrl+2")?)
        .separator()
        .fullscreen()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("shortcuts", "Keyboard Shortcuts", "CmdOrCtrl+/")?)
        .build()?;

    Menu::with_items(app, &[&wave, &file, &edit, &view, &window, &help])
}

/// Pass Wave's own items to the frontend.
pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let _ = app.emit("menu", event.id().as_ref());
}
