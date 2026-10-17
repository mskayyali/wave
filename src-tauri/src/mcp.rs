//! `wave mcp`: the MCP server that agent apps launch (Claude Desktop, Claude
//! Code, Codex and the ChatGPT desktop app). It speaks MCP over stdio (one
//! JSON-RPC message per line) and passes every tool call to the running Wave
//! app through its socket (agent.rs), where the editor does the work
//! (src/lib/agentTools.ts). The tools are listed here, so an agent sees them
//! even while Wave is closed; calling one then explains how to fix that.
//!
//! Only what Wave needs of the protocol: the handshake, ping, tools/list and
//! tools/call. Nothing is printed to stdout but protocol messages.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::agent::SOCKET_FILE;

/// The app's identifier (tauri.conf.json): its data folder holds the socket.
const IDENTIFIER: &str = "com.mskayyali.wave";

/// The protocol revisions this server has been checked against, newest first.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "\
Wave is a text-based audio editor for podcasts: the audio is edited by editing its transcript.

Workflow: list_projects, then get_transcript for the text with word numbers. Use find_text or get_words \
to get the exact word numbers of a passage, then edit with cut_words, cut_time, correct_words, \
tighten_pauses or rename_speaker.

- Word numbers are positions in the original transcript. They never change as you edit.
- Times are in seconds.
- Every edit is non-destructive and appears live in Wave's editor, as one undoable edit labelled with \
your `label`. The user can undo it there, or you can with `undo`.
- Working on a project opens it in Wave's editor.
- You can't hear the audio. Judge from the words, their timing, confidence and pauses, and keep cuts at \
word boundaries so the speech still flows.
- Fillers (um, uh, hmm) are words in English transcripts: find_text finds them and cut_words cuts them. \
Transcription writes most of them, not every one.";

pub fn run() {
    let mut client: Option<String> = None;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let replies: Vec<Value> = batch.iter().filter_map(|m| handle(m, &mut client)).collect();
                (!replies.is_empty()).then(|| Value::Array(replies))
            }
            Ok(message) => handle(&message, &mut client),
            Err(e) => Some(error(Value::Null, -32700, &format!("Parse error: {e}"))),
        };
        if let Some(reply) = reply {
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        }
    }
}

/// The reply to one message; None for notifications.
fn handle(message: &Value, client: &mut Option<String>) -> Option<Value> {
    let id = message.get("id")?.clone(); // no id: a notification
    let method = message.get("method").and_then(Value::as_str)?; // no method: a reply to us (we send no requests)
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let info = &params["clientInfo"];
            *client = info["title"].as_str().or(info["name"].as_str()).map(str::to_owned);
            json!({
                "protocolVersion": negotiate(params["protocolVersion"].as_str()),
                "capabilities":    { "tools": { "listChanged": false } },
                "serverInfo":      { "name": "wave", "title": "Wave", "version": env!("CARGO_PKG_VERSION") },
                "instructions":    INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let (text, failed) = match call(name, arguments, client.as_deref()) {
                Ok(text)  => (text, false),
                Err(text) => (text, true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
        }
        _ => return Some(error(id, -32601, &format!("Method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Echo the client's revision when it's one we know or a newer one (Wave
/// uses only tools, which every revision so far keeps compatible); otherwise
/// offer our newest.
fn negotiate(requested: Option<&str>) -> &str {
    match requested {
        Some(v) if PROTOCOL_VERSIONS.contains(&v) => v,
        Some(v) if v.len() == 10 && v > PROTOCOL_VERSIONS[0] && v.chars().all(|c| c.is_ascii_digit() || c == '-') => v,
        _ => PROTOCOL_VERSIONS[0],
    }
}

fn socket_path() -> PathBuf {
    if let Ok(path) = std::env::var("WAVE_AGENT_SOCKET") {
        return PathBuf::from(path);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support").join(IDENTIFIER).join(SOCKET_FILE)
}

/// Pass a tool call to the running app and return its text.
fn call(tool: &str, arguments: Value, client: Option<&str>) -> Result<String, String> {
    const UNREACHABLE: &str = "Wave isn't running, or AI agent access is off. Open Wave, turn on \
        Settings → AI agents, and try again.";
    let mut stream = UnixStream::connect(socket_path()).map_err(|_| UNREACHABLE.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(58))).map_err(|e| e.to_string())?;
    let request = json!({ "tool": tool, "arguments": arguments, "client": client });
    writeln!(stream, "{request}").map_err(|_| UNREACHABLE.to_string())?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).map_err(|e| format!("Wave didn't answer: {e}"))?;
    let answer: Value = serde_json::from_str(&line).map_err(|_| "Wave closed the connection.".to_string())?;
    let text = answer["text"].as_str().unwrap_or("").to_string();
    if answer["ok"].as_bool() == Some(true) { Ok(text) } else { Err(text) }
}

// ─── Tools ────────────────────────────────────────────────────────────────────

/// Read-only tools, and editing tools (non-destructive: every edit can be undone).
fn annotations(title: &str, read_only: bool) -> Value {
    json!({ "title": title, "readOnlyHint": read_only, "destructiveHint": false, "openWorldHint": false })
}

fn tool(name: &str, title: &str, read_only: bool, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name":        name,
        "title":       title,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required },
        "annotations": annotations(title, read_only),
    })
}

fn project() -> Value {
    json!({ "type": "string", "description": "The project's id, or its exact name." })
}

fn label() -> Value {
    json!({ "type": "string", "description": "A short summary of why, shown in Wave's Edits list (e.g. \"Removed false starts\")." })
}

fn word_ranges() -> Value {
    json!({
        "type": "array",
        "description": "Ranges of word numbers, both ends included.",
        "items": {
            "type": "object",
            "properties": {
                "from": { "type": "integer", "minimum": 0 },
                "to":   { "type": "integer", "minimum": 0 }
            },
            "required": ["from", "to"]
        }
    })
}

fn tools() -> Vec<Value> {
    vec![
        tool("list_projects", "List projects", true,
            "List the projects in Wave: id, name, status and length.",
            json!({}), &[]),
        tool("get_project", "Project details", true,
            "A project's status and editing state: length before and after edits, edits, speakers, \
             long and added pauses, speech enhancement (what's applied, whether it's on, which models are \
             downloaded) and running jobs.",
            json!({ "project": project() }), &["project"]),
        tool("get_transcript", "Read the transcript", true,
            "The transcript as it stands, one paragraph per line, each starting with the number of its first word \
             and its time. Cut words show as ~~word~~, corrected ones as their new text, words transcription \
             wasn't sure of as word(?). Page through a long transcript with from and to.",
            json!({
                "project": project(),
                "from": { "type": "integer", "minimum": 0, "description": "First word number (default: the start)." },
                "to":   { "type": "integer", "minimum": 0, "description": "Last word number (default: the end)." }
            }), &["project"]),
        tool("get_words", "Word details", true,
            "Every word in a range with its number, start and end time, confidence and state. Use it to get \
             exact word numbers before editing. At most 400 words per call.",
            json!({
                "project": project(),
                "from": { "type": "integer", "minimum": 0 },
                "to":   { "type": "integer", "minimum": 0 }
            }), &["project", "from", "to"]),
        tool("find_text", "Find text", true,
            "Find a phrase in the transcript (ignoring case and punctuation). Returns the word numbers and times \
             of each match.",
            json!({ "project": project(), "text": { "type": "string" } }), &["project", "text"]),
        tool("list_pauses", "List pauses", true,
            "Pauses between the words that are kept, at least min_seconds long, each marked as between sentences \
             (or speakers) or within a sentence, and the pauses already added.",
            json!({
                "project": project(),
                "min_seconds": { "type": "number", "minimum": 0.1, "description": "Default 1.0." }
            }), &["project"]),
        tool("cut_words", "Cut words", false,
            "Cut words, and their audio, from the edit. Cuts are padded into the surrounding pauses and eased to \
             quiet points, so whole words come out cleanly.",
            json!({ "project": project(), "ranges": word_ranges(), "label": label() }), &["project", "ranges"]),
        tool("restore_words", "Restore words", false,
            "Bring cut words back.",
            json!({ "project": project(), "ranges": word_ranges() }), &["project", "ranges"]),
        tool("cut_time", "Cut a stretch of audio", false,
            "Cut exact stretches of audio by time, for things that aren't words: a breath, a cough, a noise, \
             music. Words they overlap are trimmed, not removed whole.",
            json!({
                "project": project(),
                "ranges": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "start": { "type": "number", "minimum": 0, "description": "Seconds." },
                            "end":   { "type": "number", "minimum": 0, "description": "Seconds." }
                        },
                        "required": ["start", "end"]
                    }
                },
                "label": label()
            }), &["project", "ranges"]),
        tool("correct_words", "Correct words", false,
            "Fix words transcription got wrong (names, terms, mishearings). Changes the text only, not the audio; \
             corrected words are marked in Wave.",
            json!({
                "project": project(),
                "corrections": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "word": { "type": "integer", "minimum": 0, "description": "The word number." },
                            "text": { "type": "string", "description": "What it should say." }
                        },
                        "required": ["word", "text"]
                    }
                },
                "label": label()
            }), &["project", "corrections"]),
        tool("shorten_pauses", "Shorten pauses", false,
            "Shorten every pause longer than longer_than seconds to keep seconds, cutting from its middle.",
            json!({
                "project": project(),
                "longer_than": { "type": "number", "minimum": 0.2, "description": "Default 1.0." },
                "keep":        { "type": "number", "minimum": 0.05, "description": "Default 0.5." }
            }), &["project"]),
        tool("tighten_pauses", "Tighten pauses", false,
            "Shorten long pauses to a natural rhythm read from the transcript, as Wave's Pauses tool does: pauses \
             between sentences (or speakers) are kept longer than pauses within a sentence. tight: up to 0.5 s \
             between sentences and 0.3 s within one; natural: 0.75 and 0.45; relaxed: 1.0 and 0.6. One edit.",
            json!({
                "project": project(),
                "rhythm": { "type": "string", "enum": ["tight", "natural", "relaxed"], "description": "Default natural." }
            }), &["project"]),
        tool("add_pauses", "Add pauses", false,
            "Add pauses after words, filled with the room's own quiet (room tone from nearby), e.g. to let a point \
             land or to separate topics. Each goes in the gap after the word. One edit.",
            json!({
                "project": project(),
                "pauses": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "after_word": { "type": "integer", "minimum": 0, "description": "The word number it follows." },
                            "seconds":    { "type": "number", "minimum": 0.1, "maximum": 5, "description": "Default 0.5." }
                        },
                        "required": ["after_word"]
                    }
                },
                "label": label()
            }), &["project", "pauses"]),
        tool("enhance_audio", "Enhance the audio", false,
            "Make the enhanced audio: a clean-up (noise removal), then an EQ preset, then a loudness target. Fields \
             left out keep what's applied (or Wave's defaults: DPDFNet, full, no EQ, podcast). Runs in the background \
             and returns at once; get_project shows progress and what was applied. Afterwards playback and export use \
             the enhanced audio. Clean-up (noise_removal): dpdfnet (DPDFNet by Ceva: removes background noise and \
             room echo, keeping the voice as recorded; about 6–10 minutes per hour of audio) or none. \
             EQ presets, each for one problem: clearer (muddy; a good place to start), warmer (thin: laptop, headset \
             or lapel mic), less-boom (bassy from talking close to the mic), less-boxy (small room), less-nasal \
             (honky), brighter (dull or muffled, also after a heavy clean-up), less-harsh (piercing, sharp S \
             sounds), broadcast (a full radio voice; not for a boomy one). EQ can't fix echo, a distant mic or \
             clipping. Loudness: podcast −19 LUFS, streaming −14, broadcast −23.",
            json!({
                "project": project(),
                "noise_removal": { "type": "string", "enum": ["none", "dpdfnet"] },
                "strength":      { "type": "string", "enum": ["subtle", "medium", "full"], "description": "How much of the clean-up to keep." },
                "eq":            { "type": "string", "enum": ["off", "clearer", "warmer", "less-boom", "less-boxy", "less-nasal", "brighter", "less-harsh", "broadcast"] },
                "eq_amount":     { "type": "string", "enum": ["subtle", "medium", "strong"] },
                "loudness":      { "type": "string", "enum": ["podcast", "streaming", "broadcast", "off"] }
            }), &["project"]),
        tool("use_enhanced_audio", "Switch the enhanced audio", false,
            "Use the enhanced audio for playback and export (on), or the original (off). Needs enhance_audio first.",
            json!({ "project": project(), "on": { "type": "boolean" } }), &["project", "on"]),
        tool("rename_speaker", "Rename a speaker", false,
            "Give a detected speaker a name (shown in the transcript and exports).",
            json!({
                "project": project(),
                "speaker": { "type": "string", "description": "The speaker's current name, e.g. \"Speaker 2\"." },
                "name":    { "type": "string" }
            }), &["project", "speaker", "name"]),
        tool("list_edits", "List edits", true,
            "The edits made so far, newest first, with who made them.",
            json!({ "project": project() }), &["project"]),
        tool("undo", "Undo an edit", false,
            "Undo an edit: the one with edit_id (from list_edits), or else the last edit an AI agent made.",
            json!({ "project": project(), "edit_id": { "type": "string" } }), &["project"]),
        tool("analyze", "Detect speakers", false,
            "Start speaker detection on the project (about a minute per hour of audio). Returns at once; check \
             get_project for progress.",
            json!({
                "project": project(),
                "kind": { "type": "string", "enum": ["speakers"], "description": "Default speakers." }
            }), &["project"]),
        tool("export_text", "Export the transcript", true,
            "The edited transcript as plain text, SRT or WebVTT subtitles, or JSON with word timings. Returns the \
             content.",
            json!({
                "project": project(),
                "format": { "type": "string", "enum": ["txt", "srt", "vtt", "json"] }
            }), &["project", "format"]),
        tool("export_audio", "Export the audio", false,
            "Export the edited audio to the Downloads folder, as MP3 at 128 kbps unless another format is asked \
             for. Returns its path. Formats, each with presets: mp3 (plays everywhere; mp3-64-mono for voice alone, \
             mp3-128 the podcast standard, mp3-192 for shows with music, mp3-320), aac (.m4a, better than MP3 at the \
             same size; aac-64-mono, aac-128, aac-256), wav (uncompressed, for editing elsewhere; wav-16, wav-24) and \
             flac (lossless, about half the size of WAV; flac-16, flac-24). A format alone uses its standard preset.",
            json!({
                "project": project(),
                "format": { "type": "string", "enum": [
                    "mp3", "aac", "wav", "flac",
                    "mp3-64-mono", "mp3-128", "mp3-192", "mp3-320", "aac-64-mono", "aac-128", "aac-256",
                    "wav-16", "wav-24", "flac-16", "flac-24"
                ] },
                "enhanced": { "type": "boolean", "description": "Use the enhanced audio (clean-up, EQ, loudness), if there is one (default: as set in Wave)." }
            }), &["project"]),
        tool("import_audio", "Import audio", false,
            "Create a project from an audio file (MP3, WAV, M4A, FLAC…). Wave imports and transcribes it; check \
             get_project until it's ready.",
            json!({
                "path": { "type": "string", "description": "Absolute path of the audio file." },
                "name": { "type": "string", "description": "Project name (default: the file name)." }
            }), &["path"]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(message: Value) -> Value {
        handle(&message, &mut None).expect("a reply")
    }

    #[test]
    fn handshake_negotiates_the_version() {
        let reply = ask(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test" } } }));
        assert_eq!(reply["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(reply["result"]["serverInfo"]["name"], "wave");
        assert_eq!(negotiate(Some("1999-01-01")), PROTOCOL_VERSIONS[0]);
        assert_eq!(negotiate(Some("2099-12-31")), "2099-12-31");
        assert_eq!(negotiate(None), PROTOCOL_VERSIONS[0]);
    }

    #[test]
    fn notifications_get_no_reply() {
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &mut None).is_none());
    }

    #[test]
    fn tools_are_well_formed() {
        let list = ask(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
        let tools = list["result"]["tools"].as_array().unwrap();
        assert!(tools.len() >= 15);
        let mut names = std::collections::HashSet::new();
        for t in tools {
            let name = t["name"].as_str().unwrap();
            assert!(names.insert(name), "duplicate tool {name}");
            assert_eq!(t["inputSchema"]["type"], "object");
            for r in t["inputSchema"]["required"].as_array().unwrap() {
                assert!(t["inputSchema"]["properties"].get(r.as_str().unwrap()).is_some(), "{name}: {r} isn't a property");
            }
        }
    }

    #[test]
    fn unknown_methods_are_errors() {
        let reply = ask(json!({ "jsonrpc": "2.0", "id": 3, "method": "resources/list" }));
        assert_eq!(reply["error"]["code"], -32601);
    }
}
