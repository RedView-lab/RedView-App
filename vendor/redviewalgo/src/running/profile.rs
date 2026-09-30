//! Runner profile: defaults per practice level, user references (VMA or a
//! race time) and parameters learnt from running FIT files.

use super::cost::effort_factor;
use super::{RunDiscipline, RunPredictionConfig, RunnerProfile};
use crate::math::statistics::linear_regression;
use crate::math::{median, median_filter_elevations};
use crate::types::{ActivityData, Gender};

/// Riegel endurance exponent used to convert a reference race to the 1 h
/// reference speed (Riegel 1981).
const RIEGEL_EXPONENT: f64 = 1.06;
/// Sustainable fraction of VMA over ~1 h (half-marathon to 1 h race pace).
const VMA_TO_HOUR_FRACTION: f64 = 0.85;

/// Distance-resampling step used to read FIT files (m).
const CHUNK_M: f64 = 100.0;
/// Below this per-leg cadence (strides/min, FIT `cadence` field) a runner is walking.
const WALK_CADENCE_SPM: f64 = 70.0;

/// Practice level presets: debutant, intermediaire, avance, expert.
#[derive(Debug, Clone, Copy)]
pub struct LevelPreset {
    /// Flat speed sustainable for ~1 h (km/h).
    pub v_ref_kmh: f64,
    /// Grade (%) above which the runner power-hikes.
    pub walk_threshold_pct: f64,
    /// Sustainable power-hiking vertical rate (m/h).
    pub walk_vam_mh: f64,
    /// Instantaneous Riegel-like decay exponent (road running).
    pub riegel_k: f64,
    /// Downhill skill multiplier on the technical descent cap.
    pub descent_skill: f64,
}

const LEVELS: [LevelPreset; 4] = [
    LevelPreset { v_ref_kmh: 8.5, walk_threshold_pct: 8.0, walk_vam_mh: 500.0, riegel_k: 0.11, descent_skill: 0.80 },
    LevelPreset { v_ref_kmh: 10.5, walk_threshold_pct: 12.0, walk_vam_mh: 700.0, riegel_k: 0.10, descent_skill: 0.90 },
    LevelPreset { v_ref_kmh: 12.5, walk_threshold_pct: 15.0, walk_vam_mh: 900.0, riegel_k: 0.09, descent_skill: 1.00 },
    LevelPreset { v_ref_kmh: 14.5, walk_threshold_pct: 18.0, walk_vam_mh: 1100.0, riegel_k: 0.08, descent_skill: 1.10 },
];

/// Extra decay on trail: ultra-trail finishers slow far more than road
/// runners (Riegel exponent 1.08-1.10 for ultras; ~17 % second-half drop at UTMB).
const TRAIL_EXTRA_K: f64 = 0.02;

pub fn level_preset(level: Option<&str>) -> LevelPreset {
    let lvl = level.unwrap_or("").to_lowercase();
    if lvl.contains("expert") {
        LEVELS[3]
    } else if lvl.contains("avanc") {
        LEVELS[2]
    } else if lvl.contains("inter") {
        LEVELS[1]
    } else if lvl.contains("debut") || lvl.contains("début") {
        LEVELS[0]
    } else {
        LEVELS[1]
    }
}

/// Speed sustainable for one hour from a reference race (Riegel).
pub fn hour_speed_from_race(distance_m: f64, time_s: f64) -> Option<f64> {
    if !(distance_m >= 1000.0 && time_s >= 180.0) {
        return None;
    }
    // Distance D covered in 3600 s: T1·(D/D1)^1.06 = 3600.
    let d_hour = distance_m * (3600.0 / time_s).powf(1.0 / RIEGEL_EXPONENT);
    let v = d_hour / 3600.0;
    (v > 1.0 && v < 7.5).then_some(v)
}

/// A 100 m slice of a FIT activity.
struct Chunk {
    start_h: f64,
    dt_s: f64,
    dist_m: f64,
    grade_pct: f64,
    ele_gain_m: f64,
    walking: bool,
}

impl Chunk {
    fn speed_ms(&self) -> f64 {
        self.dist_m / self.dt_s
    }
}

/// Cut an activity into ~100 m moving slices (pauses removed).
fn chunk_activity(activity: &ActivityData) -> Vec<Chunk> {
    let pts = &activity.points;
    if pts.len() < 20 {
        return Vec::new();
    }
    let raw_alt: Vec<f64> = pts.iter().map(|p| p.altitude_m).collect();
    let alt = median_filter_elevations(&raw_alt, 5);
    let has_cadence = pts.iter().filter(|p| p.cadence_rpm > 0.0).count() * 2 > pts.len();

    let mut chunks = Vec::new();
    let mut moving_s = 0.0_f64;
    let mut start = 0usize;
    let mut acc_dt = 0.0_f64;
    let mut cad_sum = 0.0_f64;
    let mut cad_n = 0usize;

    for i in 1..pts.len() {
        let dt = pts[i].timestamp_s - pts[i - 1].timestamp_s;
        let dd = pts[i].distance_m - pts[i - 1].distance_m;
        // Skip pauses (auto-pause gaps or standing still).
        if dt <= 0.0 || dt > 30.0 || dd < 0.0 || dd / dt < 0.4 {
            start = i;
            acc_dt = 0.0;
            cad_sum = 0.0;
            cad_n = 0;
            continue;
        }
        acc_dt += dt;
        if pts[i].cadence_rpm > 0.0 {
            cad_sum += pts[i].cadence_rpm;
            cad_n += 1;
        }
        let dist = pts[i].distance_m - pts[start].distance_m;
        if dist >= CHUNK_M {
            let dele = alt[i] - alt[start];
            let grade = (dele / dist * 100.0).clamp(-60.0, 60.0);
            let speed = dist / acc_dt;
            let walking = if has_cadence && cad_n > 0 {
                let cad = cad_sum / cad_n as f64;
                cad > 20.0 && cad < WALK_CADENCE_SPM
            } else {
                grade > 5.0 && speed < 6.5 / 3.6
            };
            chunks.push(Chunk {
                start_h: moving_s / 3600.0,
                dt_s: acc_dt,
                dist_m: dist,
                grade_pct: grade,
                ele_gain_m: dele.max(0.0),
                walking,
            });
            moving_s += acc_dt;
            start = i;
            acc_dt = 0.0;
            cad_sum = 0.0;
            cad_n = 0;
        }
    }
    chunks
}

/// Best rolling average of grade-adjusted running speed over `window_s` of
/// moving time, within the first 3 h of the activity.
fn best_gap_speed(chunks: &[Chunk], window_s: f64) -> Option<f64> {
    let running: Vec<(f64, f64)> = chunks
        .iter()
        .filter(|c| !c.walking && c.start_h < 3.0 && (-12.0..=12.0).contains(&c.grade_pct))
        .map(|c| (c.dt_s, c.dist_m * effort_factor(c.grade_pct)))
        .collect();
    let mut best: Option<f64> = None;
    let (mut t, mut d, mut lo) = (0.0_f64, 0.0_f64, 0usize);
    for hi in 0..running.len() {
        t += running[hi].0;
        d += running[hi].1;
        while t - running[lo].0 >= window_s && lo < hi {
            t -= running[lo].0;
            d -= running[lo].1;
            lo += 1;
        }
        if t >= window_s {
            let v = d / t;
            best = Some(best.map_or(v, |b: f64| b.max(v)));
        }
    }
    best
}

/// Everything learnt from FIT files; None fields keep the preset value.
#[derive(Default)]
pub struct LearntParams {
    pub v_ref_ms: Option<f64>,
    pub riegel_k: Option<f64>,
    pub walk_threshold_pct: Option<f64>,
    pub walk_vam_mh: Option<f64>,
    pub descent_ratio: Option<f64>,
}

pub fn learn_from_activities(
    activities: &[ActivityData],
    preset: &LevelPreset,
    technicality: f64,
    discipline: RunDiscipline,
) -> LearntParams {
    let per_activity: Vec<Vec<Chunk>> = activities.iter().map(chunk_activity).collect();
    let mut learnt = LearntParams::default();

    // ── Reference speed: best 30 min GAP, ~4 % above 1 h pace ──
    let mut v_ref: Option<f64> = None;
    for chunks in &per_activity {
        let candidate = best_gap_speed(chunks, 1800.0)
            .map(|v| v * 0.96)
            .or_else(|| best_gap_speed(chunks, 600.0).map(|v| v * 0.90));
        if let Some(v) = candidate {
            v_ref = Some(v_ref.map_or(v, |b: f64| b.max(v)));
        }
    }
    learnt.v_ref_ms = v_ref.filter(|v| *v > 1.2 && *v < 7.0);

    // ── Endurance decay: log-log regression of 30 min blocks on long runs ──
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for chunks in &per_activity {
        let total_h: f64 = chunks.iter().map(|c| c.dt_s).sum::<f64>() / 3600.0;
        if total_h < 2.0 {
            continue;
        }
        let n_blocks = (total_h / 0.5).floor() as usize;
        let mut blocks = vec![(0.0_f64, 0.0_f64); n_blocks.max(1)];
        for c in chunks.iter().filter(|c| !c.walking && c.grade_pct.abs() <= 12.0) {
            let b = ((c.start_h / 0.5) as usize).min(blocks.len() - 1);
            blocks[b].0 += c.dist_m * effort_factor(c.grade_pct);
            blocks[b].1 += c.dt_s;
        }
        let first_hour: Vec<f64> = blocks
            .iter()
            .take(2)
            .filter(|b| b.1 > 300.0)
            .map(|b| b.0 / b.1)
            .collect();
        if first_hour.is_empty() {
            continue;
        }
        let v0 = first_hour.iter().sum::<f64>() / first_hour.len() as f64;
        for (i, b) in blocks.iter().enumerate().skip(2) {
            if b.1 > 600.0 {
                let t_mid = (i as f64 + 0.5) * 0.5;
                xs.push(t_mid.ln());
                ys.push((b.0 / b.1 / v0).ln());
            }
        }
    }
    if xs.len() >= 4 {
        let (slope, _) = linear_regression(&xs, &ys);
        learnt.riegel_k = Some((-slope).clamp(0.04, 0.15));
    }

    let all: Vec<&Chunk> = per_activity.iter().flatten().collect();

    // ── Walk threshold: first 2 % grade bin where most slices are walked ──
    let uphill: Vec<&&Chunk> = all.iter().filter(|c| c.grade_pct > 3.0).collect();
    if uphill.len() >= 30 {
        let mut threshold = None;
        let mut g = 4.0;
        while g < 40.0 {
            let bin: Vec<&&&Chunk> = uphill
                .iter()
                .filter(|c| c.grade_pct >= g && c.grade_pct < g + 2.0)
                .collect();
            if bin.len() >= 5 {
                let walked = bin.iter().filter(|c| c.walking).count() as f64 / bin.len() as f64;
                if walked >= 0.5 {
                    threshold = Some(g + 1.0);
                    break;
                }
            }
            g += 2.0;
        }
        learnt.walk_threshold_pct = threshold.map(|t: f64| t.clamp(5.0, 30.0));
    }

    // ── Power-hiking vertical rate on steep walked slices ──
    let mut vams: Vec<f64> = all
        .iter()
        .filter(|c| c.walking && c.grade_pct >= 10.0)
        .map(|c| c.ele_gain_m / c.dt_s * 3600.0)
        .collect();
    if vams.len() >= 10 {
        learnt.walk_vam_mh = Some(median(&mut vams).clamp(250.0, 1800.0));
    }

    // ── Descent skill: actual downhill speed vs the default model ──
    if let Some(v_ref) = learnt.v_ref_ms {
        let mut ratios: Vec<f64> = all
            .iter()
            .filter(|c| !c.walking && c.grade_pct <= -8.0 && c.start_h < 3.0)
            .map(|c| {
                let model = super::descent_speed_ms(
                    v_ref * super::terrain_factor(technicality, discipline),
                    c.grade_pct,
                    technicality,
                    preset.descent_skill,
                    discipline,
                );
                c.speed_ms() / model
            })
            .collect();
        if ratios.len() >= 10 {
            learnt.descent_ratio = Some(median(&mut ratios).clamp(0.6, 1.4));
        }
    }

    learnt
}

/// Resolve the runner profile from, in order: FIT files, a reference race,
/// VMA, then the level preset alone.
pub fn build_runner_profile(
    activities: &[ActivityData],
    cfg: &RunPredictionConfig,
    n_ignored: usize,
) -> (RunnerProfile, LevelPreset) {
    let preset = level_preset(cfg.level.as_deref());
    let technicality = cfg.effective_technicality();
    let learnt = learn_from_activities(activities, &preset, technicality, cfg.discipline);

    let (v_ref_ms, source) = if let Some(v) = learnt.v_ref_ms {
        (v, "fit")
    } else if let Some(v) = cfg
        .ref_distance_m
        .zip(cfg.ref_time_s)
        .and_then(|(d, t)| hour_speed_from_race(d, t))
    {
        (v, "chrono")
    } else if let Some(vma) = cfg.vma_kmh.filter(|v| (6.0..=30.0).contains(v)) {
        (vma / 3.6 * VMA_TO_HOUR_FRACTION, "vma")
    } else {
        // Population prior only: women run ~10 % slower on average at the
        // same practice level; an explicit reference already reflects it.
        let gender = if cfg.gender == Gender::Female { 0.90 } else { 1.0 };
        (preset.v_ref_kmh / 3.6 * gender, "level")
    };

    // Power-hiking ability scales with running fitness when it is not learnt.
    let fitness_ratio = (v_ref_ms * 3.6 / preset.v_ref_kmh).clamp(0.7, 1.4);
    let walk_vam_mh = learnt.walk_vam_mh.unwrap_or(preset.walk_vam_mh * fitness_ratio);

    let base_k = learnt.riegel_k.unwrap_or(preset.riegel_k);
    let riegel_k = if cfg.discipline == RunDiscipline::Trail && learnt.riegel_k.is_none() {
        base_k + TRAIL_EXTRA_K
    } else {
        base_k
    };

    let profile = RunnerProfile {
        v_ref_kmh: v_ref_ms * 3.6,
        v_ref_source: source.to_string(),
        riegel_k,
        walk_threshold_pct: learnt.walk_threshold_pct.unwrap_or(preset.walk_threshold_pct),
        walk_vam_mh,
        descent_ratio: learnt.descent_ratio.unwrap_or(1.0),
        descent_skill: preset.descent_skill,
        technicality,
        n_activities: activities.len(),
        n_ignored,
        knn_samples: 0,
    };
    (profile, preset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn riegel_hour_speed_from_10k() {
        // 10 km in 50 min → ~11.6 km/h for one hour.
        let v = hour_speed_from_race(10_000.0, 3000.0).unwrap() * 3.6;
        assert!(v > 11.3 && v < 11.9, "{v}");
    }
}
