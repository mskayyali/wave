// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `wave mcp`: the MCP server agent apps launch (src/mcp.rs), not the app.
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        wave_lib::mcp::run();
        return;
    }
    wave_lib::run()
}
