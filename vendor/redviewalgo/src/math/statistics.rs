/// Compute median of a mutable slice (sorts in-place).
pub fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    }
}

/// Standard deviation of a slice.
pub fn std_dev(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let variance =
        values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
    variance.sqrt()
}

/// Simple linear regression: returns (slope, intercept).
pub fn linear_regression(xs: &[f64], ys: &[f64]) -> (f64, f64) {
    let n = xs.len() as f64;
    if n < 2.0 {
        return (0.0, ys.first().copied().unwrap_or(0.0));
    }
    let sum_x: f64 = xs.iter().sum();
    let sum_y: f64 = ys.iter().sum();
    let sum_xy: f64 = xs.iter().zip(ys.iter()).map(|(x, y)| x * y).sum();
    let sum_x2: f64 = xs.iter().map(|x| x * x).sum();

    let denom = n * sum_x2 - sum_x * sum_x;
    if denom.abs() < 1e-12 {
        return (0.0, sum_y / n);
    }

    let slope = (n * sum_xy - sum_x * sum_y) / denom;
    let intercept = (sum_y - slope * sum_x) / n;
    (slope, intercept)
}

/// Compute the p-th percentile of a mutable slice (p in 0.0..1.0).
/// Sorts in-place, uses linear interpolation.
pub fn percentile(values: &mut [f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if values.len() == 1 {
        return values[0];
    }
    let idx = p * (values.len() - 1) as f64;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    let frac = idx - lo as f64;
    if lo == hi {
        values[lo]
    } else {
        values[lo] * (1.0 - frac) + values[hi] * frac
    }
}

/// Fit asymptotic decay: y = floor + (a − floor) · e^(−λ·x)
/// Uses grid search over floor values then log-linear regression on shifted data.
/// Returns (a, lambda, floor).
///
/// Uses 0.01 step grid (51 candidates) for finer resolution than the original 0.05.
pub fn fit_asymptotic_decay(xs: &[f64], ys: &[f64]) -> (f64, f64, f64) {
    if xs.len() < 3 {
        return (1.0, 0.02, 0.60);
    }

    let mut best_floor = 0.60;
    let mut best_sse = f64::MAX;
    let mut best_a = 1.0;
    let mut best_lambda = 0.02;

    // Estimate floor from data: average of last-third performance values
    let n = ys.len();
    let last_third_start = n * 2 / 3;
    let data_floor_estimate = if last_third_start < n {
        let last_vals: Vec<f64> = ys[last_third_start..]
            .iter()
            .copied()
            .filter(|v| *v > 0.0)
            .collect();
        if !last_vals.is_empty() {
            (last_vals.iter().sum::<f64>() / last_vals.len() as f64).clamp(0.35, 0.90)
        } else {
            0.60
        }
    } else {
        0.60
    };

    // IMPROVED: 0.01 step grid (51 candidates) + data estimate for finer resolution
    let mut floor_candidates: Vec<f64> = (35..=85).map(|i| i as f64 * 0.01).collect();
    floor_candidates.push(data_floor_estimate);

    for floor in &floor_candidates {
        let shifted: Vec<(f64, f64)> = xs
            .iter()
            .zip(ys.iter())
            .filter(|(_, y)| **y - floor > 0.01)
            .map(|(x, y)| (*x, *y - floor))
            .collect();

        if shifted.len() < 2 {
            continue;
        }

        let log_zs: Vec<f64> = shifted.iter().map(|(_, z)| z.ln()).collect();
        let filt_xs: Vec<f64> = shifted.iter().map(|(x, _)| *x).collect();

        let (slope, intercept) = linear_regression(&filt_xs, &log_zs);
        let a_shifted = intercept.exp();
        let lambda = (-slope).max(0.0);
        let a = a_shifted + floor;

        let sse: f64 = xs
            .iter()
            .zip(ys.iter())
            .map(|(x, y)| {
                let predicted = floor + (a - floor) * (-lambda * x).exp();
                (y - predicted).powi(2)
            })
            .sum();

        if sse < best_sse {
            best_sse = sse;
            best_floor = *floor;
            best_a = a;
            best_lambda = lambda;
        }
    }

    (best_a, best_lambda, best_floor)
}

/// Fit bi-exponential fatigue model:
///   y = floor + A · e^(−λ₁·x) + B · e^(−λ₂·x)
///
/// Fast component (λ₁ ~0.3-1.0): neuromuscular fatigue, drops quickly in 2-4h
/// Slow component (λ₂ ~0.01-0.05): metabolic fatigue, gradual over 10-30h
///
/// Returns (floor, A, lambda1, B, lambda2).
///
/// IMPROVED for ultra-distance:
///   - Finer grid (~3000 combos)
///   - Weighted SSE: emphasises tail data (critical for 1000km+ accuracy)
///   - Robust floor from 25th percentile of last-quarter
///   - Nelder-Mead simplex refinement of best grid candidate
pub fn fit_biexponential_decay(xs: &[f64], ys: &[f64]) -> (f64, f64, f64, f64, f64) {
    if xs.len() < 5 {
        return (0.55, 0.25, 0.5, 0.20, 0.02);
    }

    let n = ys.len();
    let x_max = xs.iter().cloned().fold(0.0_f64, f64::max).max(1.0);

    // Robust floor estimate: 25th percentile of last quarter (more resistant to outliers)
    let tail_start = n * 3 / 4;
    let floor_estimate = if tail_start < n {
        let mut tail: Vec<f64> = ys[tail_start..].iter().copied().filter(|v| *v > 0.0).collect();
        if tail.len() >= 2 {
            percentile(&mut tail, 0.25).clamp(0.30, 0.80)
        } else if !tail.is_empty() {
            tail[0].clamp(0.30, 0.80)
        } else {
            0.55
        }
    } else {
        0.55
    };

    // Precompute weights: emphasise tail data for ultra-distance accuracy
    // Weight = 1 + 0.5 * (x / x_max) — tail points get up to 1.5× importance
    let weights: Vec<f64> = xs.iter().map(|x| 1.0 + 0.5 * (x / x_max)).collect();

    let mut best_sse = f64::MAX;
    let mut best_params = (floor_estimate, 0.25, 0.5, 0.20, 0.02);

    // Finer grid: floor(step 3%) × lambda1(10 values) × lambda2(9 values)
    let floor_candidates: Vec<f64> = {
        let mut v: Vec<f64> = (25..=78).step_by(3).map(|i| i as f64 * 0.01).collect();
        v.push(floor_estimate);
        // Also add ±0.03 around data estimate
        v.push((floor_estimate - 0.03).max(0.25));
        v.push((floor_estimate + 0.03).min(0.80));
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v.dedup();
        v
    };
    let lambda1_candidates = [0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.2, 1.5, 2.0];
    let lambda2_candidates = [0.003, 0.005, 0.008, 0.01, 0.015, 0.02, 0.03, 0.05, 0.08];

    for &floor in &floor_candidates {
        for &l1 in &lambda1_candidates {
            for &l2 in &lambda2_candidates {
                if l1 <= l2 {
                    continue;
                }

                // Solve A, B via weighted least squares:
                // w_i · (y_i - floor) = A · w_i · e^(-l1·x_i) + B · w_i · e^(-l2·x_i)
                let mut sum_we1e1 = 0.0;
                let mut sum_we1e2 = 0.0;
                let mut sum_we2e2 = 0.0;
                let mut sum_wye1 = 0.0;
                let mut sum_wye2 = 0.0;

                for i in 0..n {
                    let w = weights[i];
                    let e1 = (-l1 * xs[i]).exp();
                    let e2 = (-l2 * xs[i]).exp();
                    let z = ys[i] - floor;
                    sum_we1e1 += w * e1 * e1;
                    sum_we1e2 += w * e1 * e2;
                    sum_we2e2 += w * e2 * e2;
                    sum_wye1 += w * z * e1;
                    sum_wye2 += w * z * e2;
                }

                let det = sum_we1e1 * sum_we2e2 - sum_we1e2 * sum_we1e2;
                if det.abs() < 1e-12 {
                    continue;
                }

                let a = (sum_wye1 * sum_we2e2 - sum_wye2 * sum_we1e2) / det;
                let b = (sum_wye2 * sum_we1e1 - sum_wye1 * sum_we1e2) / det;

                if a < 0.005 || b < 0.005 {
                    continue;
                }

                // Weighted SSE
                let sse: f64 = (0..n)
                    .map(|i| {
                        let pred = floor + a * (-l1 * xs[i]).exp() + b * (-l2 * xs[i]).exp();
                        weights[i] * (ys[i] - pred).powi(2)
                    })
                    .sum();

                if sse < best_sse {
                    best_sse = sse;
                    best_params = (floor, a, l1, b, l2);
                }
            }
        }
    }

    // Nelder-Mead simplex refinement on (floor, l1, l2)
    // A and B are always solved analytically for each (floor, l1, l2) combo
    best_params = nelder_mead_biexp(xs, ys, &weights, best_params);

    best_params
}

/// Nelder-Mead simplex refinement for bi-exponential (floor, λ₁, λ₂).
/// A and B are solved analytically via weighted least squares at each evaluation.
fn nelder_mead_biexp(
    xs: &[f64],
    ys: &[f64],
    weights: &[f64],
    initial: (f64, f64, f64, f64, f64),
) -> (f64, f64, f64, f64, f64) {
    let (init_floor, _init_a, init_l1, _init_b, init_l2) = initial;
    let n = xs.len();

    // Evaluate: given [floor, l1, l2], solve A/B analytically, return (sse, floor, a, l1, b, l2)
    let evaluate = |params: &[f64; 3]| -> (f64, f64, f64, f64, f64, f64) {
        let floor = params[0];
        let l1 = params[1];
        let l2 = params[2];

        if floor < 0.2 || floor > 0.85 || l1 < 0.05 || l1 > 3.0 || l2 < 0.001 || l2 > 0.15 || l1 <= l2 {
            return (f64::MAX, floor, 0.0, l1, 0.0, l2);
        }

        let mut sum_we1e1 = 0.0;
        let mut sum_we1e2 = 0.0;
        let mut sum_we2e2 = 0.0;
        let mut sum_wye1 = 0.0;
        let mut sum_wye2 = 0.0;

        for i in 0..n {
            let w = weights[i];
            let e1 = (-l1 * xs[i]).exp();
            let e2 = (-l2 * xs[i]).exp();
            let z = ys[i] - floor;
            sum_we1e1 += w * e1 * e1;
            sum_we1e2 += w * e1 * e2;
            sum_we2e2 += w * e2 * e2;
            sum_wye1 += w * z * e1;
            sum_wye2 += w * z * e2;
        }

        let det = sum_we1e1 * sum_we2e2 - sum_we1e2 * sum_we1e2;
        if det.abs() < 1e-12 {
            return (f64::MAX, floor, 0.0, l1, 0.0, l2);
        }

        let a = (sum_wye1 * sum_we2e2 - sum_wye2 * sum_we1e2) / det;
        let b = (sum_wye2 * sum_we1e1 - sum_wye1 * sum_we1e2) / det;

        if a < 0.005 || b < 0.005 {
            return (f64::MAX, floor, a, l1, b, l2);
        }

        let sse: f64 = (0..n)
            .map(|i| {
                let pred = floor + a * (-l1 * xs[i]).exp() + b * (-l2 * xs[i]).exp();
                weights[i] * (ys[i] - pred).powi(2)
            })
            .sum();

        (sse, floor, a, l1, b, l2)
    };

    // Initialize simplex: 4 vertices in 3D space (floor, l1, l2)
    let delta = [0.03, 0.15, 0.008]; // perturbation sizes
    let base = [init_floor, init_l1, init_l2];
    let mut simplex: Vec<([f64; 3], f64, (f64, f64, f64, f64, f64))> = Vec::with_capacity(4);

    let eval0 = evaluate(&base);
    simplex.push((base, eval0.0, (eval0.1, eval0.2, eval0.3, eval0.4, eval0.5)));

    for d in 0..3 {
        let mut vertex = base;
        vertex[d] += delta[d];
        let ev = evaluate(&vertex);
        simplex.push((vertex, ev.0, (ev.1, ev.2, ev.3, ev.4, ev.5)));
    }

    let max_iter = 80;
    let tol = 1e-10;
    let alpha = 1.0; // reflection
    let gamma = 2.0; // expansion
    let rho = 0.5;   // contraction
    let sigma = 0.5;  // shrink

    for _ in 0..max_iter {
        // Sort by SSE
        simplex.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

        // Convergence check
        let spread = simplex[3].1 - simplex[0].1;
        if spread < tol {
            break;
        }

        // Centroid of best 3
        let mut centroid = [0.0; 3];
        for s in &simplex[..3] {
            for d in 0..3 {
                centroid[d] += s.0[d] / 3.0;
            }
        }

        // Reflection
        let worst = &simplex[3].0;
        let mut reflected = [0.0; 3];
        for d in 0..3 {
            reflected[d] = centroid[d] + alpha * (centroid[d] - worst[d]);
        }
        let ev_r = evaluate(&reflected);

        if ev_r.0 < simplex[2].1 && ev_r.0 >= simplex[0].1 {
            simplex[3] = (reflected, ev_r.0, (ev_r.1, ev_r.2, ev_r.3, ev_r.4, ev_r.5));
            continue;
        }

        if ev_r.0 < simplex[0].1 {
            // Expansion
            let mut expanded = [0.0; 3];
            for d in 0..3 {
                expanded[d] = centroid[d] + gamma * (reflected[d] - centroid[d]);
            }
            let ev_e = evaluate(&expanded);
            if ev_e.0 < ev_r.0 {
                simplex[3] = (expanded, ev_e.0, (ev_e.1, ev_e.2, ev_e.3, ev_e.4, ev_e.5));
            } else {
                simplex[3] = (reflected, ev_r.0, (ev_r.1, ev_r.2, ev_r.3, ev_r.4, ev_r.5));
            }
            continue;
        }

        // Contraction
        let mut contracted = [0.0; 3];
        let ref_pt = if ev_r.0 < simplex[3].1 { &reflected } else { &simplex[3].0 };
        for d in 0..3 {
            contracted[d] = centroid[d] + rho * (ref_pt[d] - centroid[d]);
        }
        let ev_c = evaluate(&contracted);
        let compare_sse = if ev_r.0 < simplex[3].1 { ev_r.0 } else { simplex[3].1 };
        if ev_c.0 < compare_sse {
            simplex[3] = (contracted, ev_c.0, (ev_c.1, ev_c.2, ev_c.3, ev_c.4, ev_c.5));
            continue;
        }

        // Shrink
        let best = simplex[0].0;
        for i in 1..4 {
            for d in 0..3 {
                simplex[i].0[d] = best[d] + sigma * (simplex[i].0[d] - best[d]);
            }
            let ev = evaluate(&simplex[i].0);
            simplex[i].1 = ev.0;
            simplex[i].2 = (ev.1, ev.2, ev.3, ev.4, ev.5);
        }
    }

    simplex.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    simplex[0].2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_median() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&mut [4.0, 1.0, 3.0, 2.0]), 2.5);
    }

    #[test]
    fn test_percentile() {
        let mut vals = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        assert!((percentile(&mut vals, 0.5) - 3.0).abs() < 0.01);
        let mut vals2 = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let p60 = percentile(&mut vals2, 0.6);
        assert!(p60 > 3.0 && p60 < 4.0, "60th percentile: got {p60}");
    }

    #[test]
    fn test_fit_asymptotic_decay() {
        let xs: Vec<f64> = (0..20).map(|i| i as f64).collect();
        let ys: Vec<f64> = xs
            .iter()
            .map(|x| 0.55 + 0.45 * (-0.1 * x).exp())
            .collect();

        let (a, lambda, floor) = fit_asymptotic_decay(&xs, &ys);

        assert!(
            (floor - 0.55).abs() < 0.1,
            "floor: expected ~0.55, got {floor}"
        );
        assert!((a - 1.0).abs() < 0.15, "a: expected ~1.0, got {a}");
        assert!(
            (lambda - 0.1).abs() < 0.05,
            "lambda: expected ~0.1, got {lambda}"
        );
    }

    #[test]
    fn test_fit_biexponential_decay() {
        // Generate data: y = 0.50 + 0.25·e^(-0.5·x) + 0.25·e^(-0.02·x)
        let xs: Vec<f64> = (0..50).map(|i| i as f64 * 0.5).collect();
        let ys: Vec<f64> = xs
            .iter()
            .map(|x| 0.50 + 0.25 * (-0.5 * x).exp() + 0.25 * (-0.02 * x).exp())
            .collect();

        let (floor, a, l1, b, l2) = fit_biexponential_decay(&xs, &ys);

        // Verify the fit captures the general shape
        assert!(floor > 0.30 && floor < 0.65, "floor: got {floor}");
        assert!(a > 0.0, "A should be positive: got {a}");
        assert!(b > 0.0, "B should be positive: got {b}");
        assert!(l1 > l2, "lambda1 ({l1}) should be > lambda2 ({l2})");

        // Verify prediction accuracy at key points
        let pred_0 = floor + a * (-l1 * 0.0_f64).exp() + b * (-l2 * 0.0_f64).exp();
        assert!(
            (pred_0 - 1.0).abs() < 0.15,
            "At t=0: expected ~1.0, got {pred_0}"
        );
    }
}
