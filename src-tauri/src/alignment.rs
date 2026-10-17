//! Forced alignment: place each transcribed word on the audio it was spoken in,
//! using a wav2vec2 CTC model (ONNX) — the technique WhisperX uses.
//!
//! Whisper's word timings (even with DTW) run late in continuous speech and push
//! phrase-final words into the following pause, so cutting a word in the editor
//! left its start behind. Forced alignment knows the exact characters and finds
//! the 20 ms frames where each one is spoken, giving word boundaries to within a
//! few tens of milliseconds.

use std::path::Path;

use ort::{session::Session, value::Tensor};

use crate::transcription::Word;

// ─── Model vocabulary (wav2vec2-base-960h) ────────────────────────────────────

/// CTC blank (`<pad>`).
const BLANK: usize = 0;
/// Word separator (`|`).
const SEP: usize = 4;
const APOSTROPHE: usize = 27;

fn char_token(c: char) -> Option<usize> {
    Some(match c {
        'E' => 5,  'T' => 6,  'A' => 7,  'O' => 8,  'N' => 9,  'I' => 10, 'H' => 11,
        'S' => 12, 'R' => 13, 'D' => 14, 'L' => 15, 'U' => 16, 'M' => 17, 'W' => 18,
        'C' => 19, 'F' => 20, 'G' => 21, 'Y' => 22, 'P' => 23, 'B' => 24, 'V' => 25,
        'K' => 26, '\'' => APOSTROPHE, 'X' => 28, 'J' => 29, 'Q' => 30, 'Z' => 31,
        _ => return None,
    })
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/// Chunks are aligned independently: long enough for context, short enough to
/// keep the trellis small. A chunk closes at a pause once it passes
/// TARGET_CHUNK_MS, and unconditionally at MAX_CHUNK_MS.
const TARGET_CHUNK_MS: i64 = 15_000;
const MAX_CHUNK_MS:    i64 = 25_000;
const CHUNK_PAUSE_MS:  i64 = 150;
/// Audio margin around each chunk. DTW places some words late, so the real
/// audio of a chunk's first word can start before its timestamp.
const MARGIN_BEFORE_MS: i64 = 600;
const MARGIN_AFTER_MS:  i64 = 400;

const SAMPLES_PER_MS: usize = 16; // 16 kHz input

/// Align `words` (in place) against 16 kHz mono `audio`. Words keep their text;
/// only `start_ms` / `end_ms` change. Returns how many words were aligned —
/// chunks the model can't align keep their previous timings.
pub fn align_words(model_path: &Path, audio: &[f32], words: &mut [Word]) -> Result<usize, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let mut session = Session::builder()
        .map_err(|e| e.to_string())?
        .with_intra_threads(threads)
        .map_err(|e| e.to_string())?
        .commit_from_file(model_path)
        .map_err(|e| format!("Failed to load alignment model: {e}"))?;
    let input_name = session
        .inputs()
        .first()
        .map(|i| i.name().to_string())
        .ok_or("Alignment model has no inputs")?;

    let audio_ms = (audio.len() / SAMPLES_PER_MS) as i64;
    let mut aligned = 0;
    // Aligned audio never reaches back into the previous chunk.
    let mut floor_ms = 0i64;

    for (first, last) in chunks(words) {
        let win_start = (words[first].start_ms - MARGIN_BEFORE_MS).max(floor_ms).max(0);
        let win_end   = (words[last].end_ms + MARGIN_AFTER_MS).min(audio_ms);
        match align_chunk(&mut session, &input_name, audio, win_start, win_end, &mut words[first..=last]) {
            Ok(n)  => aligned += n,
            Err(e) => eprintln!("alignment: words {first}..={last} kept their timings ({e})"),
        }
        floor_ms = words[last].end_ms;
    }
    Ok(aligned)
}

fn chunks(words: &[Word]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut first = 0;
    for i in 0..words.len() {
        let span   = words[i].end_ms - words[first].start_ms;
        let at_end = i + 1 == words.len();
        let gap    = if at_end { i64::MAX } else { words[i + 1].start_ms - words[i].end_ms };
        if at_end || span >= MAX_CHUNK_MS || (span >= TARGET_CHUNK_MS && gap >= CHUNK_PAUSE_MS) {
            out.push((first, i));
            first = i + 1;
        }
    }
    out
}

fn align_chunk(
    session:    &mut Session,
    input_name: &str,
    audio:      &[f32],
    win_start:  i64,
    win_end:    i64,
    words:      &mut [Word],
) -> Result<usize, String> {
    // ── Target sequence: | w1 | w2 | … | wn |, remembering each word's span ──
    let mut tokens = vec![SEP];
    let mut spans: Vec<Option<(usize, usize)>> = Vec::with_capacity(words.len());
    for word in words.iter() {
        let t = word_tokens(&word.text);
        if t.is_empty() {
            spans.push(None);
            continue;
        }
        let first = tokens.len();
        tokens.extend_from_slice(&t);
        spans.push(Some((first, tokens.len() - 1)));
        tokens.push(SEP);
    }
    if spans.iter().all(Option::is_none) {
        return Ok(0);
    }

    // ── Frame-level log-probabilities for the window ─────────────────────────
    let s = (win_start.max(0) as usize * SAMPLES_PER_MS).min(audio.len());
    let e = (win_end.max(0) as usize * SAMPLES_PER_MS).min(audio.len());
    if e <= s + 400 {
        return Err("window too short".into());
    }
    let (emit, frames, vocab) = emissions(session, input_name, &audio[s..e])?;
    if frames < tokens.len() {
        return Err(format!("{frames} frames for {} tokens", tokens.len()));
    }
    let ms_per_frame = ((e - s) / SAMPLES_PER_MS) as f64 / frames as f64;
    let frame_ms = |f: usize| win_start + (f as f64 * ms_per_frame).round() as i64;

    // ── Viterbi path → word boundaries ───────────────────────────────────────
    // A word starts where its first character is entered and ends where the
    // separator after it is entered (the model's own word boundary).
    let entry = viterbi(&emit, frames, vocab, &tokens);
    let mut count = 0;
    for (word, span) in words.iter_mut().zip(&spans) {
        let Some((a, b)) = *span else { continue };
        word.start_ms = frame_ms(entry[a]);
        word.end_ms   = frame_ms(entry[b + 1]).max(word.start_ms + 1);
        count += 1;
    }
    interpolate_unaligned(words, &spans);
    Ok(count)
}

/// Run the model on one window and return log-softmax emissions, flattened as
/// `[frame][vocab]`, plus the frame and vocabulary counts.
fn emissions(session: &mut Session, input_name: &str, samples: &[f32]) -> Result<(Vec<f32>, usize, usize), String> {
    // Wav2Vec2FeatureExtractor: zero-mean, unit-variance normalisation.
    let n    = samples.len();
    let mean = samples.iter().sum::<f32>() / n as f32;
    let var  = samples.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / n as f32;
    let inv  = 1.0 / (var + 1e-7).sqrt();
    let input: Vec<f32> = samples.iter().map(|x| (x - mean) * inv).collect();

    let tensor  = Tensor::from_array((vec![1i64, n as i64], input)).map_err(|e| e.to_string())?;
    let outputs = session.run(ort::inputs![input_name => tensor]).map_err(|e| e.to_string())?;
    let (shape, logits) = outputs[0].try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
    if shape.len() != 3 {
        return Err(format!("unexpected logits shape {shape}"));
    }
    let frames = shape[1] as usize;
    let vocab  = shape[2] as usize;

    let mut out = Vec::with_capacity(frames * vocab);
    for f in 0..frames {
        let row = &logits[f * vocab..(f + 1) * vocab];
        let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        let lse = max + row.iter().map(|x| (x - max).exp()).sum::<f32>().ln();
        out.extend(row.iter().map(|x| x - lse));
    }
    Ok((out, frames, vocab))
}

/// CTC forced alignment: the most likely path through `tokens` over `frames`,
/// using the trellis from torchaudio/WhisperX (staying on a token emits blank).
/// Returns, for each token, the frame at which the path enters it.
fn viterbi(emit: &[f32], frames: usize, vocab: usize, tokens: &[usize]) -> Vec<usize> {
    let n_tok = tokens.len();
    let width = n_tok + 1;
    // trellis[t][j]: best log-prob after t frames with j tokens entered.
    let mut trellis = vec![f32::NEG_INFINITY; (frames + 1) * width];
    trellis[0] = 0.0;
    for t in 0..frames {
        let (row, next) = (t * width, (t + 1) * width);
        let blank = emit[t * vocab + BLANK];
        trellis[next] = trellis[row] + blank;
        for j in 1..=n_tok {
            let stay  = trellis[row + j] + blank;
            let enter = trellis[row + j - 1] + emit[t * vocab + tokens[j - 1]];
            trellis[next + j] = stay.max(enter);
        }
    }

    let mut entry = vec![0usize; n_tok];
    let (mut t, mut j) = (frames, n_tok);
    while j > 0 && t > 0 {
        let row   = (t - 1) * width;
        let blank = emit[(t - 1) * vocab + BLANK];
        let stay  = trellis[row + j] + blank;
        let enter = trellis[row + j - 1] + emit[(t - 1) * vocab + tokens[j - 1]];
        if enter > stay {
            entry[j - 1] = t - 1;
            j -= 1;
        }
        t -= 1;
    }
    entry
}

/// Words with nothing alignable (pure symbols) share the time between their
/// aligned neighbours evenly.
fn interpolate_unaligned(words: &mut [Word], spans: &[Option<(usize, usize)>]) {
    let n = words.len();
    let mut i = 0;
    while i < n {
        if spans[i].is_some() {
            i += 1;
            continue;
        }
        let run_start = i;
        while i < n && spans[i].is_none() {
            i += 1;
        }
        let lo    = if run_start > 0 { words[run_start - 1].end_ms } else { words[run_start].start_ms };
        let hi    = if i < n { words[i].start_ms } else { words[i - 1].end_ms };
        let count = (i - run_start) as i64;
        let step  = (hi - lo).max(count) / count;
        for (k, word) in words[run_start..i].iter_mut().enumerate() {
            word.start_ms = lo + step * k as i64;
            word.end_ms   = word.start_ms + step;
        }
    }
}

// ─── Text → model tokens ──────────────────────────────────────────────────────

/// Model tokens for a display word, with separators between the spoken words
/// it expands to ("2005" → TWO|THOUSAND|FIVE). Empty when nothing is alignable.
fn word_tokens(text: &str) -> Vec<usize> {
    let mut out = Vec::new();
    for c in spoken_form(text).chars() {
        if c == ' ' {
            if out.last().is_some_and(|&t| t != SEP) {
                out.push(SEP);
            }
        } else if let Some(t) = char_token(c) {
            out.push(t);
        }
    }
    while out.last() == Some(&SEP) {
        out.pop();
    }
    // Apostrophes alone carry no sound to align to.
    if out.iter().all(|&t| t == APOSTROPHE || t == SEP) {
        out.clear();
    }
    out
}

/// The spoken form of a display word: uppercase, words separated by spaces,
/// numbers and a few symbols spelled out so they align like any other word.
fn spoken_form(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_digit() {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_digit()
                    || (chars[i] == ',' && chars.get(i + 1).is_some_and(char::is_ascii_digit)))
            {
                i += 1;
            }
            let digits: String = chars[start..i].iter().filter(|c| c.is_ascii_digit()).collect();
            let mut spoken = number_to_words(&digits);
            // Decimal part: "3.5" → THREE POINT FIVE
            if chars.get(i) == Some(&'.') && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
                i += 1;
                spoken.push_str(" POINT");
                while let Some(d) = chars.get(i).and_then(|c| c.to_digit(10)) {
                    spoken.push(' ');
                    spoken.push_str(ONES[d as usize]);
                    i += 1;
                }
            }
            // Plural decades: "90s" → NINETIES
            if matches!(chars.get(i), Some('s' | 'S')) && !chars.get(i + 1).is_some_and(|c| c.is_alphabetic()) {
                if spoken.ends_with('Y') {
                    spoken.pop();
                    spoken.push_str("IES");
                } else {
                    spoken.push('S');
                }
                i += 1;
            }
            out.push(' ');
            out.push_str(&spoken);
            out.push(' ');
            continue;
        }
        match c {
            '%' => out.push_str(" PERCENT "),
            '&' => out.push_str(" AND "),
            '+' => out.push_str(" PLUS "),
            '@' => out.push_str(" AT "),
            '-' | '–' | '—' | '/' | '_' => out.push(' '),
            '’' | '‘' => out.push('\''),
            _ => out.extend(c.to_uppercase()),
        }
        i += 1;
    }
    out
}

const ONES: [&str; 20] = [
    "ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN",
    "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN",
];
const TENS: [&str; 10] = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];

fn below_100(n: u64) -> String {
    match n {
        0..=19                => ONES[n as usize].to_string(),
        _ if n % 10 == 0      => TENS[(n / 10) as usize].to_string(),
        _                     => format!("{} {}", TENS[(n / 10) as usize], ONES[(n % 10) as usize]),
    }
}

fn below_1000(n: u64) -> String {
    match n {
        0..=99            => below_100(n),
        _ if n % 100 == 0 => format!("{} HUNDRED", ONES[(n / 100) as usize]),
        _                 => format!("{} HUNDRED {}", ONES[(n / 100) as usize], below_100(n % 100)),
    }
}

fn number_to_words(digits: &str) -> String {
    let spell = || digits.chars().filter_map(|c| c.to_digit(10)).map(|d| ONES[d as usize]).collect::<Vec<_>>().join(" ");
    if digits.len() > 1 && digits.starts_with('0') {
        return spell(); // "007"
    }
    let Ok(n) = digits.parse::<u64>() else { return spell() };
    match n {
        // Years are read in pairs: 1990 → NINETEEN NINETY, 2026 → TWENTY TWENTY SIX
        1100..=1999 | 2010..=2099 if n % 100 != 0 => {
            let (hi, lo) = (n / 100, n % 100);
            if lo < 10 {
                format!("{} OH {}", below_100(hi), ONES[lo as usize])
            } else {
                format!("{} {}", below_100(hi), below_100(lo))
            }
        }
        0..=999 => below_1000(n),
        1_000..=999_999 => {
            let (thousands, rest) = (n / 1000, n % 1000);
            if rest == 0 {
                format!("{} THOUSAND", below_1000(thousands))
            } else {
                format!("{} THOUSAND {}", below_1000(thousands), below_1000(rest))
            }
        }
        _ => spell(),
    }
}
