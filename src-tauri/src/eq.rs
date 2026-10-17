//! EQ: named presets for spoken voice, applied after noise removal and before
//! the loudness target (enhance.rs). Each one fixes one problem and keeps to
//! its own band, as podcast tools name theirs (Riverside's are the model): too
//! muddy, too thin, too boomy, boxy, nasal, dull, harsh, plus one all-round
//! broadcast sound. The moves follow the usual ranges for voice (rumble below
//! 70–120 Hz, mud at 200–400 Hz, boxiness 400–800 Hz, nasal around 900 Hz,
//! presence 2–5 kHz, sibilance 4–8 kHz, air from 7–10 kHz).
//!
//! Filters are RBJ-cookbook biquads (Robert Bristow-Johnson's "Audio EQ
//! Cookbook") at 48 kHz. Boosts are broad and cuts narrower, and a boost stays
//! within +3 dB at medium, so a preset is safe on any voice: the loudness target
//! after it measures with K-weighting, which barely counts bass, so extra bass
//! only reaches the limiter as peaks. The amount scales every gain (subtle ×0.5,
//! medium ×1, strong ×1.5); a rumble high-pass stays put, except in Less boom.
//!
//! Presets that lift the highs also tame S sounds (`DeEss`), since a static
//! treble boost sharpens every "s" with the consonants it brings forward.

/// One step of a preset.
#[derive(Debug, Clone, Copy)]
enum Filter {
    /// 12 dB/octave below `hz` (Q 0.707: Butterworth).
    HighPass { hz: f64 },
    /// A high-pass at `hz` for medium, 20 Hz lower for subtle and higher for strong.
    HighPassByAmount { hz: f64 },
    /// Everything below `hz` by `db` (slope 0.8: gentle, no overshoot).
    LowShelf { hz: f64, db: f64 },
    /// Everything above `hz` by `db`.
    HighShelf { hz: f64, db: f64 },
    /// A bell around `hz`, `q` wide.
    Peak { hz: f64, db: f64, q: f64 },
    /// Turn the band above 4.5 kHz down by up to `db` while it carries most of
    /// the sound, as an "s" does (never on voiced speech).
    DeEss { db: f64 },
}

const SHELF_SLOPE: f64 = 0.8;

/// The presets, by id (the frontend's EQ_PRESETS has their names and notes).
fn preset(id: &str) -> Option<&'static [Filter]> {
    use Filter::*;
    Some(match id {
        // Mud out, presence in: the most common fix, and adds no bass.
        "clearer" => &[HighPass { hz: 80.0 }, Peak { hz: 250.0, db: -2.5, q: 1.0 }, Peak { hz: 3200.0, db: 2.5, q: 0.8 }],
        // Body for a thin voice (laptop, headset or lapel mic), without the mud
        // above it. A bell rather than a shelf: a shelf lifts the rumble the
        // high-pass takes out, and the limiter pays for it.
        "warmer" => &[HighPass { hz: 70.0 }, Peak { hz: 150.0, db: 3.0, q: 0.9 }, Peak { hz: 320.0, db: -1.5, q: 1.2 }],
        // The proximity effect of talking right up against the mic.
        "less-boom" => &[HighPassByAmount { hz: 100.0 }, LowShelf { hz: 200.0, db: -3.0 }],
        // The hollow sound of a small room.
        "less-boxy" => &[HighPass { hz: 80.0 }, Peak { hz: 500.0, db: -3.0, q: 1.4 }],
        // A honky or pinched tone.
        "less-nasal" => &[HighPass { hz: 70.0 }, Peak { hz: 900.0, db: -3.0, q: 1.4 }],
        // Crispness back for a dull voice, also after heavy noise removal.
        "brighter" => &[HighPass { hz: 70.0 }, Peak { hz: 3500.0, db: 1.5, q: 0.7 }, HighShelf { hz: 7000.0, db: 3.0 },
                        DeEss { db: -4.0 }],
        // The edge of a piercing voice, and sharp S sounds.
        "less-harsh" => &[HighPass { hz: 70.0 }, Peak { hz: 3000.0, db: -2.0, q: 1.4 }, DeEss { db: -6.0 }],
        // A close-up radio voice: a little bass, less mud, presence and air.
        "broadcast" => &[HighPass { hz: 80.0 }, Peak { hz: 140.0, db: 2.0, q: 0.9 }, Peak { hz: 300.0, db: -2.0, q: 1.0 },
                         Peak { hz: 3500.0, db: 2.0, q: 0.9 }, HighShelf { hz: 10_000.0, db: 1.5 }, DeEss { db: -3.0 }],
        _ => return None,
    })
}

/// The amount as a gain scale: `subtle` | `medium` | `strong`.
pub fn amount_scale(amount: &str) -> f64 {
    match amount { "subtle" => 0.5, "strong" => 1.5, _ => 1.0 }
}

/// Apply preset `id` to `audio` (mono, `rate` Hz, the whole stretch at once:
/// S sounds are found ahead of time) in place. Unknown ids and `off` change
/// nothing.
pub fn apply(audio: &mut [f32], rate: f64, id: &str, scale: f64) {
    let Some(filters) = preset(id) else { return };
    for f in filters {
        match *f {
            Filter::DeEss { db } => de_ess(audio, rate, db * scale),
            f => {
                let mut bq = Biquad::new(design(f, rate, scale));
                for x in audio.iter_mut() { *x = bq.process(*x as f64) as f32; }
            }
        }
    }
}

/// Is `id` a preset (or `off`)?
pub fn is_known(id: &str) -> bool {
    id == "off" || preset(id).is_some()
}

// ─── Filters ──────────────────────────────────────────────────────────────────

/// Normalised coefficients: (b0, b1, b2), (a1, a2).
type Coeffs = ([f64; 3], [f64; 2]);

fn design(f: Filter, rate: f64, scale: f64) -> Coeffs {
    let w = |hz: f64| 2.0 * std::f64::consts::PI * hz / rate;
    match f {
        Filter::HighPass { hz } => high_pass(w(hz)),
        Filter::HighPassByAmount { hz } => high_pass(w(hz + 40.0 * (scale - 1.0))),
        Filter::Peak { hz, db, q } => {
            let a = 10f64.powf(db * scale / 40.0);
            let (c, alpha) = (w(hz).cos(), w(hz).sin() / (2.0 * q));
            normalise([1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a], [1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a])
        }
        Filter::LowShelf { hz, db } => shelf(w(hz), db * scale, false),
        Filter::HighShelf { hz, db } => shelf(w(hz), db * scale, true),
        Filter::DeEss { .. } => ([1.0, 0.0, 0.0], [0.0, 0.0]),
    }
}

fn high_pass(w: f64) -> Coeffs {
    let (c, alpha) = (w.cos(), w.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2));
    normalise([(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0], [1.0 + alpha, -2.0 * c, 1.0 - alpha])
}

fn low_pass(w: f64) -> Coeffs {
    let (c, alpha) = (w.cos(), w.sin() / (2.0 * std::f64::consts::FRAC_1_SQRT_2));
    normalise([(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0], [1.0 + alpha, -2.0 * c, 1.0 - alpha])
}

fn normalise(b: [f64; 3], a: [f64; 3]) -> Coeffs {
    ([b[0] / a[0], b[1] / a[0], b[2] / a[0]], [a[1] / a[0], a[2] / a[0]])
}

/// RBJ shelves with slope `SHELF_SLOPE`.
fn shelf(w: f64, db: f64, high: bool) -> Coeffs {
    let a = 10f64.powf(db / 40.0);
    let c = w.cos();
    let alpha = w.sin() / 2.0 * ((a + 1.0 / a) * (1.0 / SHELF_SLOPE - 1.0) + 2.0).sqrt();
    let k = 2.0 * a.sqrt() * alpha;
    if high {
        normalise(
            [a * ((a + 1.0) + (a - 1.0) * c + k), -2.0 * a * ((a - 1.0) + (a + 1.0) * c), a * ((a + 1.0) + (a - 1.0) * c - k)],
            [(a + 1.0) - (a - 1.0) * c + k, 2.0 * ((a - 1.0) - (a + 1.0) * c), (a + 1.0) - (a - 1.0) * c - k],
        )
    } else {
        normalise(
            [a * ((a + 1.0) - (a - 1.0) * c + k), 2.0 * a * ((a - 1.0) - (a + 1.0) * c), a * ((a + 1.0) - (a - 1.0) * c - k)],
            [(a + 1.0) + (a - 1.0) * c + k, -2.0 * ((a - 1.0) + (a + 1.0) * c), (a + 1.0) + (a - 1.0) * c - k],
        )
    }
}

/// Direct-form I biquad.
struct Biquad { b: [f64; 3], a: [f64; 2], x1: f64, x2: f64, y1: f64, y2: f64 }

impl Biquad {
    fn new((b, a): Coeffs) -> Self { Self { b, a, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 } }

    fn process(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x1 + self.b[2] * self.x2 - self.a[0] * self.y1 - self.a[1] * self.y2;
        self.x2 = self.x1; self.x1 = x;
        self.y2 = self.y1; self.y1 = y;
        y
    }
}

// ─── S sounds ─────────────────────────────────────────────────────────────────

/// Where the band splits: above it is the hiss of an "s" (about 5 kHz for
/// deeper voices, 7 kHz for higher ones), below it everything voiced.
const DE_ESS_SPLIT_HZ: f64 = 4500.0;

/// A split-band de-esser. The split is zero-phase (forward and back), so the
/// bands add back to the input exactly and an untouched stretch is unchanged.
/// The high band is turned down where it holds more than 40 % of the energy,
/// fully from 80 %; voiced speech keeps well under that. The gain is smoothed
/// both ways, so it starts before an "s" rather than after its onset.
fn de_ess(audio: &mut [f32], rate: f64, db: f64) {
    if audio.is_empty() || db >= 0.0 { return; }
    let floor = 10f64.powf(db / 20.0);

    let mut low: Vec<f64> = audio.iter().map(|&x| x as f64).collect();
    let mut lp = Biquad::new(low_pass(2.0 * std::f64::consts::PI * DE_ESS_SPLIT_HZ / rate));
    for v in low.iter_mut() { *v = lp.process(*v); }
    let mut lp = Biquad::new(low_pass(2.0 * std::f64::consts::PI * DE_ESS_SPLIT_HZ / rate));
    for v in low.iter_mut().rev() { *v = lp.process(*v); }

    // Energy envelopes (5 ms), then the gain each sample wants.
    let k = 1.0 - (-1.0 / (0.005 * rate)).exp();
    let (mut eh, mut ef) = (0.0f64, 0.0f64);
    let mut gain: Vec<f64> = audio.iter().zip(&low).map(|(&x, &l)| {
        let h = x as f64 - l;
        eh += k * (h * h - eh);
        ef += k * ((x as f64).powi(2) - ef);
        let share = if ef > 1e-12 { eh / ef } else { 0.0 };
        let t = ((share - 0.4) / 0.4).clamp(0.0, 1.0);
        1.0 - t * (1.0 - floor)
    }).collect();

    // Down fast (1 ms), back up slowly (40 ms), both ways; keep the lower.
    let (attack, release) = (1.0 - (-1.0 / (0.001 * rate)).exp(), 1.0 - (-1.0 / (0.040 * rate)).exp());
    let smooth = |g: &mut dyn Iterator<Item = &mut f64>| {
        let mut s = 1.0f64;
        for v in g {
            s += if *v < s { attack } else { release } * (*v - s);
            *v = s;
        }
    };
    let mut back = gain.clone();
    smooth(&mut gain.iter_mut());
    smooth(&mut back.iter_mut().rev());

    for (i, x) in audio.iter_mut().enumerate() {
        let g = gain[i].min(back[i]);
        let l = low[i];
        *x = (l + (*x as f64 - l) * g) as f32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;
    const ALL: [&str; 8] = ["clearer", "warmer", "less-boom", "less-boxy", "less-nasal", "brighter", "less-harsh", "broadcast"];

    /// |H(f)| of a preset's filters (the de-esser left out), in dB.
    fn response_db(id: &str, scale: f64, hz: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * hz / RATE;
        preset(id).unwrap().iter().map(|f| {
            let (b, a) = design(*f, RATE, scale);
            let z = |k: f64| (w * k).cos();
            let s = |k: f64| -(w * k).sin();
            let (nr, ni) = (b[0] + b[1] * z(1.0) + b[2] * z(2.0), b[1] * s(1.0) + b[2] * s(2.0));
            let (dr, di) = (1.0 + a[0] * z(1.0) + a[1] * z(2.0), a[0] * s(1.0) + a[1] * s(2.0));
            10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
        }).sum()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// A voiced sound: 140 Hz and its harmonics up to 3.5 kHz, falling off.
    fn voiced(len: usize) -> Vec<f32> {
        (0..len).map(|i| {
            let t = i as f64 / RATE;
            (1..=25).map(|h| (2.0 * std::f64::consts::PI * 140.0 * h as f64 * t).sin() / h as f64).sum::<f64>() as f32 * 0.1
        }).collect()
    }

    /// An "s": noise above 4.5 kHz (white noise, high-passed twice).
    fn hiss(len: usize) -> Vec<f32> {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut x: Vec<f32> = (0..len).map(|_| {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
            ((seed >> 40) as f64 / (1u64 << 24) as f64 - 0.5) as f32 * 0.3
        }).collect();
        for _ in 0..2 {
            let mut hp = Biquad::new(high_pass(2.0 * std::f64::consts::PI * 6000.0 / RATE));
            for v in x.iter_mut() { *v = hp.process(*v as f64) as f32; }
        }
        x
    }

    #[test]
    fn off_and_unknown_change_nothing() {
        let x: Vec<f32> = (0..4800).map(|i| (i as f32 * 0.01).sin()).collect();
        for id in ["off", "nonsense"] {
            let mut y = x.clone();
            apply(&mut y, RATE, id, 1.0);
            assert_eq!(x, y);
        }
    }

    #[test]
    fn every_preset_takes_out_rumble_and_stays_gentle() {
        for id in ALL {
            assert!(response_db(id, 1.0, 25.0) < -9.0, "{id} keeps rumble: {:.1} dB at 25 Hz", response_db(id, 1.0, 25.0));
            for hz in [150.0, 200.0, 300.0, 500.0, 900.0, 1500.0, 3000.0, 5000.0, 8000.0, 12_000.0, 16_000.0] {
                let medium = response_db(id, 1.0, hz);
                let strong = response_db(id, 1.5, hz);
                assert!(medium < 3.5 && strong < 5.5, "{id} lifts {hz} Hz by {medium:.1} dB (medium), {strong:.1} dB (strong)");
                assert!(strong > -6.5, "{id} strong cuts {hz} Hz by {strong:.1} dB");
            }
        }
    }

    #[test]
    fn presets_do_what_they_say() {
        let at = |id, hz| response_db(id, 1.0, hz);
        assert!(at("clearer", 250.0) < -2.0 && at("clearer", 3200.0) > 2.0);
        assert!(at("warmer", 150.0) > 2.0 && at("warmer", 70.0) < 1.0);
        assert!(at("less-boom", 150.0) < -2.5);
        assert!(at("less-boxy", 500.0) < -2.5);
        assert!(at("less-nasal", 900.0) < -2.5);
        assert!(at("brighter", 10_000.0) > 2.5);
        assert!(at("less-harsh", 3000.0) < -1.5);
        assert!(at("broadcast", 140.0) > 1.0 && at("broadcast", 3500.0) > 1.5);
        // Each touches its own problem, not the others'.
        assert!(at("warmer", 3000.0).abs() < 0.5 && at("brighter", 200.0).abs() < 0.5 && at("less-nasal", 3000.0).abs() < 0.5);
        // The amount scales the moves, and moves Less boom's high-pass.
        assert!(response_db("warmer", 1.5, 150.0) > response_db("warmer", 0.5, 150.0) + 2.0);
        assert!(response_db("less-boom", 1.5, 100.0) < response_db("less-boom", 0.5, 100.0) - 4.0);
    }

    #[test]
    fn de_esser_tames_s_and_leaves_voice_alone() {
        let n = RATE as usize / 2;
        // Voiced speech comes back as it went in.
        let x = voiced(n);
        let mut y = x.clone();
        de_ess(&mut y, RATE, -6.0);
        let diff: Vec<f32> = x.iter().zip(&y).map(|(a, b)| a - b).collect();
        assert!(rms(&diff) < rms(&x) * 0.01, "voice changed by {:.1} dB", 20.0 * (rms(&diff) / rms(&x)).log10());

        // An "s" after it goes down by about the amount; the voice stays.
        let mut s = voiced(n);
        s.extend(hiss(n));
        de_ess(&mut s, RATE, -6.0);
        let before = rms(&hiss(n)[2400..]);
        let after = rms(&s[n + 2400..]);
        let db = 20.0 * (after / before).log10();
        assert!((-6.5..-4.0).contains(&db), "the s went down {db:.1} dB");
        let voice_db = 20.0 * (rms(&s[..n - 4800]) / rms(&x[..n - 4800])).log10();
        assert!(voice_db.abs() < 0.2, "the voice before it moved {voice_db:.1} dB");
    }
}
