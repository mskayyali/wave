//! Render the frontend's resolved edit plan. No snapping, merging or independent
//! overlap decisions here: output positions also time playback and subtitles.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tone {
    pub start_ms: f64,
    pub end_ms: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub source_start_ms: f64,
    pub source_end_ms: f64,
    pub output_start_ms: f64,
    pub duration_ms: f64,
    pub fade_in_ms: f64,
    pub fade_out_ms: f64,
    pub pause: bool,
    pub tone: Option<Tone>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPlan {
    pub version: u32,
    pub source_duration_ms: f64,
    pub duration_ms: f64,
    pub pieces: Vec<Piece>,
}

impl EditPlan {
    pub fn validate(&self) -> Result<(), String> {
        let valid = self.version == 1
            && self.source_duration_ms.is_finite()
            && self.source_duration_ms >= 0.0
            && self.duration_ms.is_finite()
            && self.duration_ms >= 0.0;
        if !valid {
            return Err("Invalid edit plan header".into());
        }
        let near = |a: f64, b: f64| (a - b).abs() < 0.00001;
        let mut output = 0.0;
        for (i, p) in self.pieces.iter().enumerate() {
            if ![
                p.source_start_ms,
                p.source_end_ms,
                p.output_start_ms,
                p.duration_ms,
                p.fade_in_ms,
                p.fade_out_ms,
            ]
            .iter()
            .all(|x| x.is_finite())
                || p.source_start_ms < 0.0
                || p.source_end_ms < p.source_start_ms
                || p.source_end_ms > self.source_duration_ms + 0.00001
                || p.duration_ms <= 0.0
                || p.fade_in_ms < 0.0
                || p.fade_out_ms < 0.0
                || p.fade_in_ms > 12.0
                || p.fade_out_ms > 12.0
                || p.fade_in_ms + p.fade_out_ms > p.duration_ms + 0.00001
                || (!p.pause && !near(p.duration_ms, p.source_end_ms - p.source_start_ms))
                || (p.pause && !near(p.source_start_ms, p.source_end_ms))
            {
                return Err(format!("Invalid edit piece {i}"));
            }
            if let Some(t) = &p.tone {
                if !p.pause
                    || !t.start_ms.is_finite()
                    || !t.end_ms.is_finite()
                    || t.start_ms < 0.0
                    || t.end_ms - t.start_ms <= 20.0
                    || t.end_ms > self.source_duration_ms
                {
                    return Err("Invalid room tone".into());
                }
            }
            if i == 0 {
                if !near(p.fade_in_ms, 0.0) {
                    return Err("Unexpected initial fade".into());
                }
            } else if !near(self.pieces[i - 1].fade_out_ms, p.fade_in_ms) {
                return Err("Mismatched join fades".into());
            }
            output -= p.fade_in_ms;
            if !near(p.output_start_ms, output) {
                return Err("Inconsistent output position".into());
            }
            output += p.duration_ms;
        }
        if !near(output, self.duration_ms)
            || self
                .pieces
                .last()
                .is_some_and(|p| !near(p.fade_out_ms, 0.0))
        {
            return Err("Inconsistent edit duration".into());
        }
        Ok(())
    }
}

fn tone_sample(
    samples: &[f32],
    ch: usize,
    c: usize,
    start: usize,
    end: usize,
    i: usize,
    sr: u32,
) -> f32 {
    let length = end.saturating_sub(start);
    if length == 0 {
        return 0.0;
    }
    let fade = ((0.005 * sr as f64).round() as usize).min(length / 4);
    let at = i % (length - fade);
    let sample = |frame: usize| samples.get(frame * ch + c).copied().unwrap_or(0.0);
    if fade > 0 && at < fade {
        let t = (at as f64 + 0.5) / fade as f64;
        return (sample(end - fade + at) as f64 * (1.0 - t) + sample(start + at) as f64 * t) as f32;
    }
    sample(start + at)
}

pub fn render(
    samples: &[f32],
    channels: usize,
    sr: u32,
    plan: &EditPlan,
) -> Result<Vec<f32>, String> {
    plan.validate()?;
    if channels == 0 || sr == 0 {
        return Err("Invalid audio format".into());
    }
    let source_duration_ms = (samples.len() / channels) as f64 * 1000.0 / sr as f64;
    if (source_duration_ms - plan.source_duration_ms).abs() > 100.0 {
        return Err(
            "The audio no longer matches this edit plan. Reopen the project and try again.".into(),
        );
    }
    let frame = |ms: f64| (ms * sr as f64 / 1000.0).round() as usize;
    let frames = frame(plan.duration_ms);
    let len = frames
        .checked_mul(channels)
        .filter(|&n| n <= isize::MAX as usize / std::mem::size_of::<f32>())
        .ok_or("Edit is too long")?;
    let mut out = Vec::new();
    out.try_reserve_exact(len)
        .map_err(|_| "Not enough memory to render this edit")?;
    out.resize(len, 0.0f32);
    for p in &plan.pieces {
        if p.pause && p.tone.is_none() {
            continue;
        }
        let start = frame(p.output_start_ms);
        let end = frame(p.output_start_ms + p.duration_ms).min(frames);
        let source = frame(p.source_start_ms);
        let source_end = frame(p.source_end_ms);
        let tone = p
            .tone
            .as_ref()
            .map(|t| (frame(t.start_ms), frame(t.end_ms)));
        for f in start..end {
            let i = f - start;
            let t = (f as f64 + 0.5) * 1000.0 / sr as f64;
            let mut gain = 1.0f64;
            if p.fade_in_ms > 0.0 {
                gain = gain.min(((t - p.output_start_ms) / p.fade_in_ms).clamp(0.0, 1.0));
            }
            if p.fade_out_ms > 0.0 {
                gain = gain
                    .min(((p.output_start_ms + p.duration_ms - t) / p.fade_out_ms).clamp(0.0, 1.0));
            }
            for c in 0..channels {
                let sample = match tone {
                    Some((a, b)) => tone_sample(samples, channels, c, a, b, i, sr),
                    None => samples
                        .get((source + i).min(source_end.saturating_sub(1)) * channels + c)
                        .copied()
                        .unwrap_or(0.0),
                };
                out[f * channels + c] += (sample as f64 * gain) as f32;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_playback_fixtures() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/edit-plans.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let plan: EditPlan = serde_json::from_value(fixture["plan"].clone()).unwrap();
            let frames = fixture["sourceFrames"].as_u64().unwrap() as usize;
            let channels = fixture["channels"].as_u64().unwrap() as usize;
            let source: Vec<Vec<f32>> = (0..channels)
                .map(|c| {
                    (0..frames)
                        .map(|i| (((i * 17 + c * 7) % 97) as f32 - 48.0) / 64.0)
                        .collect()
                })
                .collect();
            let expected: Vec<Vec<f32>> =
                serde_json::from_value(fixture["expected"].clone()).unwrap();
            let sr = fixture["sr"].as_u64().unwrap() as u32;
            let ch = source.len();
            let samples: Vec<f32> = (0..source[0].len())
                .flat_map(|i| source.iter().map(move |c| c[i]))
                .collect();
            let actual = render(&samples, ch, sr, &plan).unwrap();
            assert_eq!(actual.len(), expected[0].len() * ch, "{}", fixture["name"]);
            for (i, &sample) in actual.iter().enumerate() {
                assert!(
                    (sample - expected[i % ch][i / ch]).abs() < 0.000001,
                    "{} sample {i}",
                    fixture["name"]
                );
            }
        }
    }

    #[test]
    fn rejects_invalid_plans() {
        let mut plan = EditPlan {
            version: 1,
            source_duration_ms: 1000.0,
            duration_ms: 1.0,
            pieces: vec![],
        };
        assert!(plan.validate().is_err());
        plan.duration_ms = 0.0;
        plan.version = 2;
        assert!(plan.validate().is_err());
        plan.version = 1;
        plan.duration_ms = f64::NAN;
        assert!(plan.validate().is_err());
        plan.duration_ms = 0.0;
        assert!(
            render(&[0.0; 10], 1, 1000, &plan).is_err(),
            "stale source duration"
        );
        assert!(
            render(&[], 0, 1000, &plan).is_err(),
            "invalid channel count"
        );
    }
}
