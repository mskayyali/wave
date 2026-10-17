fn main() {
    // `tauri dev` runs the bare binary, whose Dock icon is a copy of
    // icons/icon.icns compiled in; Cargo doesn't otherwise notice the icons change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
