//! Loudness and peaks for publishing, from the public standards:
//!
//! - Integrated loudness per ITU-R BS.1770-4: K-weighting (a high shelf, then
//!   the RLB high-pass), the mean square over 400 ms blocks overlapping by
//!   75 %, an absolute gate at −70 LUFS and a relative gate 10 LU under the
//!   absolute-gated level. Mono, so the channel weight is 1.
//! - True peak: the signal oversampled 4× (a windowed-sinc interpolator, as
//!   BS.1770-4 Annex 2 describes), so peaks between samples count.
//! - A look-ahead limiter that keeps the true peak under a ceiling.
//!
//! The limiter works on the whole signal at once, which a file allows. For
//! each sample it works out the gain that sample needs, takes the lowest over
//! the next 5 ms, so the gain is already down when a peak arrives, ramps into
//! it over those 5 ms (a running mean, which can only be lower than every gain
//! it averages, so no peak gets through), then recovers over 80 ms. Nothing is
//! delayed: sample n comes out as sample n, which keeps the result in step
//! with the original.

use std::collections::VecDeque;

/// Gate and offset constants from BS.1770-4.
const ABSOLUTE_GATE_LUFS: f64 = -70.0;
const RELATIVE_GATE_LU: f64 = -10.0;
const LOUDNESS_OFFSET: f64 = -0.691;

/// Oversampling for true peak, and taps per interpolated phase.
const OVERSAMPLE: usize = 4;
const TAPS: usize = 16;

/// What `master` did.
pub struct Mastered {
    /// Integrated loudness before the gain (LUFS), if there was enough audio to measure.
    pub measured_lufs:  Option<f64>,
    /// True peak of the result (dBTP).
    pub true_peak_dbtp: Option<f64>,
}

/// Bring `audio` (mono, `rate` Hz) to `target_lufs` with one gain, at most
/// `max_gain_db` up, then limit its true peak to `ceiling_dbtp`.
pub fn master(audio: &mut [f32], rate: f64, target_lufs: f64, max_gain_db: f64, ceiling_dbtp: f64) -> Mastered {
    let measured = integrated_loudness(audio, rate);
    if let Some(lufs) = measured {
        let gain = 10f64.powf((target_lufs - lufs).min(max_gain_db) / 20.0) as f32;
        audio.iter_mut().for_each(|x| *x *= gain);
    }
    limit(audio, rate, ceiling_dbtp);
    Mastered { measured_lufs: measured, true_peak_dbtp: true_peak_db(audio) }
}

// ─── Loudness ─────────────────────────────────────────────────────────────────

/// Direct form I biquad, coefficients normalised so a0 = 1.
#[derive(Clone, Copy)]
struct Biquad { b: [f64; 3], a: [f64; 2], x: [f64; 2], y: [f64; 2] }

impl Biquad {
    fn new(b: [f64; 3], a: [f64; 2]) -> Self { Self { b, a, x: [0.0; 2], y: [0.0; 2] } }

    fn run(&mut self, input: f64) -> f64 {
        let out = self.b[0] * input + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [input, self.x[0]];
        self.y = [out, self.y[0]];
        out
    }
}

/// The two K-weighting filters at `rate`: the high shelf (+4 dB above about
/// 1.7 kHz, the head's effect) and the RLB high-pass (about 38 Hz), from their
/// analogue prototypes by the bilinear transform. At 48 kHz they come out as
/// the coefficients printed in BS.1770-4 (tested).
fn k_weighting(rate: f64) -> [Biquad; 2] {
    // High shelf: centre, gain and Q of the prototype.
    let (f0, gain_db, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
    let k = (std::f64::consts::PI * f0 / rate).tan();
    let vh = 10f64.powf(gain_db / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad::new(
        [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
        [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
    );
    // High-pass.
    let (f0, q) = (38.13547087602444, 0.5003270373238773);
    let k = (std::f64::consts::PI * f0 / rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let high_pass = Biquad::new([1.0, -2.0, 1.0], [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0]);
    [shelf, high_pass]
}

/// Integrated loudness of `audio` (mono) in LUFS; `None` if it's shorter than
/// one 400 ms block or silent.
pub fn integrated_loudness(audio: &[f32], rate: f64) -> Option<f64> {
    let block = (0.4 * rate).round() as usize;
    let step = (0.1 * rate).round() as usize;
    if audio.len() < block { return None; }

    // Squared K-weighted samples, summed per 100 ms step; a block is four steps.
    let [mut shelf, mut high_pass] = k_weighting(rate);
    let mut steps: Vec<f64> = Vec::with_capacity(audio.len() / step + 1);
    let mut sum = 0.0;
    for (i, &x) in audio.iter().enumerate() {
        let y = high_pass.run(shelf.run(x as f64));
        sum += y * y;
        if (i + 1) % step == 0 { steps.push(sum); sum = 0.0; }
    }
    let per_block = block / step;
    let blocks: Vec<f64> = steps.windows(per_block).map(|w| w.iter().sum::<f64>() / block as f64).collect();
    let lufs = |z: f64| LOUDNESS_OFFSET + 10.0 * z.log10();

    let mean = |zs: &mut dyn Iterator<Item = f64>| {
        let (s, n) = zs.fold((0.0, 0usize), |(s, n), z| (s + z, n + 1));
        (n > 0).then(|| s / n as f64)
    };
    let above_absolute = |z: &&f64| **z > 0.0 && lufs(**z) > ABSOLUTE_GATE_LUFS;
    let relative = lufs(mean(&mut blocks.iter().filter(above_absolute).copied())?) + RELATIVE_GATE_LU;
    let gated = mean(&mut blocks.iter().filter(above_absolute).filter(|z| lufs(**z) > relative).copied())?;
    Some(lufs(gated))
}

// ─── True peak ────────────────────────────────────────────────────────────────

/// The interpolators for the three points between two samples (1/4, 2/4, 3/4
/// of the way): a sinc under a Hann window, `TAPS` long, each scaled to unity
/// gain.
fn interpolators() -> [[f64; TAPS]; OVERSAMPLE - 1] {
    let mut phases = [[0.0; TAPS]; OVERSAMPLE - 1];
    for (p, taps) in phases.iter_mut().enumerate() {
        let frac = (p + 1) as f64 / OVERSAMPLE as f64;
        for (j, tap) in taps.iter_mut().enumerate() {
            // Sample offsets −7 … +8 around the point, which sits at `frac`.
            let t = j as f64 - (TAPS / 2 - 1) as f64 - frac;
            let sinc = if t.abs() < 1e-12 { 1.0 } else { (std::f64::consts::PI * t).sin() / (std::f64::consts::PI * t) };
            let window = 0.5 + 0.5 * (std::f64::consts::PI * t / (TAPS / 2) as f64).cos();
            *tap = sinc * window;
        }
        let sum: f64 = taps.iter().sum();
        taps.iter_mut().for_each(|t| *t /= sum);
    }
    phases
}

/// For each sample, the largest magnitude at it or between it and the next
/// sample (oversampled).
fn peaks(audio: &[f32]) -> Vec<f32> {
    let phases = interpolators();
    let at = |i: isize| if i >= 0 && (i as usize) < audio.len() { audio[i as usize] as f64 } else { 0.0 };
    (0..audio.len()).map(|n| {
        let mut peak = (audio[n] as f64).abs();
        for taps in &phases {
            let v: f64 = taps.iter().enumerate().map(|(j, c)| c * at(n as isize + j as isize - (TAPS / 2 - 1) as isize)).sum();
            peak = peak.max(v.abs());
        }
        peak as f32
    }).collect()
}

/// The true peak of `audio` in dBTP; `None` for silence.
pub fn true_peak_db(audio: &[f32]) -> Option<f64> {
    let peak = peaks(audio).into_iter().fold(0.0f32, f32::max);
    (peak > 0.0).then(|| 20.0 * (peak as f64).log10())
}

// ─── Limiter ──────────────────────────────────────────────────────────────────

/// Keep `audio`'s true peak at or under `ceiling_dbtp`, in place, with 5 ms of
/// look-ahead and an 80 ms recovery. Audio under the ceiling is untouched.
pub fn limit(audio: &mut [f32], rate: f64, ceiling_dbtp: f64) {
    let n = audio.len();
    if n == 0 { return; }
    let ceiling = 10f64.powf(ceiling_dbtp / 20.0) as f32;
    let ahead = ((0.005 * rate) as usize).max(1);
    let recover = (-1.0 / (0.080 * rate)).exp();

    // The gain each sample needs; a peak between samples counts for both.
    let p = peaks(audio);
    let need: Vec<f32> = (0..n).map(|i| {
        let around = p[i].max(if i > 0 { p[i - 1] } else { 0.0 });
        if around > ceiling { ceiling / around } else { 1.0 }
    }).collect();
    if need.iter().all(|&g| g >= 1.0) { return; }

    // The lowest over the next `ahead` samples (a monotonic deque, from the end).
    let mut lowest = vec![1.0f32; n];
    let mut dq: VecDeque<usize> = VecDeque::new();
    for i in (0..n).rev() {
        while dq.back().is_some_and(|&j| need[j] >= need[i]) { dq.pop_back(); }
        dq.push_back(i);
        while dq.front().is_some_and(|&j| j > i + ahead) { dq.pop_front(); }
        lowest[i] = need[*dq.front().unwrap()];
    }

    // Ramp into it: the mean of the last `ahead + 1` of those. Each of them
    // covers this sample, so each is at or under its need, and so is the mean.
    // Before the start, the first one repeats (it covers the early samples too).
    let width = (ahead + 1) as f64;
    let first = lowest[0] as f64;
    let mut ramp = vec![1.0f32; n];
    let mut sum = 0.0f64;
    for i in 0..n {
        sum += lowest[i] as f64;
        if i > ahead { sum -= lowest[i - ahead - 1] as f64; }
        let missing = (ahead + 1).saturating_sub(i + 1) as f64;
        ramp[i] = (((sum + missing * first) / width) as f32).min(need[i]);
    }

    // Down at once, back up over 80 ms, settling exactly once within a hair
    // (0.0001 dB) so audio after a peak is left as it was; never above the
    // ramp. In f64: near 1 the steps are finer than an f32 can tell apart.
    let mut gain = 1.0f64;
    for i in 0..n {
        let target = ramp[i] as f64;
        gain = if target < gain { target } else { target - (target - gain) * recover };
        if target - gain < 1e-5 { gain = target; }
        audio[i] = (audio[i] as f64 * gain) as f32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;

    fn sine(hz: f64, amplitude: f64, secs: f64, phase: f64) -> Vec<f32> {
        (0..(secs * RATE) as usize).map(|i| (amplitude * (2.0 * std::f64::consts::PI * hz * i as f64 / RATE + phase).sin()) as f32).collect()
    }

    #[test]
    fn k_weighting_matches_the_standard_at_48k() {
        // BS.1770-4, Tables 1 and 2.
        let [shelf, high_pass] = k_weighting(48_000.0);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-8;
        assert!(close(shelf.b[0], 1.53512485958697) && close(shelf.b[1], -2.69169618940638) && close(shelf.b[2], 1.19839281085285));
        assert!(close(shelf.a[0], -1.69065929318241) && close(shelf.a[1], 0.73248077421585));
        assert_eq!(high_pass.b, [1.0, -2.0, 1.0]);
        assert!(close(high_pass.a[0], -1.99004745483398) && close(high_pass.a[1], 0.99007225036621));
    }

    #[test]
    fn a_full_scale_997_hz_sine_measures_minus_3_lufs() {
        // BS.1770-4: a 0 dBFS sine at 997 Hz in one channel reads −3.01 LKFS.
        let lufs = integrated_loudness(&sine(997.0, 1.0, 5.0, 0.0), RATE).unwrap();
        assert!((lufs + 3.01).abs() < 0.02, "{lufs:.3} LUFS");
        // And 20 dB down, 20 dB less.
        let quiet = integrated_loudness(&sine(997.0, 0.1, 5.0, 0.0), RATE).unwrap();
        assert!((quiet - lufs + 20.0).abs() < 0.02, "{quiet:.3} LUFS");
    }

    #[test]
    fn silence_and_short_audio_have_no_loudness() {
        assert_eq!(integrated_loudness(&vec![0.0; 48_000], RATE), None);
        assert_eq!(integrated_loudness(&vec![0.5; 1_000], RATE), None);
    }

    #[test]
    fn the_gates_ignore_silence_between_speech() {
        // A tone with long silences either side reads as the tone alone, but
        // for the few blocks that straddle its edges (they count, as they're
        // above the gate: 0.06 dB for 20 s).
        let tone = sine(997.0, 0.5, 20.0, 0.0);
        let mut gappy = vec![0.0f32; 96_000];
        gappy.extend(&tone);
        gappy.extend(vec![0.0f32; 96_000]);
        let (a, b) = (integrated_loudness(&tone, RATE).unwrap(), integrated_loudness(&gappy, RATE).unwrap());
        assert!((a - b).abs() < 0.1, "{a:.2} vs {b:.2}");
    }

    #[test]
    fn true_peak_finds_peaks_between_samples() {
        // 12 kHz at 45°: every sample is ±0.707, the wave reaches ±1.
        let x = sine(12_000.0, 1.0, 0.1, std::f64::consts::FRAC_PI_4);
        let sample_peak = 20.0 * x.iter().fold(0.0f32, |m, v| m.max(v.abs())).log10();
        let true_peak = true_peak_db(&x).unwrap();
        assert!((sample_peak + 3.01).abs() < 0.05, "sample peak {sample_peak:.2}");
        assert!(true_peak.abs() < 0.2, "true peak {true_peak:.2} dBTP");
    }

    #[test]
    fn limiter_holds_the_ceiling_keeps_time_and_leaves_quiet_audio_alone() {
        // A quiet tone with loud bursts in it.
        let mut x = sine(220.0, 0.3, 4.0, 0.0);
        for (i, v) in x.iter_mut().enumerate() {
            if (24_000..24_480).contains(&i) || (60_000..62_000).contains(&i) { *v *= 4.0; }
        }
        let before = x.clone();
        limit(&mut x, RATE, -1.5);
        assert_eq!(x.len(), before.len());
        let peak = true_peak_db(&x).unwrap();
        assert!(peak <= -1.5 + 0.05, "true peak {peak:.2} dBTP");
        // Before the first burst's 5 ms look-ahead, and once the recovery has
        // settled (under a second after the last), untouched.
        assert!(x[..23_000].iter().zip(&before).all(|(a, b)| a == b));
        assert!(x[110_000..].iter().zip(&before[110_000..]).all(|(a, b)| a == b));
        // Not delayed: the limited burst lines up with the original.
        let lag = (0..40i64).map(|d| {
            let s: f64 = (60_000..62_000).map(|i| x[i] as f64 * before[(i as i64 + d - 20) as usize] as f64).sum();
            (s, d - 20)
        }).max_by(|a, b| a.0.total_cmp(&b.0)).unwrap().1;
        assert_eq!(lag, 0);
    }

    #[test]
    fn master_reaches_the_target() {
        let mut x = sine(440.0, 0.05, 6.0, 0.0);
        let done = master(&mut x, RATE, -19.0, 24.0, -1.5);
        let after = integrated_loudness(&x, RATE).unwrap();
        assert!((after + 19.0).abs() < 0.1, "{after:.2} LUFS (was {:?})", done.measured_lufs);
        assert!(done.true_peak_dbtp.unwrap() <= -1.45);
        // Capped: a whisper isn't lifted more than the cap allows.
        let mut quiet = sine(440.0, 0.001, 6.0, 0.0);
        let before = integrated_loudness(&quiet, RATE).unwrap();
        master(&mut quiet, RATE, -19.0, 9.0, -1.5);
        assert!((integrated_loudness(&quiet, RATE).unwrap() - before - 9.0).abs() < 0.05);
    }
}
