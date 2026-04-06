/// O(n) sliding-window Gaussian-weighted moving average on elevations.
/// Uses two-pointer approach for efficient windowed smoothing.
/// `window_distance_m` controls the smoothing radius along cumulative distance.
pub fn smooth_elevations(
    elevations: &[f64],
    distances: &[f64],
    window_distance_m: f64,
) -> Vec<f64> {
    let n = elevations.len();
    if n == 0 {
        return vec![];
    }
    if n == 1 {
        return vec![elevations[0]];
    }

    let sigma = window_distance_m / 2.0;
    let sigma2 = 2.0 * sigma * sigma;
    let mut smoothed = Vec::with_capacity(n);

    let mut left = 0usize;
    let mut right = 0usize;

    for i in 0..n {
        let d_i = distances[i];

        while right < n && distances[right] - d_i <= window_distance_m {
            right += 1;
        }
        while left < n && d_i - distances[left] > window_distance_m {
            left += 1;
        }

        let mut weight_sum = 0.0;
        let mut value_sum = 0.0;

        for j in left..right {
            let dd = distances[j] - d_i;
            let w = (-dd * dd / sigma2).exp();
            weight_sum += w;
            value_sum += w * elevations[j];
        }

        if weight_sum > 0.0 {
            smoothed.push(value_sum / weight_sum);
        } else {
            smoothed.push(elevations[i]);
        }
    }

    smoothed
}

/// Monotone cubic interpolation (Fritsch-Carlson method).
/// Given sorted (xs, ys) knots, interpolate at x.
/// Clamps to boundary values outside the data range.
pub fn monotone_cubic_interp(xs: &[f64], ys: &[f64], x: f64) -> f64 {
    let n = xs.len();
    if n == 0 {
        return 0.0;
    }
    if n == 1 {
        return ys[0];
    }
    if x <= xs[0] {
        return ys[0];
    }
    if x >= xs[n - 1] {
        return ys[n - 1];
    }

    // Compute secants
    let mut deltas: Vec<f64> = Vec::with_capacity(n - 1);
    for i in 0..n - 1 {
        let dx = xs[i + 1] - xs[i];
        if dx.abs() < 1e-12 {
            deltas.push(0.0);
        } else {
            deltas.push((ys[i + 1] - ys[i]) / dx);
        }
    }

    // Compute tangents using Fritsch-Carlson
    let mut ms: Vec<f64> = vec![0.0; n];
    ms[0] = deltas[0];
    ms[n - 1] = deltas[n - 2];
    for i in 1..n - 1 {
        if deltas[i - 1] * deltas[i] <= 0.0 {
            ms[i] = 0.0;
        } else {
            ms[i] = (deltas[i - 1] + deltas[i]) / 2.0;
        }
    }

    // Fritsch-Carlson monotonicity correction
    for i in 0..n - 1 {
        if deltas[i].abs() < 1e-12 {
            ms[i] = 0.0;
            ms[i + 1] = 0.0;
        } else {
            let alpha = ms[i] / deltas[i];
            let beta = ms[i + 1] / deltas[i];
            let norm = alpha * alpha + beta * beta;
            if norm > 9.0 {
                let tau = 3.0 / norm.sqrt();
                ms[i] = tau * alpha * deltas[i];
                ms[i + 1] = tau * beta * deltas[i];
            }
        }
    }

    // Find interval
    let mut k = 0;
    for i in 0..n - 1 {
        if x >= xs[i] && x < xs[i + 1] {
            k = i;
            break;
        }
    }

    // Hermite basis
    let h = xs[k + 1] - xs[k];
    let t = (x - xs[k]) / h;
    let t2 = t * t;
    let t3 = t2 * t;

    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;

    h00 * ys[k] + h10 * h * ms[k] + h01 * ys[k + 1] + h11 * h * ms[k + 1]
}

/// Pre-computed monotone cubic spline for O(log N) repeated lookups.
/// Build once, evaluate many times without re-computing tangents.
#[derive(Debug, Clone)]
pub struct MonotoneSpline {
    xs: Vec<f64>,
    ys: Vec<f64>,
    ms: Vec<f64>, // pre-computed tangents
}

impl MonotoneSpline {
    /// Build a pre-computed spline from sorted (xs, ys) knots.
    /// O(N) construction, O(log N) evaluation.
    pub fn build(xs: Vec<f64>, ys: Vec<f64>) -> Self {
        let n = xs.len();
        if n < 2 {
            return MonotoneSpline { xs, ys, ms: vec![0.0; n] };
        }

        // Compute secants
        let mut deltas: Vec<f64> = Vec::with_capacity(n - 1);
        for i in 0..n - 1 {
            let dx = xs[i + 1] - xs[i];
            if dx.abs() < 1e-12 {
                deltas.push(0.0);
            } else {
                deltas.push((ys[i + 1] - ys[i]) / dx);
            }
        }

        // Compute tangents using Fritsch-Carlson
        let mut ms = vec![0.0; n];
        ms[0] = deltas[0];
        ms[n - 1] = deltas[n - 2];
        for i in 1..n - 1 {
            if deltas[i - 1] * deltas[i] <= 0.0 {
                ms[i] = 0.0;
            } else {
                ms[i] = (deltas[i - 1] + deltas[i]) / 2.0;
            }
        }

        // Fritsch-Carlson monotonicity correction
        for i in 0..n - 1 {
            if deltas[i].abs() < 1e-12 {
                ms[i] = 0.0;
                ms[i + 1] = 0.0;
            } else {
                let alpha = ms[i] / deltas[i];
                let beta = ms[i + 1] / deltas[i];
                let norm = alpha * alpha + beta * beta;
                if norm > 9.0 {
                    let tau = 3.0 / norm.sqrt();
                    ms[i] = tau * alpha * deltas[i];
                    ms[i + 1] = tau * beta * deltas[i];
                }
            }
        }

        MonotoneSpline { xs, ys, ms }
    }

    /// Evaluate the spline at x. O(log N) via binary search.
    #[inline]
    pub fn eval(&self, x: f64) -> f64 {
        let n = self.xs.len();
        if n == 0 { return 0.0; }
        if n == 1 { return self.ys[0]; }
        if x <= self.xs[0] { return self.ys[0]; }
        if x >= self.xs[n - 1] { return self.ys[n - 1]; }

        // Binary search for interval
        let k = match self.xs.binary_search_by(|v| v.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)) {
            Ok(i) => i.min(n - 2),
            Err(i) => if i > 0 { i - 1 } else { 0 },
        };

        let h = self.xs[k + 1] - self.xs[k];
        let t = (x - self.xs[k]) / h;
        let t2 = t * t;
        let t3 = t2 * t;

        let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 = t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 = t3 - t2;

        h00 * self.ys[k] + h10 * h * self.ms[k] + h01 * self.ys[k + 1] + h11 * h * self.ms[k + 1]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_monotone_cubic_interp() {
        let xs = vec![-5.0, 0.0, 5.0, 10.0, 15.0];
        let ys = vec![14.0, 8.0, 3.5, 2.0, 1.2];

        let v = monotone_cubic_interp(&xs, &ys, 2.5);
        assert!(v > 3.5 && v < 8.0, "Interp at 2.5%: got {v}");

        let v_low = monotone_cubic_interp(&xs, &ys, -10.0);
        assert!((v_low - 14.0).abs() < 0.01, "Below range: got {v_low}");

        let v_high = monotone_cubic_interp(&xs, &ys, 20.0);
        assert!((v_high - 1.2).abs() < 0.01, "Above range: got {v_high}");
    }
}
