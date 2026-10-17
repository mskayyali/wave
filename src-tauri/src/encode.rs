//! The exported audio, written in the chosen format: WAV with hound; AAC (in
//! an .m4a) and FLAC with macOS's own encoders, through AudioToolbox's
//! ExtAudioFile (as `afconvert` does); MP3 with LAME (lame.rs), which macOS
//! can't write. The file is written beside the
//! destination under a hidden `.part` name and moved into place when it's
//! complete, so a failed export never leaves half a file or replaces a good one.
//!
//! The lossy formats take one or two channels: a mono preset mixes everything
//! to one, and more than two channels fold down to two (even channels left,
//! odd right). WAV and FLAC keep what the audio has.

use serde::Deserialize;
use std::borrow::Cow;
use std::path::{Path, PathBuf};

/// How to write the file. The frontend's presets (src/lib/audioFormats.ts)
/// fill these in; `checked` refuses anything else.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "format")]
pub enum ExportFormat {
    /// PCM, 16- or 24-bit.
    Wav { bits: u16 },
    /// Lossless, 16- or 24-bit.
    Flac { bits: u16 },
    /// Constant bit rate.
    Mp3 { kbps: u32, mono: bool },
    /// AAC-LC at about `kbps`, in an .m4a.
    Aac { kbps: u32, mono: bool },
}

impl Default for ExportFormat {
    fn default() -> Self { ExportFormat::Wav { bits: 16 } }
}

impl ExportFormat {
    pub fn checked(&self) -> Result<(), String> {
        match *self {
            ExportFormat::Wav { bits } | ExportFormat::Flac { bits } if bits != 16 && bits != 24 =>
                Err(format!("{bits}-bit isn't offered: choose 16 or 24")),
            ExportFormat::Mp3 { kbps, .. } if !crate::lame::BIT_RATES.contains(&kbps) =>
                Err(format!("{kbps} kbps isn't an MP3 bit rate")),
            ExportFormat::Aac { kbps, .. } if !(32..=320).contains(&kbps) =>
                Err(format!("{kbps} kbps isn't offered for AAC: choose 32–320")),
            _ => Ok(()),
        }
    }

    /// "WAV", "AAC", … for messages and progress.
    pub fn name(&self) -> &'static str {
        match self {
            ExportFormat::Wav { .. } => "WAV",
            ExportFormat::Flac { .. } => "FLAC",
            ExportFormat::Mp3 { .. } => "MP3",
            ExportFormat::Aac { .. } => "AAC",
        }
    }
}

/// Write `samples` (interleaved, `channels` per frame, `rate` Hz) to `dst`.
/// `progress` is told how far along it is, 0–1.
pub fn write(samples: &[f32], channels: usize, rate: u32, format: &ExportFormat, dst: &Path,
             progress: &mut dyn FnMut(f32)) -> Result<(), String> {
    format.checked()?;
    let channels = channels.max(1);
    let part = part_path(dst);
    let result = match *format {
        ExportFormat::Wav { bits } => write_wav(samples, channels, rate, bits, &part, progress),
        ExportFormat::Flac { bits } => core_audio::write(samples, channels, rate, core_audio::Codec::Flac { bits }, &part, progress),
        ExportFormat::Mp3 { kbps, mono } => {
            let to = if mono { 1 } else { channels.min(2) };
            let audio = fold(samples, channels, to);
            crate::lame::write(&audio, to, rate, lossy_rate(rate), kbps, &part, progress)
        }
        ExportFormat::Aac { kbps, mono } => {
            let to = if mono { 1 } else { channels.min(2) };
            let audio = fold(samples, channels, to);
            core_audio::write(&audio, to, rate, core_audio::Codec::Aac { bits_per_sec: kbps * 1000 }, &part, progress)
        }
    };
    match result {
        Ok(()) => std::fs::rename(&part, dst).map_err(|e| format!("Couldn't save the file: {e}")),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// The sample rates MP3 and AAC take.
const LOSSY_RATES: [u32; 9] = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000];

/// The rate an MP3 or AAC file gets: the audio's if the format takes it, else
/// the nearest it does (the encoder converts on the way).
fn lossy_rate(rate: u32) -> u32 {
    if LOSSY_RATES.contains(&rate) { return rate; }
    if rate > 48_000 { return if rate % 44_100 == 0 { 44_100 } else { 48_000 }; }
    *LOSSY_RATES.iter().find(|&&r| r > rate).unwrap_or(&48_000)
}

/// `.Episode 12.mp3.part` beside `Episode 12.mp3`.
fn part_path(dst: &Path) -> PathBuf {
    let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "export".into());
    dst.with_file_name(format!(".{name}.part"))
}

/// The audio with `to` channels: all of them averaged for one, even channels
/// left and odd right for two.
fn fold(samples: &[f32], channels: usize, to: usize) -> Cow<'_, [f32]> {
    if to == channels { return Cow::Borrowed(samples); }
    let frames = samples.chunks_exact(channels);
    Cow::Owned(if to == 1 {
        frames.map(|f| f.iter().sum::<f32>() / channels as f32).collect()
    } else {
        let (left, right) = ((channels + 1) / 2, channels / 2);
        frames.flat_map(|f| {
            let l = f.iter().step_by(2).sum::<f32>() / left as f32;
            let r = f.iter().skip(1).step_by(2).sum::<f32>() / right as f32;
            [l, r]
        }).collect()
    })
}

/// Frames written between progress reports: a second at 48 kHz.
const CHUNK_FRAMES: usize = 48_000;

fn write_wav(samples: &[f32], channels: usize, rate: u32, bits: u16, dst: &Path,
             progress: &mut dyn FnMut(f32)) -> Result<(), String> {
    let spec = hound::WavSpec { channels: channels as u16, sample_rate: rate, bits_per_sample: bits, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(dst, spec).map_err(|e| format!("Couldn't create the file: {e}"))?;
    let scale = if bits == 24 { 8_388_607.0 } else { 32_767.0 };
    let total = samples.len().max(1);
    for (i, chunk) in samples.chunks(CHUNK_FRAMES * channels).enumerate() {
        for &s in chunk {
            let v = (s.clamp(-1.0, 1.0) * scale).round() as i32;
            if bits == 24 { w.write_sample(v) } else { w.write_sample(v as i16) }.map_err(|e| format!("Couldn't write the audio: {e}"))?;
        }
        progress(((i + 1) * CHUNK_FRAMES * channels).min(total) as f32 / total as f32);
    }
    w.finalize().map_err(|e| format!("Couldn't finish the file: {e}"))
}

/// AudioToolbox's ExtAudioFile: give it float PCM, it converts and encodes.
mod core_audio {
    use std::ffi::c_void;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    pub enum Codec {
        /// AAC-LC in an .m4a, at the bit rate nearest this that the encoder offers.
        Aac { bits_per_sec: u32 },
        /// FLAC from 16- or 24-bit samples.
        Flac { bits: u16 },
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    #[allow(non_snake_case)]
    struct AudioStreamBasicDescription {
        mSampleRate: f64,
        mFormatID: u32,
        mFormatFlags: u32,
        mBytesPerPacket: u32,
        mFramesPerPacket: u32,
        mBytesPerFrame: u32,
        mChannelsPerFrame: u32,
        mBitsPerChannel: u32,
        mReserved: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct AudioBuffer { mNumberChannels: u32, mDataByteSize: u32, mData: *mut c_void }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct AudioBufferList { mNumberBuffers: u32, mBuffers: [AudioBuffer; 1] }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    #[allow(non_snake_case)]
    struct AudioValueRange { mMinimum: f64, mMaximum: f64 }

    type OSStatus = i32;
    type ExtAudioFileRef = *mut c_void;
    type AudioConverterRef = *mut c_void;

    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        fn ExtAudioFileCreateWithURL(url: *const c_void, file_type: u32, format: *const AudioStreamBasicDescription,
                                     layout: *const c_void, flags: u32, out: *mut ExtAudioFileRef) -> OSStatus;
        fn ExtAudioFileSetProperty(file: ExtAudioFileRef, id: u32, size: u32, data: *const c_void) -> OSStatus;
        fn ExtAudioFileGetProperty(file: ExtAudioFileRef, id: u32, size: *mut u32, data: *mut c_void) -> OSStatus;
        fn ExtAudioFileWrite(file: ExtAudioFileRef, frames: u32, data: *const AudioBufferList) -> OSStatus;
        fn ExtAudioFileDispose(file: ExtAudioFileRef) -> OSStatus;
        fn AudioConverterGetPropertyInfo(conv: AudioConverterRef, id: u32, size: *mut u32, writable: *mut u8) -> OSStatus;
        fn AudioConverterGetProperty(conv: AudioConverterRef, id: u32, size: *mut u32, data: *mut c_void) -> OSStatus;
        fn AudioConverterSetProperty(conv: AudioConverterRef, id: u32, size: u32, data: *const c_void) -> OSStatus;
        fn AudioFormatGetProperty(id: u32, spec_size: u32, spec: *const c_void, size: *mut u32, data: *mut c_void) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(alloc: *const c_void, path: *const u8, len: isize, is_dir: u8) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    const fn code(c: &[u8; 4]) -> u32 { u32::from_be_bytes(*c) }

    const FILE_M4A: u32 = code(b"m4af");
    const FILE_FLAC: u32 = code(b"flac");
    const FORMAT_LPCM: u32 = code(b"lpcm");
    const FORMAT_AAC: u32 = code(b"aac ");
    const FORMAT_FLAC: u32 = code(b"flac");
    const FLAG_FLOAT_PACKED: u32 = 1 | 8;
    /// FLAC's source bit depth, as for Apple Lossless.
    const FLAC_FROM_16_BIT: u32 = 1;
    const FLAC_FROM_24_BIT: u32 = 3;
    const ERASE_FILE: u32 = 1;
    const PROP_CLIENT_FORMAT: u32 = code(b"cfmt");
    const PROP_CONVERTER: u32 = code(b"acnv");
    const PROP_CONVERTER_CONFIG: u32 = code(b"accf");
    const PROP_FORMAT_INFO: u32 = code(b"fmti");
    const CONV_BIT_RATE: u32 = code(b"brat");
    const CONV_BIT_RATES: u32 = code(b"aebr");
    const CONV_QUALITY: u32 = code(b"cdqu");
    const QUALITY_MAX: u32 = 0x7F;

    /// "OSStatus 'fmt?'" or "OSStatus -50".
    fn status(what: &str, s: OSStatus) -> Result<(), String> {
        if s == 0 { return Ok(()); }
        let b = s.to_be_bytes();
        let shown = if b.iter().all(|c| c.is_ascii_graphic() || *c == b' ') {
            format!("'{}'", String::from_utf8_lossy(&b))
        } else {
            s.to_string()
        };
        Err(format!("{what} failed (OSStatus {shown})"))
    }

    /// Closes the file however `write` ends.
    struct File(ExtAudioFileRef);
    impl Drop for File {
        fn drop(&mut self) {
            if !self.0.is_null() { unsafe { ExtAudioFileDispose(self.0); } }
        }
    }

    pub fn write(samples: &[f32], channels: usize, rate: u32, codec: Codec, dst: &Path,
                 progress: &mut dyn FnMut(f32)) -> Result<(), String> {
        let ch = channels as u32;
        let (file_type, mut format) = match codec {
            Codec::Aac { .. } => (FILE_M4A, AudioStreamBasicDescription {
                mSampleRate: super::lossy_rate(rate) as f64, mFormatID: FORMAT_AAC, mChannelsPerFrame: ch, ..Default::default()
            }),
            Codec::Flac { bits } => (FILE_FLAC, AudioStreamBasicDescription {
                mSampleRate: rate as f64, mFormatID: FORMAT_FLAC, mChannelsPerFrame: ch,
                mFormatFlags: if bits == 24 { FLAC_FROM_24_BIT } else { FLAC_FROM_16_BIT }, ..Default::default()
            }),
        };
        let client = AudioStreamBasicDescription {
            mSampleRate: rate as f64, mFormatID: FORMAT_LPCM, mFormatFlags: FLAG_FLOAT_PACKED,
            mBytesPerPacket: 4 * ch, mFramesPerPacket: 1, mBytesPerFrame: 4 * ch, mChannelsPerFrame: ch,
            mBitsPerChannel: 32, mReserved: 0,
        };

        unsafe {
            // Let the codec fill in the rest of its description.
            let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
            status("Describing the format", AudioFormatGetProperty(PROP_FORMAT_INFO, 0, null(), &mut size,
                &mut format as *mut _ as *mut c_void))?;

            let path = dst.as_os_str().as_encoded_bytes();
            let url = CFURLCreateFromFileSystemRepresentation(null(), path.as_ptr(), path.len() as isize, 0);
            if url.is_null() { return Err("Couldn't use that file location".into()); }
            let mut raw: ExtAudioFileRef = null_mut();
            let created = ExtAudioFileCreateWithURL(url, file_type, &format, null(), ERASE_FILE, &mut raw);
            CFRelease(url);
            status("Creating the file", created)?;
            let file = File(raw);

            status("Setting the input format", ExtAudioFileSetProperty(file.0, PROP_CLIENT_FORMAT,
                std::mem::size_of::<AudioStreamBasicDescription>() as u32, &client as *const _ as *const c_void))?;

            if let Codec::Aac { bits_per_sec } = codec {
                let mut conv: AudioConverterRef = null_mut();
                let mut size = std::mem::size_of::<AudioConverterRef>() as u32;
                status("Finding the encoder", ExtAudioFileGetProperty(file.0, PROP_CONVERTER, &mut size,
                    &mut conv as *mut _ as *mut c_void))?;
                let rate = nearest_bit_rate(conv, bits_per_sec)?;
                status("Setting the bit rate", AudioConverterSetProperty(conv, CONV_BIT_RATE, 4, &rate as *const u32 as *const c_void))?;
                status("Setting the quality", AudioConverterSetProperty(conv, CONV_QUALITY, 4, &QUALITY_MAX as *const u32 as *const c_void))?;
                // Tells ExtAudioFile to pick up the encoder's new settings.
                let none: *const c_void = null();
                status("Applying the settings", ExtAudioFileSetProperty(file.0, PROP_CONVERTER_CONFIG,
                    std::mem::size_of::<*const c_void>() as u32, &none as *const _ as *const c_void))?;
            }

            let total = (samples.len() / channels).max(1);
            let mut done = 0usize;
            for chunk in samples.chunks(super::CHUNK_FRAMES * channels) {
                let frames = chunk.len() / channels;
                let list = AudioBufferList { mNumberBuffers: 1, mBuffers: [AudioBuffer {
                    mNumberChannels: ch, mDataByteSize: (chunk.len() * 4) as u32, mData: chunk.as_ptr() as *mut c_void,
                }] };
                status("Writing the audio", ExtAudioFileWrite(file.0, frames as u32, &list))?;
                done += frames;
                progress(done as f32 / total as f32);
            }

            // Closing writes what's buffered and the file's tables.
            let raw = file.0;
            std::mem::forget(file);
            status("Finishing the file", ExtAudioFileDispose(raw))
        }
    }

    /// The bit rate the encoder offers nearest `want` (it depends on the rate
    /// and channels).
    unsafe fn nearest_bit_rate(conv: AudioConverterRef, want: u32) -> Result<u32, String> {
        let mut size = 0u32;
        status("Reading the bit rates", AudioConverterGetPropertyInfo(conv, CONV_BIT_RATES, &mut size, null_mut()))?;
        let mut ranges = vec![AudioValueRange::default(); size as usize / std::mem::size_of::<AudioValueRange>()];
        status("Reading the bit rates", AudioConverterGetProperty(conv, CONV_BIT_RATES, &mut size, ranges.as_mut_ptr() as *mut c_void))?;
        let want = want as f64;
        ranges.iter()
            .map(|r| want.clamp(r.mMinimum, r.mMaximum))
            .min_by(|a, b| (a - want).abs().total_cmp(&(b - want).abs()))
            .map(|r| r as u32)
            .ok_or_else(|| "The AAC encoder offers no bit rate for this audio".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-encode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    /// A voice-like buzz (harmonics of 140 Hz) on the left, a different one on
    /// the right, and a little noise, all exactly 16-bit (n / 32768, as
    /// decoders and Core Audio scale it).
    fn signal(rate: u32, channels: usize, secs: f32) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut out = Vec::with_capacity(n * channels);
        for i in 0..n {
            let t = i as f32 / rate as f32;
            for c in 0..channels {
                let f0 = 140.0 + 70.0 * c as f32;
                let v: f32 = (1..=12).map(|h| (2.0 * std::f32::consts::PI * f0 * h as f32 * t).sin() / h as f32).sum::<f32>() * 0.2;
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                let noise = ((seed >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.01;
                out.push(((v + noise) * 32768.0).round() / 32768.0);
            }
        }
        out
    }

    /// The decoded file, its rate and channels.
    fn decode(path: &Path) -> (Vec<f32>, u32, usize) {
        let (s, rate, ch, _) = crate::projects::decode_to_interleaved_f32(path).unwrap();
        (s, rate, ch)
    }

    /// How closely `got` matches `want` (one channel each), in dB, at the best
    /// alignment within `max_shift` samples (lossy encoders add a delay).
    fn match_db(want: &[f32], got: &[f32], max_shift: usize) -> (f64, usize) {
        let n = want.len().min(got.len().saturating_sub(max_shift)) - 4800;
        let range = 2400..n;
        (0..=max_shift).map(|shift| {
            let (mut sig, mut err) = (0f64, 0f64);
            for i in range.clone() {
                let (a, b) = (want[i] as f64, got[i + shift] as f64);
                sig += a * a;
                err += (a - b) * (a - b);
            }
            (10.0 * (sig / err.max(1e-20)).log10(), shift)
        }).max_by(|a, b| a.0.total_cmp(&b.0)).unwrap()
    }

    /// The size of an MP4's top-level `mdat` box: its audio.
    fn mdat_bytes(path: &Path) -> u64 {
        let data = std::fs::read(path).unwrap();
        let mut off = 0;
        while off + 8 <= data.len() {
            let size = u32::from_be_bytes(data[off..off + 4].try_into().unwrap()) as usize;
            if &data[off + 4..off + 8] == b"mdat" { return size as u64 - 8; }
            if size < 8 { break; }
            off += size;
        }
        panic!("no mdat box");
    }

    fn channel(x: &[f32], channels: usize, c: usize) -> Vec<f32> {
        x.iter().skip(c).step_by(channels).copied().collect()
    }

    #[test]
    fn checked_refuses_what_isnt_offered() {
        assert!(ExportFormat::Wav { bits: 16 }.checked().is_ok());
        assert!(ExportFormat::Flac { bits: 20 }.checked().is_err());
        assert!(ExportFormat::Aac { kbps: 8, mono: false }.checked().is_err());
        assert!(ExportFormat::Mp3 { kbps: 128, mono: false }.checked().is_ok());
        assert!(ExportFormat::Mp3 { kbps: 100, mono: false }.checked().is_err());
    }

    #[test]
    fn folds_channels() {
        let quad = [0.4, 0.2, 0.0, 0.6];
        assert_eq!(&*fold(&quad, 4, 2), &[0.2, 0.4]);
        assert_eq!(&*fold(&quad, 4, 1), &[0.3]);
        assert!(matches!(fold(&quad, 4, 4), Cow::Borrowed(_)));
    }

    #[test]
    fn lossy_rates() {
        assert_eq!(lossy_rate(44_100), 44_100);
        assert_eq!(lossy_rate(16_000), 16_000);
        assert_eq!(lossy_rate(96_000), 48_000);
        assert_eq!(lossy_rate(88_200), 44_100);
        assert_eq!(lossy_rate(37_800), 44_100);
    }

    #[test]
    fn wav_round_trips_at_16_and_24_bits() {
        let x = signal(44_100, 2, 1.0);
        for bits in [16, 24] {
            let dst = scratch(&format!("wav{bits}.wav"));
            write(&x, 2, 44_100, &ExportFormat::Wav { bits }, &dst, &mut |_| {}).unwrap();
            let (y, rate, ch) = decode(&dst);
            assert_eq!((rate, ch, y.len()), (44_100, 2, x.len()));
            let worst = x.iter().zip(&y).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            assert!(worst < 2.0 / 32_767.0, "{bits}-bit: off by {worst}");
            assert!(!part_path(&dst).exists());
        }
    }

    #[test]
    fn flac_is_lossless() {
        for (channels, bits) in [(1, 16), (2, 16), (2, 24)] {
            let x = signal(48_000, channels, 1.5);
            let dst = scratch(&format!("flac{channels}-{bits}.flac"));
            let mut last = 0.0;
            write(&x, channels, 48_000, &ExportFormat::Flac { bits }, &dst, &mut |p| last = p).unwrap();
            let (y, rate, ch) = decode(&dst);
            assert_eq!((rate, ch, y.len()), (48_000, channels, x.len()), "{channels} ch, {bits}-bit");
            let worst = x.iter().zip(&y).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            assert!(worst < 1e-6, "{channels} ch, {bits}-bit FLAC changed the audio by {worst}");
            assert_eq!(last, 1.0);
            let wav_size = (x.len() * bits as usize / 8) as u64;
            let size = std::fs::metadata(&dst).unwrap().len();
            assert!(size < wav_size, "FLAC {size} bytes, WAV would be {wav_size}");
        }
    }

    #[test]
    fn aac_sounds_like_the_input() {
        let x = signal(44_100, 2, 3.0);
        let dst = scratch("aac.m4a");
        write(&x, 2, 44_100, &ExportFormat::Aac { kbps: 128, mono: false }, &dst, &mut |_| {}).unwrap();
        let (y, rate, ch) = decode(&dst);
        assert_eq!((rate, ch), (44_100, 2));
        for c in 0..2 {
            let (db, shift) = match_db(&channel(&x, 2, c), &channel(&y, 2, c), 4096);
            assert!(db > 20.0, "channel {c}: {db:.1} dB at a {shift}-sample delay");
        }
        // About 128 kbps over 3 s (the audio itself: the file also holds a
        // 56 KB `free` box macOS keeps for the index to grow into).
        let kbps = mdat_bytes(&dst) as f64 * 8.0 / 3.0 / 1000.0;
        assert!((100.0..160.0).contains(&kbps), "{kbps:.0} kbps");
    }

    #[test]
    fn aac_mono_mixes_down_and_high_rates_come_down_to_48k() {
        let x = signal(96_000, 2, 2.0);
        let dst = scratch("aac-mono.m4a");
        write(&x, 2, 96_000, &ExportFormat::Aac { kbps: 64, mono: true }, &dst, &mut |_| {}).unwrap();
        let (y, rate, ch) = decode(&dst);
        assert_eq!((rate, ch), (48_000, 1));
        let secs = y.len() as f64 / 48_000.0;
        assert!((1.95..2.15).contains(&secs), "{secs:.3} s");
    }

    #[test]
    fn mp3_sounds_like_the_input() {
        let x = signal(44_100, 2, 3.0);
        let dst = scratch("mp3.mp3");
        let mut last = 0.0;
        write(&x, 2, 44_100, &ExportFormat::Mp3 { kbps: 128, mono: false }, &dst, &mut |p| last = p).unwrap();
        assert_eq!(last, 1.0);
        let (y, rate, ch) = decode(&dst);
        assert_eq!((rate, ch), (44_100, 2));
        // LAME's delay (576 + 529 samples) and padding to a whole frame.
        let extra = y.len() / 2 - x.len() / 2;
        assert!(extra <= 1105 + 2 * 1152, "{extra} samples more");
        for c in 0..2 {
            let (db, shift) = match_db(&channel(&x, 2, c), &channel(&y, 2, c), 4096);
            println!("MP3 128 kbps, channel {c}: {db:.1} dB at a {shift}-sample delay");
            assert!(db > 20.0, "channel {c}: {db:.1} dB at a {shift}-sample delay");
        }
        // Constant 128 kbps: 417 or 418 bytes a frame at 44.1 kHz.
        let size = std::fs::metadata(&dst).unwrap().len() as f64;
        let kbps = size * 8.0 / (y.len() / 2) as f64 * 44_100.0 / 1000.0;
        assert!((125.0..131.0).contains(&kbps), "{kbps:.1} kbps");
    }

    #[test]
    fn mp3_starts_with_lames_info_tag() {
        let x = signal(48_000, 1, 2.0);
        let dst = scratch("mp3-tag.mp3");
        write(&x, 1, 48_000, &ExportFormat::Mp3 { kbps: 64, mono: true }, &dst, &mut |_| {}).unwrap();
        let head = std::fs::read(&dst).unwrap();
        assert_eq!(&head[..2], &[0xFF, 0xFB], "no MPEG-1 layer III frame at the start (an ID3 tag?)");
        let find = |what: &[u8]| head[..600].windows(what.len()).position(|w| w == what);
        assert!(find(b"Info").is_some(), "no Info tag (the CBR form of Xing)");
        assert!(find(b"LAME3.100").is_some(), "no LAME tag");
        let (_, rate, ch) = decode(&dst);
        assert_eq!((rate, ch), (48_000, 1));
    }

    #[test]
    fn mp3_mono_mixes_down_and_odd_rates_are_converted() {
        let x = signal(96_000, 2, 2.0);
        let dst = scratch("mp3-mono.mp3");
        write(&x, 2, 96_000, &ExportFormat::Mp3 { kbps: 96, mono: true }, &dst, &mut |_| {}).unwrap();
        let (y, rate, ch) = decode(&dst);
        assert_eq!((rate, ch), (48_000, 1));
        let secs = y.len() as f64 / 48_000.0;
        assert!((1.99..2.1).contains(&secs), "{secs:.3} s");
    }

    /// Every format on a real file (not run by default): how long each takes,
    /// how big it is, and that it decodes to the same length.
    /// `EXPORT_IN=…/audio.wav cargo test encode::tests::real_audio -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_audio() {
        let input = std::env::var("EXPORT_IN").expect("EXPORT_IN");
        let (x, rate, channels, secs) = crate::projects::decode_to_interleaved_f32(Path::new(&input)).unwrap();
        println!("{input}: {secs:.1} s, {rate} Hz, {channels} ch");
        let formats = [
            ExportFormat::Wav { bits: 16 }, ExportFormat::Wav { bits: 24 },
            ExportFormat::Flac { bits: 16 }, ExportFormat::Flac { bits: 24 },
            ExportFormat::Mp3 { kbps: 64, mono: true }, ExportFormat::Mp3 { kbps: 128, mono: false },
            ExportFormat::Mp3 { kbps: 192, mono: false }, ExportFormat::Mp3 { kbps: 320, mono: false },
            ExportFormat::Aac { kbps: 64, mono: true }, ExportFormat::Aac { kbps: 128, mono: false },
            ExportFormat::Aac { kbps: 256, mono: false },
        ];
        for format in formats {
            let ext = match format { ExportFormat::Wav { .. } => "wav", ExportFormat::Flac { .. } => "flac",
                                     ExportFormat::Mp3 { .. } => "mp3", ExportFormat::Aac { .. } => "m4a" };
            let dst = scratch(&format!("real.{ext}"));
            let t0 = std::time::Instant::now();
            write(&x, channels, rate, &format, &dst, &mut |_| {}).unwrap();
            let took = t0.elapsed().as_secs_f64();
            let mb = std::fs::metadata(&dst).unwrap().len() as f64 / 1e6;
            let (y, r, c) = decode(&dst);
            let out_secs = y.len() as f64 / c as f64 / r as f64;
            println!("{:<34} {took:6.2} s ({:5.0}× real time) · {mb:6.2} MB ({:5.1} MB an hour) · decodes to {out_secs:.2} s, {r} Hz, {c} ch",
                format!("{format:?}"), secs / took, mb * 3600.0 / secs);
        }
    }
}
