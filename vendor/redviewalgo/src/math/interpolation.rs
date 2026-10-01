/// Median filter on elevations to remove single-sample DEM/GPS glitches
/// before any further smoothing. Uses a small odd window (typically 5)
/// over the elevation index space (cheap, no distance lookup needed). A
/// median is robust to single isolated outliers \u2014 e.g. a +500\u00a0m GPS
/// glitch on one sample \u2014 unlike Gaussian smoothing which would only
/// attenuate and spread the spike across neighbours.
pub fn median_filter_elevations(elevations: &[f64], window: usize) -> Vec<f64> {
    let n = elevations.len();
    if n == 0 {
        return vec![];
    }
    let w = window.max(3) | 1; // ensure odd, minimum 3
    if n < w {
        return elevations.to_vec();
    }
    let half = w / 2;
    let mut out = Vec::with_capacity(n);
    let mut buf: Vec<f64> = Vec::with_capacity(w);
    for i in 0..n {
        let lo = i.saturating_sub(half);
        let hi = (i + half + 1).min(n);
        buf.clear();
        buf.extend_from_slice(&elevations[lo..hi]);
        buf.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        out.push(buf[buf.len() / 2]);
    }
    out
}

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

