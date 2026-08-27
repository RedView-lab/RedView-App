use crate::math::{fit_asymptotic_decay, fit_biexponential_decay};
use crate::types::{ActivityData, FatigueModel};

/// Build fatigue model by analyzing performance decay over time in each activity.
///
/// IMPROVED: Uses bi-exponential model for activities > 6h for better ultra fit.
/// Uses asymptotic single-exponential for shorter activities.
/// The bi-exponential captures both neuromuscular (fast) and metabolic (slow) fatigue.
pub fn build_fatigue_model(activities: &[ActivityData], has_power: bool) -> FatigueModel {
    let mut time_perf: Vec<(f64, f64)> = Vec::new();

    for activity in activities {
        let pts = &activity.points;
        let duration_h = activity.summary.duration_s / 3600.0;
        if duration_h < 1.0 {
            continue;
        }

        let chunk_s = 1800.0; // 30-min chunks
        let num_chunks = ((activity.summary.duration_s / chunk_s).ceil() as usize).max(1);
        let mut chunk_perfs: Vec<(f64, f64)> = Vec::with_capacity(num_chunks);

        // Single pass over the points, accumulating per-chunk statistics.
        // (The previous version filtered all points per chunk, which is
        // O(chunks × points) — quadratic-ish on long FIT files.)
        let mut counts = vec![0usize; num_chunks];
        let mut power_sums = vec![0.0_f64; num_chunks];
        let mut power_ns = vec![0usize; num_chunks];
        let mut flat_speed_sums = vec![0.0_f64; num_chunks];
        let mut flat_speed_ns = vec![0usize; num_chunks];

        for i in 0..pts.len() {
            let p = &pts[i];
            let t = p.timestamp_s;
            if t < 0.0 {
                continue;
            }
            let mut c = (t / chunk_s) as usize;
            if c >= num_chunks {
                c = num_chunks - 1;
            }
            counts[c] += 1;
            if p.power_w > 0.0 {
                power_sums[c] += p.power_w;
                power_ns[c] += 1;
            }
            if i > 0 {
                let dist = p.distance_m - pts[i - 1].distance_m;
                if dist >= 1.0 {
                    // Use speed for "near-flat" segments as performance metric
                    let grad = (p.altitude_m - pts[i - 1].altitude_m) / dist;
                    if grad.abs() < 0.02 && p.speed_ms > 1.0 {
                        flat_speed_sums[c] += p.speed_ms;
                        flat_speed_ns[c] += 1;
                    }
                }
            }
        }

        for c in 0..num_chunks {
            if counts[c] < 10 {
                continue;
            }

            let performance = if has_power {
                if power_ns[c] == 0 {
                    continue;
                }
                power_sums[c] / power_ns[c] as f64
            } else {
                if flat_speed_ns[c] == 0 {
                    continue;
                }
                flat_speed_sums[c] / flat_speed_ns[c] as f64
            };

            let t_start = c as f64 * chunk_s;
            let elapsed_h = (t_start + chunk_s / 2.0) / 3600.0;
            chunk_perfs.push((elapsed_h, performance));
        }

        if chunk_perfs.len() < 3 {
            continue;
        }

        // Normalise by first chunk performance
        let baseline = chunk_perfs[0].1;
        if baseline <= 0.0 {
            continue;
        }

        for (t, perf) in &chunk_perfs {
            time_perf.push((*t, perf / baseline));
        }
    }

    if time_perf.len() < 4 {
        return FatigueModel {
            decay_lambda: 0.03,
            baseline: 1.0,
            floor: 0.52,
            ultra_floor: Some(0.65),
            fast_amplitude: None,
            fast_lambda: None,
            slow_amplitude: None,
            slow_lambda: None,
        };
    }

    let xs: Vec<f64> = time_perf.iter().map(|(t, _)| *t).collect();
    let ys: Vec<f64> = time_perf.iter().map(|(_, p)| *p).collect();

    let max_training_h = xs.iter().cloned().fold(0.0_f64, f64::max);

    // Bi-exponential: preserve full dual-phase dynamics for ultra-distance
    // Fast component captures neuromuscular fatigue (2-4h half-life)
    // Slow component captures metabolic fatigue (10-30h half-life)
    if max_training_h > 6.0 && time_perf.len() >= 10 {
        let (floor, a, lambda1, b, lambda2) = fit_biexponential_decay(&xs, &ys);

        let clamped_floor = floor.clamp(0.35, 0.80);
        let clamped_a = a.clamp(0.0, 0.6);
        let clamped_b = b.clamp(0.0, 0.6);

        // Data-driven ultra floor: use actual fatigued chunks (>8h) to estimate
        // sustainable performance at ultra durations instead of fixed +0.15 offset.
        let late_perfs: Vec<f64> = time_perf.iter()
            .filter(|(t, _)| *t > 8.0)
            .map(|(_, p)| *p)
            .collect();
        let ultra_floor = if late_perfs.len() >= 5 {
            // Use 25th percentile of late performance as sustainable floor
            let mut sorted = late_perfs.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p25 = sorted[sorted.len() / 4];
            p25.clamp(0.55, 0.85)
        } else {
            // Not enough ultra data: fall back to model-based estimate
            (clamped_floor + 0.12).clamp(0.62, 0.82)
        };

        // Also compute single-exp fallback from the slow component for compatibility
        let effective_baseline = clamped_floor + clamped_a + clamped_b;

        FatigueModel {
            decay_lambda: lambda2.clamp(0.005, 0.2),
            baseline: effective_baseline.clamp(0.8, 1.2),
            floor: clamped_floor,
            ultra_floor: Some(ultra_floor),
            fast_amplitude: Some(clamped_a),
            fast_lambda: Some(lambda1.clamp(0.1, 2.0)),
            slow_amplitude: Some(clamped_b),
            slow_lambda: Some(lambda2.clamp(0.005, 0.2)),
        }
    } else {
        // Single exponential fit — no bi-exp params
        let (a, lambda, floor) = fit_asymptotic_decay(&xs, &ys);

        let corrected_lambda = if max_training_h < 6.0 {
            lambda.max(0.025)
        } else if max_training_h < 12.0 {
            lambda.max(0.02)
        } else {
            lambda
        };

        let corrected_floor = if max_training_h < 6.0 {
            floor.min(0.55)
        } else if max_training_h < 12.0 {
            floor.min(0.60)
        } else {
            floor
        };

        // Data-driven ultra floor for single-exp
        let late_perfs: Vec<f64> = time_perf.iter()
            .filter(|(t, _)| *t > 6.0)
            .map(|(_, p)| *p)
            .collect();
        let ultra_floor = if late_perfs.len() >= 3 {
            let mut sorted = late_perfs.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p25 = sorted[sorted.len() / 4];
            p25.clamp(0.55, 0.85)
        } else {
            (corrected_floor.clamp(0.35, 0.80) + 0.12).clamp(0.62, 0.82)
        };

        FatigueModel {
            decay_lambda: corrected_lambda.clamp(0.005, 0.2),
            baseline: a.clamp(0.8, 1.2),
            floor: corrected_floor.clamp(0.35, 0.80),
            ultra_floor: Some(ultra_floor),
            fast_amplitude: None,
            fast_lambda: None,
            slow_amplitude: None,
            slow_lambda: None,
        }
    }
}
