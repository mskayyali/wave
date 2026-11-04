//! Parakeet TDT v3 through the pinned, bundled NeMo-Speech.cpp Metal runtime.
//! A single recognizer processes pause-bounded chunks, keeping memory bounded
//! on long recordings. Returned times are always mapped back to source audio.
use std::{collections::HashMap, fs, path::{Path, PathBuf}, process::{Command, Stdio}, time::Duration};
use serde::Deserialize;
use crate::transcription::{speech_chunks, Word};

pub const MODEL_ID: &str = "parakeet-tdt-0.6b-v3";
const SAMPLE_RATE: usize = 16_000;
static RUN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn runtime_path() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(Path::parent) {
            let bundled = contents.join("Resources/nemo-speech/bin/nemo-speech");
            if bundled.is_file() { return Ok(bundled); }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/nemo-speech/runtime/bin/nemo-speech");
    if dev.is_file() { return Ok(dev); }
    Err("Parakeet's local runtime is missing. Reinstall Wave (developers: run bun run setup:parakeet).".into())
}

#[derive(Deserialize)]
struct NativeTranscript {
    text: String,
    #[serde(default)]
    words: Vec<NativeWord>,
    #[serde(default)]
    languages: Vec<String>,
}

#[derive(Deserialize)]
struct NativeWord { word: String, start: f64, end: f64, confidence: f32 }

fn letters(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn parse_chunk(json: &str, offset_ms: i64, duration_ms: i64) -> Result<(Vec<Word>, String), String> {
    let native: NativeTranscript = serde_json::from_str(json)
        .map_err(|e| format!("Parakeet returned invalid transcription data: {e}"))?;
    let timed_text = native.words.iter().map(|w| w.word.as_str()).collect::<String>();
    if letters(&native.text) != letters(&timed_text) {
        return Err("Parakeet could not time every word. Try Whisper for this recording.".into());
    }
    let mut words: Vec<Word> = Vec::new();
    for word in native.words {
        let text = word.word.trim();
        if text.is_empty() { continue; }
        // Some decoders emit punctuation separately; it belongs to the preceding word.
        if !text.chars().any(char::is_alphanumeric) {
            if let Some(previous) = words.last_mut() { previous.text.push_str(text); }
            continue;
        }
        if !word.start.is_finite() || !word.end.is_finite() || word.start < 0.0
            || word.end < word.start || word.end * 1000.0 > duration_ms as f64 + 100.0
            || !word.confidence.is_finite() {
            return Err("Parakeet returned invalid word timings. Try Whisper for this recording.".into());
        }
        let start = (word.start * 1000.0).round() as i64;
        let end = ((word.end * 1000.0).round() as i64).min(duration_ms);
        if end <= start { return Err("Parakeet returned a word without usable timing. Try Whisper for this recording.".into()); }
        words.push(Word { text: text.into(), start_ms: offset_ms + start, end_ms: offset_ms + end,
            confidence: word.confidence.clamp(0.0, 1.0) });
    }
    let language = native.languages.first().map(|s| s.split(['-', '_']).next().unwrap_or("und").to_lowercase())
        .unwrap_or_else(|| "und".into());
    Ok((words, language))
}

struct WorkDir(PathBuf);
impl Drop for WorkDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
struct Child(std::process::Child);
impl Drop for Child { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

pub fn transcribe(model: &Path, audio: &[f32], mut progress: impl FnMut(i32)) -> Result<(Vec<Word>, String), String> {
    let _exclusive = RUN_LOCK.lock().map_err(|_| "Parakeet worker needs a restart")?;
    let pieces = speech_chunks(audio);
    if pieces.is_empty() { progress(100); return Ok((Vec::new(), "und".into())); }
    let work = WorkDir(std::env::temp_dir().join(format!("wave-parakeet-{}", uuid::Uuid::new_v4())));
    let inputs = work.0.join("audio");
    let results = work.0.join("results");
    fs::create_dir_all(&inputs).map_err(|e| e.to_string())?;
    fs::create_dir_all(&results).map_err(|e| e.to_string())?;
    for (index, piece) in pieces.iter().enumerate() {
        let mut wav = hound::WavWriter::create(inputs.join(format!("{index:06}.wav")), hound::WavSpec {
            channels: 1, sample_rate: SAMPLE_RATE as u32, bits_per_sample: 32, sample_format: hound::SampleFormat::Float,
        }).map_err(|e| e.to_string())?;
        for sample in &audio[piece.clone()] { wav.write_sample(*sample).map_err(|e| e.to_string())?; }
        wav.finalize().map_err(|e| e.to_string())?;
    }
    let log_path = work.0.join("runtime.log");
    let log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut child = Child(Command::new(runtime_path()?)
        .arg("transcribe").arg(&inputs).arg("--model").arg(model)
        .args(["--device", "metal", "--format", "json", "--word-times", "--verbatim", "--concurrency", "1", "--no-warmup"])
        .arg("--output-dir").arg(&results)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::from(log))
        .spawn().map_err(|e| format!("Cannot start Parakeet: {e}"))?);
    let started = std::time::Instant::now();
    let mut done = 0;
    loop {
        let complete = fs::read_dir(&results).map_err(|e| e.to_string())?
            .filter_map(Result::ok).filter(|e| e.path().extension().is_some_and(|x| x == "json")).count();
        if complete != done { done = complete; progress((done * 95 / pieces.len()) as i32); }
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                let details = fs::read_to_string(&log_path).unwrap_or_default();
                eprintln!("Parakeet runtime: {}", details.chars().rev().take(4000).collect::<String>().chars().rev().collect::<String>());
                return Err("Parakeet could not transcribe this recording. Try Whisper, or restart Wave and try again.".into());
            }
            break;
        }
        if started.elapsed() > Duration::from_secs(2 * 3600) { return Err("Parakeet took too long. Try Whisper for this recording.".into()); }
        std::thread::sleep(Duration::from_millis(200));
    }
    let mut words = Vec::new();
    let mut languages: HashMap<String, usize> = HashMap::new();
    for (index, piece) in pieces.iter().enumerate() {
        let json = fs::read_to_string(results.join(format!("{index:06}.json")))
            .map_err(|e| format!("Parakeet did not finish a section: {e}"))?;
        let (part, language) = parse_chunk(&json, (piece.start * 1000 / SAMPLE_RATE) as i64,
            (piece.len() * 1000 / SAMPLE_RATE) as i64)?;
        if !part.is_empty() { *languages.entry(language).or_default() += piece.len(); }
        words.extend(part);
    }
    let language = languages.into_iter().max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
        .map(|(language, _)| language).unwrap_or_else(|| "und".into());
    progress(100);
    Ok((words, language))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_offsets_punctuation_and_language() {
        let (words, language) = parse_chunk(r#"{"text":"Um, hello!","languages":["en-US"],"words":[
            {"word":"Um","start":0.12,"end":0.24,"confidence":0.7},
            {"word":",","start":0.24,"end":0.24,"confidence":1},
            {"word":"hello!","start":0.4,"end":0.9,"confidence":0.9}]}"#, 12000, 1000).unwrap();
        assert_eq!(language, "en"); assert_eq!(words[0].text, "Um,");
        assert_eq!(words[0].start_ms, 12120); assert_eq!(words[1].end_ms, 12900);
    }
    #[test]
    fn refuses_missing_or_invalid_timings() {
        assert!(parse_chunk(r#"{"text":"missing","words":[]}"#, 0, 1000).is_err());
        for (start, end) in [(-0.1, 0.5), (0.6, 0.5), (0.5, 3.0), (0.5, 0.5)] {
            let json = format!(r#"{{"text":"hi","words":[{{"word":"hi","start":{start},"end":{end},"confidence":1}}]}}"#);
            assert!(parse_chunk(&json, 0, 1000).is_err());
        }
        assert!(parse_chunk(r#"{"text":"","words":[]}"#, 0, 1000).unwrap().0.is_empty());
    }
    #[test]
    #[ignore = "downloads required: PARAKEET_MODEL and WAV environment variables"]
    fn transcribe_file() {
        let audio = crate::transcription::read_wav_f32(Path::new(&std::env::var("WAV").unwrap())).unwrap();
        let (words, language) = transcribe(Path::new(&std::env::var("PARAKEET_MODEL").unwrap()), &audio, |p| eprintln!("{p}%")).unwrap();
        assert!(!words.is_empty());
        for word in &words { assert!(word.start_ms >= 0 && word.end_ms > word.start_ms && word.end_ms <= (audio.len() * 1000 / SAMPLE_RATE) as i64); }
        fs::write(std::env::var("OUT").unwrap(), serde_json::to_string_pretty(&serde_json::json!({"words":words,"language":language})).unwrap()).unwrap();
    }
}
