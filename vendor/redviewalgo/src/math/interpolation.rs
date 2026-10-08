/// Filtre médian sur les altitudes pour retirer les erreurs de DEM / GPS d'un
/// seul échantillon avant tout autre lissage. Utilise une petite fenêtre impaire
/// (en général 5) sur l'espace des indices d'altitude (peu coûteux, sans
/// recherche de distance). Une médiane résiste aux valeurs aberrantes isolées —
/// p. ex. une erreur GPS de +500 m sur un échantillon — contrairement au
/// lissage gaussien, qui ne ferait qu'atténuer le pic et l'étaler sur les voisins.
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

/// Moyenne glissante pondérée par une gaussienne en O(n) sur les altitudes.
/// Approche à deux pointeurs pour un lissage par fenêtre efficace.
/// `window_distance_m` règle le rayon de lissage le long de la distance cumulée.
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

