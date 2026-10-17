//! MP3 with LAME 3.100, loaded at run time from its own library
//! (vendor/lame/libmp3lame.0.dylib, which the app bundle carries in
//! Contents/Frameworks), so LAME stays separate and replaceable, as its licence
//! (the LGPL) asks. vendor/lame/build.sh builds it from the release.
//!
//! Constant bit rate (podcast apps and hosts handle it best), LAME's quality 2
//! ("near-best", what its documentation recommends), joint stereo for two
//! channels. The first frame is LAME's Info tag, written once the rest is
//! encoded: it carries the encoder delay and padding, so players trim them
//! and know the exact length. No ID3 tags.

use libloading::Library;
use std::ffi::{c_char, c_int, c_void};
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::ptr::null;
use std::sync::OnceLock;

const LIB_NAME: &str = "libmp3lame.0.dylib";

/// The MP3 bit rates (MPEG-1 layer III), in kbps.
pub const BIT_RATES: [u32; 14] = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

// lame.h: MPEG_mode and vbr_mode.
const MODE_JOINT_STEREO: c_int = 1;
const MODE_MONO: c_int = 3;
const VBR_OFF: c_int = 0;
const QUALITY: c_int = 2;

/// Frames per call: a little over a second at 48 kHz, a whole number of MP3 frames.
const CHUNK_FRAMES: usize = 1152 * 48;

type Flags = *mut c_void;

/// The functions Wave uses, found once.
struct Lame {
    init: unsafe extern "C" fn() -> Flags,
    set_in_samplerate: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_out_samplerate: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_num_channels: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_mode: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_vbr: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_brate: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_quality: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_write_vbr_tag: unsafe extern "C" fn(Flags, c_int) -> c_int,
    set_write_id3tag_automatic: unsafe extern "C" fn(Flags, c_int),
    init_params: unsafe extern "C" fn(Flags) -> c_int,
    encode_planar: unsafe extern "C" fn(Flags, *const f32, *const f32, c_int, *mut u8, c_int) -> c_int,
    encode_interleaved: unsafe extern "C" fn(Flags, *const f32, c_int, *mut u8, c_int) -> c_int,
    flush: unsafe extern "C" fn(Flags, *mut u8, c_int) -> c_int,
    lametag_frame: unsafe extern "C" fn(Flags, *mut u8, usize) -> usize,
    close: unsafe extern "C" fn(Flags) -> c_int,
    #[cfg_attr(not(test), allow(dead_code))]
    version: unsafe extern "C" fn() -> *const c_char,
    /// Kept loaded for as long as the functions above are used: always.
    _lib: Library,
}

static LAME: OnceLock<Result<Lame, String>> = OnceLock::new();

fn lame() -> Result<&'static Lame, String> {
    LAME.get_or_init(load).as_ref().map_err(Clone::clone)
}

/// Where the library is: in the app bundle, or, in a development build, the
/// copy in the repository.
fn library_path() -> Option<PathBuf> {
    library_path_beside(&std::env::current_exe().ok()?)
}

/// Wave.app/Contents/MacOS/wave → Wave.app/Contents/Frameworks/libmp3lame.0.dylib.
fn library_path_beside(exe: &Path) -> Option<PathBuf> {
    let bundled = exe.parent()?.parent()?.join("Frameworks").join(LIB_NAME);
    if bundled.is_file() { return Some(bundled); }
    #[cfg(debug_assertions)]
    {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/lame").join(LIB_NAME);
        if repo.is_file() { return Some(repo); }
    }
    None
}

fn load() -> Result<Lame, String> {
    let path = library_path().ok_or("MP3 export needs LAME, which is missing from this copy of Wave")?;
    unsafe {
        let lib = Library::new(&path).map_err(|e| format!("Couldn't load LAME: {e}"))?;
        macro_rules! sym {
            ($name:literal) => {
                *lib.get(concat!($name, "\0").as_bytes()).map_err(|e| format!("LAME has no {}: {e}", $name))?
            };
        }
        Ok(Lame {
            init: sym!("lame_init"),
            set_in_samplerate: sym!("lame_set_in_samplerate"),
            set_out_samplerate: sym!("lame_set_out_samplerate"),
            set_num_channels: sym!("lame_set_num_channels"),
            set_mode: sym!("lame_set_mode"),
            set_vbr: sym!("lame_set_VBR"),
            set_brate: sym!("lame_set_brate"),
            set_quality: sym!("lame_set_quality"),
            set_write_vbr_tag: sym!("lame_set_bWriteVbrTag"),
            set_write_id3tag_automatic: sym!("lame_set_write_id3tag_automatic"),
            init_params: sym!("lame_init_params"),
            encode_planar: sym!("lame_encode_buffer_ieee_float"),
            encode_interleaved: sym!("lame_encode_buffer_interleaved_ieee_float"),
            flush: sym!("lame_encode_flush"),
            lametag_frame: sym!("lame_get_lametag_frame"),
            close: sym!("lame_close"),
            version: sym!("get_lame_version"),
            _lib: lib,
        })
    }
}

/// "3.100", or why LAME can't be used.
#[cfg(test)]
pub fn version() -> Result<String, String> {
    let lame = lame()?;
    Ok(unsafe { std::ffi::CStr::from_ptr((lame.version)()) }.to_string_lossy().into_owned())
}

/// One encoder, closed however `write` ends.
struct Session(&'static Lame, Flags);
impl Drop for Session {
    fn drop(&mut self) { unsafe { (self.0.close)(self.1); } }
}

/// Encode `samples` (interleaved, one or two `channels`, `rate` Hz) to `dst`
/// at `kbps`. `out_rate` is the file's rate (one MP3 has).
pub fn write(samples: &[f32], channels: usize, rate: u32, out_rate: u32, kbps: u32, dst: &Path,
             progress: &mut dyn FnMut(f32)) -> Result<(), String> {
    if !(1..=2).contains(&channels) { return Err(format!("MP3 takes one or two channels, not {channels}")); }
    let lame = lame()?;
    let failed = |what: &str, code: c_int| format!("LAME couldn't {what} ({code})");
    unsafe {
        let flags = (lame.init)();
        if flags.is_null() { return Err("LAME couldn't start".into()); }
        let session = Session(lame, flags);
        (lame.set_in_samplerate)(flags, rate as c_int);
        (lame.set_out_samplerate)(flags, out_rate as c_int);
        (lame.set_num_channels)(flags, channels as c_int);
        (lame.set_mode)(flags, if channels == 1 { MODE_MONO } else { MODE_JOINT_STEREO });
        (lame.set_vbr)(flags, VBR_OFF);
        (lame.set_brate)(flags, kbps as c_int);
        (lame.set_quality)(flags, QUALITY);
        (lame.set_write_vbr_tag)(flags, 1);
        (lame.set_write_id3tag_automatic)(flags, 0);
        let code = (lame.init_params)(flags);
        if code < 0 { return Err(failed("use these settings", code)); }

        let mut file = BufWriter::new(File::create(dst).map_err(|e| format!("Couldn't create the file: {e}"))?);
        let io = |e: std::io::Error| format!("Couldn't write the file: {e}");
        // LAME's own bound for one call's output: 1.25 × samples + 7200 bytes.
        let mut out = vec![0u8; CHUNK_FRAMES * 5 / 4 + 7200];
        let total = (samples.len() / channels).max(1);
        let mut done = 0;
        for chunk in samples.chunks(CHUNK_FRAMES * channels) {
            let frames = (chunk.len() / channels) as c_int;
            let n = if channels == 1 {
                (lame.encode_planar)(flags, chunk.as_ptr(), null(), frames, out.as_mut_ptr(), out.len() as c_int)
            } else {
                (lame.encode_interleaved)(flags, chunk.as_ptr(), frames, out.as_mut_ptr(), out.len() as c_int)
            };
            if n < 0 { return Err(failed("encode the audio", n)); }
            file.write_all(&out[..n as usize]).map_err(io)?;
            done += frames as usize;
            progress(done as f32 / total as f32);
        }
        let n = (lame.flush)(flags, out.as_mut_ptr(), out.len() as c_int);
        if n < 0 { return Err(failed("finish the audio", n)); }
        file.write_all(&out[..n as usize]).map_err(io)?;

        // The first frame was kept for the Info tag: fill it in now.
        let n = (lame.lametag_frame)(flags, out.as_mut_ptr(), out.len());
        if n > 0 && n <= out.len() {
            file.seek(SeekFrom::Start(0)).map_err(io)?;
            file.write_all(&out[..n]).map_err(io)?;
        }
        file.flush().map_err(io)?;
        drop(session);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    #[test]
    fn finds_and_loads_the_library() {
        assert!(library_path().is_some(), "no {LIB_NAME} beside the app or in vendor/lame");
        assert_eq!(version().unwrap(), "3.100");
    }

    /// In the app it's found in Contents/Frameworks, and loads from there.
    #[test]
    fn finds_it_inside_an_app_bundle() {
        let app = std::env::temp_dir().join(format!("wave-lame-{}/Wave.app/Contents", std::process::id()));
        std::fs::create_dir_all(app.join("Frameworks")).unwrap();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor/lame").join(LIB_NAME);
        std::fs::copy(&repo, app.join("Frameworks").join(LIB_NAME)).unwrap();
        let found = library_path_beside(&app.join("MacOS/wave")).unwrap();
        assert_eq!(found, app.join("Frameworks").join(LIB_NAME));
        let lib = unsafe { Library::new(&found) }.unwrap();
        let version: libloading::Symbol<unsafe extern "C" fn() -> *const c_char> = unsafe { lib.get(b"get_lame_version\0") }.unwrap();
        assert_eq!(unsafe { CStr::from_ptr(version()) }.to_str().unwrap(), "3.100");
    }
}
