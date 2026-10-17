//! AI agents: the app's end of `wave mcp` (mcp.rs).
//!
//! With agent access on (Settings → AI agents), Wave listens on a Unix socket
//! in its data folder, which only this user can open. `wave mcp`, the MCP
//! server an agent app launches, sends each tool call there as one JSON line.
//! The call goes to the frontend (`agent:request`), which runs it in the editor
//! (src/lib/agentTools.ts) and answers through `agent_reply`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

use crate::settings;

/// The socket's name in the app data folder; mcp.rs finds it there.
pub const SOCKET_FILE: &str = "agent.sock";

/// Longest a tool call may take. Agent apps give up at about a minute
/// (Codex's default is 60 s), so long jobs start and return at once.
const CALL_TIMEOUT: Duration = Duration::from_secs(55);

type Reply = Result<String, String>;

#[derive(Default)]
pub struct AgentState {
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    server:  Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

/// One tool call, as `wave mcp` sends it.
#[derive(Deserialize)]
struct Call {
    tool:      String,
    #[serde(default)]
    arguments: serde_json::Value,
    /// The agent app, as it named itself to `wave mcp` ("Claude", "Codex"…).
    #[serde(default)]
    client:    Option<String>,
}

/// The answer: the tool's text, or why it failed.
#[derive(Serialize)]
struct Answer {
    ok:   bool,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    /// Agent access is on and Wave is listening.
    pub enabled: bool,
    /// The command agent apps run (`<command> mcp`): this executable.
    pub command: String,
}

fn socket_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(SOCKET_FILE))
}

/// Start listening (no-op if already listening).
pub fn start(app: &AppHandle) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let state = app.state::<AgentState>();
    let mut server = state.server.lock().unwrap();
    if server.is_some() {
        return Ok(());
    }
    let path = socket_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // A socket file left by a previous run (a crash) would block the bind.
    let _ = std::fs::remove_file(&path);
    let listener = std::os::unix::net::UnixListener::bind(&path).map_err(|e| format!("Could not listen for agents: {e}"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let app = app.clone();
    *server = Some(tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::UnixListener::from_std(listener) else { return };
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = serve(app, stream).await;
            });
        }
    }));
    Ok(())
}

/// Stop listening and remove the socket.
pub fn stop(app: &AppHandle) {
    let state = app.state::<AgentState>();
    if let Some(task) = state.server.lock().unwrap().take() {
        task.abort();
    }
    if let Ok(path) = socket_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Answer the calls on one connection, one JSON line each.
async fn serve(app: AppHandle, stream: tokio::net::UnixStream) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    while let Some(line) = lines.next_line().await? {
        let reply = match serde_json::from_str::<Call>(&line) {
            Ok(call) => forward(&app, call).await,
            Err(e)   => Err(format!("Wave couldn't read the request: {e}")),
        };
        let answer = match reply {
            Ok(text)  => Answer { ok: true, text },
            Err(text) => Answer { ok: false, text },
        };
        let mut json = serde_json::to_string(&answer).unwrap_or_default();
        json.push('\n');
        write.write_all(json.as_bytes()).await?;
    }
    Ok(())
}

/// Hand a call to the frontend and wait for its `agent_reply`.
async fn forward(app: &AppHandle, call: Call) -> Reply {
    let state = app.state::<AgentState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, tx);
    let sent = app.emit("agent:request", serde_json::json!({
        "id":        id,
        "tool":      call.tool,
        "arguments": call.arguments,
        "client":    call.client,
    }));
    let result = match sent {
        Ok(()) => tokio::time::timeout(CALL_TIMEOUT, rx).await,
        Err(e) => {
            state.pending.lock().unwrap().remove(&id);
            return Err(format!("Wave couldn't pass the request on: {e}"));
        }
    };
    state.pending.lock().unwrap().remove(&id);
    match result {
        Ok(Ok(reply)) => reply,
        Ok(Err(_))    => Err("Wave dropped the request.".into()),
        Err(_)        => Err("Wave didn't answer in time. Is the window still open?".into()),
    }
}

/// The frontend's answer to an `agent:request`.
#[tauri::command]
pub fn agent_reply(state: State<'_, AgentState>, id: u64, ok: bool, text: String) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(if ok { Ok(text) } else { Err(text) });
    }
}

fn status(app: &AppHandle) -> AgentStatus {
    AgentStatus {
        enabled: app.state::<AgentState>().server.lock().unwrap().is_some(),
        command: std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

#[tauri::command]
pub fn agent_status(app: AppHandle) -> AgentStatus {
    status(&app)
}

/// Turn agent access on or off; remembered across launches.
#[tauri::command]
pub fn set_agent_access(app: AppHandle, enabled: bool) -> Result<AgentStatus, String> {
    let mut s = settings::read(&app)?;
    s.agent_access = enabled;
    settings::write(&app, &s)?;
    if enabled { start(&app)?; } else { stop(&app); }
    Ok(status(&app))
}

/// At launch: listen if agent access was left on; otherwise clear away the
/// socket a previous run may have left.
pub fn restore(app: &AppHandle) {
    if settings::read(app).map(|s| s.agent_access).unwrap_or(false) {
        if let Err(e) = start(app) {
            eprintln!("[agent] {e}");
        }
    } else {
        stop(app);
    }
}
