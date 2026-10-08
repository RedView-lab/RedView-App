use crate::math::gradient_pct;
use crate::types::ActivityData;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Poids des caractéristiques — importance relative de chaque caractéristique dans le calcul de distance.
/// Ce sont les poids par défaut ; ils peuvent être optimisés par validation croisée dans `optimize_feature_weights()`.
const WEIGHT_GRADIENT: f64 = 3.0;
const WEIGHT_ELAPSED_H: f64 = 2.5;
const WEIGHT_CUM_CLIMB: f64 = 2.2;     // ↑ from 1.2: D+ state is critical for speed prediction
const WEIGHT_RECENT_GRAD: f64 = 2.0;   // ↑ from 1.5: recent terrain has strong speed impact
const WEIGHT_ELEVATION: f64 = 0.8;     // ↑ from 0.3: altitude matters more (air density + fatigue)
const WEIGHT_CUM_DISTANCE: f64 = 1.5;
const WEIGHT_HEART_RATE: f64 = 2.0;
const WEIGHT_TEMPERATURE: f64 = 1.0;

/// Tableau des poids par défaut, par commodité.
pub const DEFAULT_WEIGHTS: [f64; N_FEATURES] = [
    WEIGHT_GRADIENT,
    WEIGHT_ELAPSED_H,
    WEIGHT_CUM_CLIMB,
    WEIGHT_RECENT_GRAD,
    WEIGHT_ELEVATION,
    WEIGHT_CUM_DISTANCE,
    WEIGHT_HEART_RATE,
    WEIGHT_TEMPERATURE,
];

/// Nombre de dimensions de caractéristiques (8D : pente, temps écoulé, dénivelé cumulé, pente récente,
/// altitude, distance cumulée, zone de fréquence cardiaque, température en °C)
pub const N_FEATURES: usize = 8;

/// Contexte de pente récente : fenêtre fondée sur la distance (mètres)
const RECENT_GRADIENT_WINDOW_M: f64 = 500.0;

/// Transformation de puissance de Yeo-Johnson avec λ=0,5.
/// Préserve plus de séparation aux grandes valeurs que ln(1+x).
/// Pour x ≥ 0 : ((1+x)^λ - 1) / λ = 2 * ((1+x)^0.5 - 1)
#[inline]
pub fn yeo_johnson(x: f64) -> f64 {
    2.0 * ((1.0 + x.max(0.0)).sqrt() - 1.0)
}

/// Un échantillon d'entraînement extrait d'une activité FIT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingSample {
    pub gradient_pct: f64,
    pub elapsed_h: f64,
    pub cum_climb_m: f64,
    pub recent_avg_gradient: f64,
    pub elevation_m: f64,
    pub cum_distance_m: f64,
    pub heart_rate_zone: f64,
    pub temperature_c: f64,
    pub speed_ms: f64,
}

/// Paramètres de normalisation de chaque dimension de caractéristique.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureNorm {
    pub mean: f64,
    pub std: f64,
}

/// Vecteur de caractéristiques prénormalisé + vitesse — stocké pour une lecture en O(1) pendant la prédiction.
#[derive(Debug, Clone)]
pub struct NormalizedSample {
    pub features: [f64; N_FEATURES],
    pub speed_ms: f64,
}

/// Extrait les échantillons d'entraînement de plusieurs activités.
pub fn extract_training_samples(activities: &[ActivityData]) -> Vec<TrainingSample> {
    let mut samples: Vec<TrainingSample> = Vec::new();

    for activity in activities {
        let pts = &activity.points;
        if pts.len() < 20 {
            continue;
        }

        // FC max de cette activité pour normaliser la FC en zones (0-1)
        let max_hr = pts
            .iter()
            .map(|p| p.heart_rate_bpm)
            .fold(0.0_f64, f64::max);
        let has_hr = max_hr > 60.0; // valid HR data

        let mut cum_climb = 0.0_f64;
        let mut recent_grads: VecDeque<(f64, f64)> = VecDeque::new();

        for i in 1..pts.len() {
            let dist = pts[i].distance_m - pts[i - 1].distance_m;
            if dist < 1.0 {
                continue;
            }

            let speed = pts[i].speed_ms;
            if speed < 0.5 || speed > 25.0 {
                continue;
            }

            let ele_diff = pts[i].altitude_m - pts[i - 1].altitude_m;
            let grad = gradient_pct(dist, ele_diff);
            if grad < -25.0 || grad > 30.0 {
                continue;
            }

            if ele_diff > 0.0 {
                cum_climb += ele_diff;
            }

            let current_dist = pts[i].distance_m;
            recent_grads.push_back((current_dist, grad));

            let dist_cutoff = current_dist - RECENT_GRADIENT_WINDOW_M;
            while recent_grads.len() > 1 && recent_grads[0].0 < dist_cutoff {
                recent_grads.pop_front();
            }

            let recent_avg = if recent_grads.is_empty() {
                grad
            } else {
                recent_grads.iter().map(|(_, g)| g).sum::<f64>() / recent_grads.len() as f64
            };

            let elapsed_h = pts[i].timestamp_s / 3600.0;

            // Zone de fréquence cardiaque : normalisée en % de la FC max (0,0-1,0)
            // Sans donnée de FC, valeur neutre de 0,7 (hypothèse d'intensité modérée)
            let hr_zone = if has_hr && pts[i].heart_rate_bpm > 40.0 {
                (pts[i].heart_rate_bpm / max_hr).clamp(0.0, 1.0)
            } else {
                0.7
            };

            // Température : valeur brute, 18,0 °C par défaut si invalide / absente
            let temp = if pts[i].temperature_c > -30.0 && pts[i].temperature_c < 55.0 {
                pts[i].temperature_c
            } else {
                18.0
            };

            samples.push(TrainingSample {
                gradient_pct: grad,
                // Stocke les valeurs BRUTES — normalize_features_weighted applique
                // la compression de Yeo-Johnson une seule fois à la lecture. Stocker
                // ici la forme compressée causait un bogue de double compression
                // (elapsed_h → yj → yj) qui déformait fortement les distances du KNN
                // sur les longues activités.
                elapsed_h,
                cum_climb_m: cum_climb,
                recent_avg_gradient: recent_avg,
                elevation_m: pts[i].altitude_m,
                cum_distance_m: pts[i].distance_m,
                heart_rate_zone: hr_zone,
                temperature_c: temp,
                speed_ms: speed,
            });
        }
    }

    samples
}

/// Calcule les paramètres de normalisation (moyenne, écart type) de chaque dimension de caractéristique.
pub fn compute_norms(samples: &[TrainingSample]) -> Vec<FeatureNorm> {
    if samples.is_empty() {
        return vec![
            FeatureNorm { mean: 0.0, std: 10.0 },   // gradient
            FeatureNorm { mean: 0.5, std: 0.5 },     // yeo_johnson(elapsed_h)
            FeatureNorm { mean: 0.5, std: 0.5 },     // yeo_johnson(cum_climb/1000)
            FeatureNorm { mean: 0.0, std: 10.0 },    // recent_grad
            FeatureNorm { mean: 500.0, std: 500.0 },  // elevation
            FeatureNorm { mean: 0.5, std: 0.5 },     // yeo_johnson(cum_dist/100km)
            FeatureNorm { mean: 0.7, std: 0.15 },    // heart_rate_zone
            FeatureNorm { mean: 18.0, std: 8.0 },    // temperature_c
        ];
    }

    let n = samples.len() as f64;
    let mut norms = Vec::with_capacity(N_FEATURES);

    // Compresse les valeurs brutes des échantillons comme le fait
    // normalize_features_weighted, pour que les (moyenne, écart type) calculés
    // ici soient dans le même espace numérique que les valeurs lues.
    let raw: Vec<[f64; N_FEATURES]> = samples
        .iter()
        .map(|s| {
            [
                s.gradient_pct,
                yeo_johnson(s.elapsed_h),
                yeo_johnson(s.cum_climb_m / 1000.0),
                s.recent_avg_gradient,
                s.elevation_m,
                yeo_johnson(s.cum_distance_m / 100_000.0),
                s.heart_rate_zone,
                s.temperature_c,
            ]
        })
        .collect();

    for dim in 0..N_FEATURES {
        let mean = raw.iter().map(|f| f[dim]).sum::<f64>() / n;
        let variance = raw.iter().map(|f| (f[dim] - mean).powi(2)).sum::<f64>() / n;
        let std = variance.sqrt().max(1e-6);
        norms.push(FeatureNorm { mean, std });
    }
    norms
}

/// Normalise + pondère un vecteur de caractéristiques.
/// Utilise elapsed_h, cum_climb_m et cum_distance_m compressés par Yeo-Johnson pour les caractéristiques de la requête.
/// Accepte des poids personnalisés optionnels (issus de l'optimisation par validation croisée), sinon les poids par défaut.
#[inline]
pub fn normalize_features(
    gradient_pct: f64,
    elapsed_h: f64,
    cum_climb_m: f64,
    recent_avg_gradient: f64,
    elevation_m: f64,
    cum_distance_m: f64,
    norms: &[FeatureNorm],
) -> [f64; N_FEATURES] {
    normalize_features_weighted(
        gradient_pct, elapsed_h, cum_climb_m, recent_avg_gradient,
        elevation_m, cum_distance_m, 0.7, 18.0, norms, &DEFAULT_WEIGHTS,
    )
}

/// Normalisation complète avec les 8 caractéristiques et des poids personnalisés.
#[inline]
pub fn normalize_features_weighted(
    gradient_pct: f64,
    elapsed_h: f64,
    cum_climb_m: f64,
    recent_avg_gradient: f64,
    elevation_m: f64,
    cum_distance_m: f64,
    heart_rate_zone: f64,
    temperature_c: f64,
    norms: &[FeatureNorm],
    weights: &[f64; N_FEATURES],
) -> [f64; N_FEATURES] {
    let compressed_elapsed = yeo_johnson(elapsed_h);
    let compressed_climb = yeo_johnson(cum_climb_m / 1000.0);
    let compressed_dist = yeo_johnson(cum_distance_m / 100_000.0);

    [
        (gradient_pct - norms[0].mean) / norms[0].std * weights[0],
        (compressed_elapsed - norms[1].mean) / norms[1].std * weights[1],
        (compressed_climb - norms[2].mean) / norms[2].std * weights[2],
        (recent_avg_gradient - norms[3].mean) / norms[3].std * weights[3],
        (elevation_m - norms[4].mean) / norms[4].std * weights[4],
        (compressed_dist - norms[5].mean) / norms[5].std * weights[5],
        (heart_rate_zone - norms[6].mean) / norms[6].std * weights[6],
        (temperature_c - norms[7].mean) / norms[7].std * weights[7],
    ]
}

/// Indices régulièrement espacés sur `0..n`, plafonnés à `cap` entrées.
fn stride_indices(n: usize, cap: usize) -> Vec<usize> {
    if n <= cap {
        return (0..n).collect();
    }
    let step = n as f64 / cap as f64;
    let mut v = Vec::with_capacity(cap);
    let mut idx = 0.0;
    while (idx as usize) < n && v.len() < cap {
        v.push(idx as usize);
        idx += step;
    }
    v
}

/// Optimise les poids des caractéristiques par validation croisée « un de côté » sur un sous-échantillon.
/// Teste des combinaisons aléatoires de poids et renvoie celle qui minimise la RMSE.
/// Utilise un arbre k-d pour des recherches de voisins rapides dans la boucle interne.
pub fn optimize_feature_weights(
    samples: &[TrainingSample],
    norms: &[FeatureNorm],
) -> [f64; N_FEATURES] {
    // Plafonne le corpus de voisins utilisé pour l'évaluation par validation
    // croisée. Construire un arbre k-d sur tous les échantillons
    // d'entraînement pour chaque vecteur de poids candidat dominait le temps de
    // construction du profil sur les gros jeux de données (201 arbres sur
    // jusqu'à 50 k échantillons). Un sous-échantillon régulier garde une
    // estimation statistiquement équivalente pour une fraction du coût.
    const MAX_CORPUS: usize = 4000;
    const MAX_TEST: usize = 1000;
    let corpus = stride_indices(samples.len(), MAX_CORPUS);
    // Les positions de test sont des indices dans `corpus` (== positions dans `normalized`)
    let test = stride_indices(corpus.len(), MAX_TEST);

    let weight_options: &[f64] = &[0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

    // Générateur pseudo-aléatoire simple (déterministe, sans dépendance externe)
    let mut rng_state: u64 = 42;
    let mut next_rand = || -> usize {
        rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((rng_state >> 33) as usize) % weight_options.len()
    };

    let mut best_weights = DEFAULT_WEIGHTS;
    let mut best_rmse = f64::MAX;

    // Teste d'abord les poids par défaut
    let default_rmse = evaluate_weights_loo(&test, &corpus, samples, norms, &DEFAULT_WEIGHTS);
    if default_rmse < best_rmse {
        best_rmse = default_rmse;
    }

    // Recherche aléatoire : 200 combinaisons de poids aléatoires (800 avant, l'arbre k-d rend chacune plus rapide)
    for _ in 0..200 {
        let mut candidate = [0.0_f64; N_FEATURES];
        for d in 0..N_FEATURES {
            candidate[d] = weight_options[next_rand()];
        }
        // Garantit que la pente reste dominante (>= 2,0)
        if candidate[0] < 2.0 {
            candidate[0] = 2.0;
        }

        let rmse = evaluate_weights_loo(&test, &corpus, samples, norms, &candidate);
        if rmse < best_rmse {
            best_rmse = rmse;
            best_weights = candidate;
        }
    }

    best_weights
}

/// Évalue des poids de caractéristiques par validation croisée approchée, renvoie la RMSE.
/// Utilise un arbre k-d pour des requêtes rapides de plus proches voisins dans la boucle interne.
fn evaluate_weights_loo(
    test_indices: &[usize],
    corpus_indices: &[usize],
    samples: &[TrainingSample],
    norms: &[FeatureNorm],
    weights: &[f64; N_FEATURES],
) -> f64 {
    // Normalise + indexe seulement le sous-ensemble du corpus avec ces poids
    let normalized: Vec<([f64; N_FEATURES], f64)> = corpus_indices
        .iter()
        .map(|&i| {
            let s = &samples[i];
            let f = normalize_features_weighted(
                s.gradient_pct, s.elapsed_h, s.cum_climb_m,
                s.recent_avg_gradient, s.elevation_m, s.cum_distance_m,
                s.heart_rate_zone, s.temperature_c, norms, weights,
            );
            (f, s.speed_ms)
        })
        .collect();

    // Construit l'arbre k-d sur le corpus normalisé
    let feats: Vec<[f64; N_FEATURES]> = normalized.iter().map(|(f, _)| *f).collect();
    let speeds: Vec<f64> = normalized.iter().map(|(_, s)| *s).collect();
    let tree = super::kdtree::KdTree::build(&feats, &speeds);

    // K+1 car il faut s'exclure soi-même
    let k = ((corpus_indices.len() as f64).sqrt() as usize).clamp(7, 50);
    let k_query = (k + 1).min(corpus_indices.len());
    let mut sse = 0.0;

    for &test_pos in test_indices {
        let q = &normalized[test_pos].0;
        let actual_speed = normalized[test_pos].1;

        // Demande k+1 voisins (l'un sera soi-même avec dist=0, on le saute)
        let neighbors = tree.knn_query(q, k_query);

        // Prédiction pondérée par une gaussienne, sans soi-même
        let mut found = 0;
        let median_d2 = if neighbors.len() >= 4 {
            neighbors[neighbors.len() / 2].0.max(1e-12)
        } else {
            1.0
        };
        let mut w_sum = 0.0;
        let mut v_sum = 0.0;
        for &(d, spd) in &neighbors {
            // Saute soi-même (distance ≈ 0)
            if d < 1e-15 {
                continue;
            }
            let w = (-d / (2.0 * median_d2)).exp();
            w_sum += w;
            v_sum += w * spd;
            found += 1;
            if found >= k {
                break;
            }
        }
        let predicted = if w_sum > 0.0 { v_sum / w_sum } else { actual_speed };
        sse += (predicted - actual_speed).powi(2);
    }

    (sse / test_indices.len() as f64).sqrt()
}

#[inline]
fn dist_sq_arr(a: &[f64; N_FEATURES], b: &[f64; N_FEATURES]) -> f64 {
    let mut sum = 0.0;
    for i in 0..N_FEATURES {
        let d = a[i] - b[i];
        sum += d * d;
    }
    sum
}
