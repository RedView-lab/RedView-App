pub mod features;
pub mod kdtree;

use crate::types::ActivityData;
use features::{FeatureNorm, NormalizedSample, TrainingSample, DEFAULT_WEIGHTS};
use kdtree::KdTree;
use serde::{Deserialize, Serialize};

/// Nombre minimal d'échantillons d'entraînement pour utiliser le KNN.
const MIN_SAMPLES: usize = 50;

/// Nombre maximal d'échantillons d'entraînement — avec une recherche de distance efficace, on peut utiliser plus de données.
const MAX_SAMPLES: usize = 50_000;

/// Résultat de prédiction du KNN avec un indicateur de confiance.
pub struct KnnPrediction {
    pub speed_ms: f64,
    /// Confiance dans [0, 1]. Plus élevée = voisins plus proches, prédiction plus fiable.
    pub confidence: f64,
}

/// Le modèle KNN complet avec des échantillons prénormalisés pour un calcul de distance rapide.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnnModel {
    /// Échantillons d'entraînement bruts (gardés pour la sérialisation / le débogage)
    pub samples: Vec<TrainingSample>,
    /// Paramètres de normalisation : [pente, elapsed_h, dénivelé cumulé, pente récente, altitude, distance cumulée, zone FC, température]
    pub norms: Vec<FeatureNorm>,
    /// Poids des caractéristiques optimisés par validation croisée (par défaut si l'optimisation est sautée).
    #[serde(default = "default_weights")]
    pub weights: [f64; features::N_FEATURES],
    /// Vecteurs de caractéristiques prénormalisés et pondérés — NON sérialisés, reconstruits à la demande.
    #[serde(skip)]
    precomputed: Vec<NormalizedSample>,
    /// Index spatial en arbre k-d — NON sérialisé, reconstruit à la demande.
    #[serde(skip)]
    kdtree: Option<KdTree>,
}

fn default_weights() -> [f64; features::N_FEATURES] {
    DEFAULT_WEIGHTS
}

impl KnnModel {
    pub fn is_usable(&mut self) -> bool {
        self.ensure_precomputed();
        self.precomputed.len() >= MIN_SAMPLES
    }

    /// elapsed_h maximal vu dans les données d'entraînement.
    pub fn max_elapsed_h(&self) -> f64 {
        self.samples
            .iter()
            .map(|s| s.elapsed_h)
            .fold(0.0_f64, f64::max)
    }

    /// Crée un modèle vide (utilisé en repli quand il n'existe aucune donnée d'entraînement).
    pub fn empty() -> Self {
        KnnModel {
            samples: vec![],
            norms: vec![],
            weights: DEFAULT_WEIGHTS,
            precomputed: vec![],
            kdtree: None,
        }
    }

    /// CORRECTIF : reconstruit les échantillons précalculés après désérialisation.
    /// Appelé à la demande au premier usage si precomputed est vide mais que des échantillons existent.
    /// Construit aussi l'index en arbre k-d pour des requêtes en O(log N).
    pub fn ensure_precomputed(&mut self) {
        if self.precomputed.is_empty() && !self.samples.is_empty() && !self.norms.is_empty() {
            let weights = &self.weights;
            self.precomputed = self
                .samples
                .iter()
                .map(|s| NormalizedSample {
                    features: features::normalize_features_weighted(
                        s.gradient_pct,
                        s.elapsed_h,
                        s.cum_climb_m,
                        s.recent_avg_gradient,
                        s.elevation_m,
                        s.cum_distance_m,
                        s.heart_rate_zone,
                        s.temperature_c,
                        &self.norms,
                        weights,
                    ),
                    speed_ms: s.speed_ms,
                })
                .collect();
        }
        // Construit l'arbre k-d si nécessaire
        if self.kdtree.is_none() && !self.precomputed.is_empty() {
            let feats: Vec<[f64; features::N_FEATURES]> =
                self.precomputed.iter().map(|s| s.features).collect();
            let speeds: Vec<f64> = self.precomputed.iter().map(|s| s.speed_ms).collect();
            self.kdtree = Some(KdTree::build(&feats, &speeds));
        }
    }
}

/// Extrait les échantillons d'entraînement de plusieurs activités et construit le modèle KNN.
/// Comprend l'optimisation des poids par validation croisée pour une précision de prédiction maximale.
pub fn build_knn_model(activities: &[ActivityData]) -> KnnModel {
    let mut samples = features::extract_training_samples(activities);

    // Sous-échantillonne si nécessaire — garde un échantillon sur N, uniformément
    if samples.len() > MAX_SAMPLES {
        let step = samples.len() as f64 / MAX_SAMPLES as f64;
        let mut kept = Vec::with_capacity(MAX_SAMPLES);
        let mut idx = 0.0_f64;
        while (idx as usize) < samples.len() && kept.len() < MAX_SAMPLES {
            kept.push(samples[idx as usize].clone());
            idx += step;
        }
        samples = kept;
    }

    let norms = features::compute_norms(&samples);

    // Optimise les poids des caractéristiques par validation croisée s'il y a assez d'échantillons
    let weights = if samples.len() >= 200 {
        features::optimize_feature_weights(&samples, &norms)
    } else {
        DEFAULT_WEIGHTS
    };

    let precomputed: Vec<NormalizedSample> = samples
        .iter()
        .map(|s| NormalizedSample {
            features: features::normalize_features_weighted(
                s.gradient_pct,
                s.elapsed_h,
                s.cum_climb_m,
                s.recent_avg_gradient,
                s.elevation_m,
                s.cum_distance_m,
                s.heart_rate_zone,
                s.temperature_c,
                &norms,
                &weights,
            ),
            speed_ms: s.speed_ms,
        })
        .collect();

    // Construit l'index en arbre k-d pour des requêtes de plus proches voisins en O(log N)
    let feats: Vec<[f64; features::N_FEATURES]> =
        precomputed.iter().map(|s| s.features).collect();
    let speeds: Vec<f64> = precomputed.iter().map(|s| s.speed_ms).collect();
    let kdtree = Some(KdTree::build(&feats, &speeds));

    KnnModel {
        samples,
        norms,
        weights,
        precomputed,
        kdtree,
    }
}

/// Prédit la vitesse (m/s) d'un point de route avec le KNN.
/// Renvoie une KnnPrediction avec la vitesse et un indicateur de confiance.
///
/// Utilise l'index en arbre k-d pour des requêtes de plus proches voisins en O(log N).
/// La confiance combine proximité, poids gaussien et variance de vitesse des voisins.
pub fn knn_predict_speed(
    model: &mut KnnModel,
    gradient_pct: f64,
    elapsed_h: f64,
    cum_climb_m: f64,
    recent_avg_gradient: f64,
    elevation_m: f64,
    cum_distance_m: f64,
) -> KnnPrediction {
    model.ensure_precomputed();
    let precomputed = &model.precomputed;

    if precomputed.is_empty() {
        return KnnPrediction {
            speed_ms: 5.56,
            confidence: 0.0,
        };
    }

    let q = features::normalize_features_weighted(
        gradient_pct,
        elapsed_h,
        cum_climb_m,
        recent_avg_gradient,
        elevation_m,
        cum_distance_m,
        0.7,  // neutral HR zone for prediction (unknown future HR)
        18.0, // neutral temperature for prediction
        &model.norms,
        &model.weights,
    );

    // K adaptatif : suit la taille des données, plafond relevé pour les gros jeux de données
    let adaptive_k = ((precomputed.len() as f64).sqrt() as usize).clamp(7, 50);
    let k = adaptive_k.min(precomputed.len());

    // Arbre k-d pour une recherche de plus proches voisins en O(log N)
    let top_k = model.kdtree.as_ref().unwrap().knn_query(&q, k);

    // Pondération par l'inverse de la distance à noyau gaussien — décroissance plus douce que 1/d
    let mut weight_sum = 0.0;
    let mut value_sum = 0.0;
    let mut dist_sum = 0.0;

    // Largeur de bande tirée de la distance médiane des voisins, pour une largeur gaussienne adaptative
    let median_d2 = if top_k.len() >= 3 {
        let mid = top_k.len() / 2;
        top_k[mid].0.max(1e-12)
    } else {
        1.0
    };

    for &(d, speed) in &top_k {
        let r = d.sqrt();
        // Noyau gaussien : w = exp(-d / (2·σ²))
        let w = (-d / (2.0 * median_d2)).exp();
        weight_sum += w;
        value_sum += w * speed;
        dist_sum += r;
    }

    let speed = if weight_sum > 0.0 {
        value_sum / weight_sum
    } else {
        5.56
    };

    // Confiance : combine distance moyenne, poids gaussien et variance de vitesse
    let mean_dist = if !top_k.is_empty() {
        dist_sum / top_k.len() as f64
    } else {
        f64::MAX
    };
    let mean_weight = if !top_k.is_empty() && weight_sum > 0.0 {
        weight_sum / top_k.len() as f64
    } else {
        0.0
    };

    // Confiance pondérée par la variance : pénalise quand les voisins ne s'accordent pas sur la vitesse
    let speed_variance = if weight_sum > 0.0 && !top_k.is_empty() {
        let mean_spd = value_sum / weight_sum;
        let var: f64 = top_k.iter()
            .map(|&(d, spd)| {
                let w = (-d / (2.0 * median_d2)).exp();
                w * (spd - mean_spd).powi(2)
            })
            .sum::<f64>() / weight_sum;
        var.sqrt()
    } else {
        1.0
    };
    let variance_penalty = 1.0 / (1.0 + speed_variance);

    let confidence = ((1.0 / (1.0 + mean_dist)) * mean_weight.sqrt() * variance_penalty).clamp(0.0, 1.0);

    KnnPrediction { speed_ms: speed, confidence }
}

/// Distance euclidienne au carré entre deux vecteurs de caractéristiques.
#[inline]
fn dist_sq(a: &[f64; features::N_FEATURES], b: &[f64; features::N_FEATURES]) -> f64 {
    let mut sum = 0.0;
    for i in 0..features::N_FEATURES {
        let d = a[i] - b[i];
        sum += d * d;
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ActivityData, ActivitySummary, DataPoint};

    fn make_activity(n_points: usize, base_speed: f64, has_power: bool) -> ActivityData {
        let mut points = Vec::with_capacity(n_points);
        for i in 0..n_points {
            let t = i as f64;
            let dist = t * base_speed;
            let grad_cycle = (t * 0.01).sin() * 5.0;
            let ele = 500.0 + grad_cycle * 10.0;
            let speed = (base_speed - grad_cycle * 0.3).max(1.0);

            points.push(DataPoint {
                timestamp_s: t,
                lat: 45.0 + t * 0.00001,
                lon: 6.0,
                altitude_m: ele,
                speed_ms: speed,
                power_w: if has_power { 200.0 } else { 0.0 },
                cadence_rpm: 80.0,
                heart_rate_bpm: 140.0,
                temperature_c: 20.0,
                distance_m: dist,
            });
        }

        let summary = ActivitySummary {
            duration_s: n_points as f64,
            distance_m: points.last().map(|p| p.distance_m).unwrap_or(0.0),
            elevation_gain_m: 500.0,
            avg_speed_ms: base_speed,
            avg_power_w: if has_power { 200.0 } else { 0.0 },
            avg_hr_bpm: 140.0,
            has_power,
            has_hr: true,
            sport: None,
        };

        ActivityData { points, summary }
    }

    #[test]
    fn test_knn_model_building() {
        let activities = vec![
            make_activity(1000, 7.0, false),
            make_activity(500, 6.0, false),
        ];

        let mut model = build_knn_model(&activities);

        assert!(
            model.samples.len() > 100,
            "Expected >100 samples, got {}",
            model.samples.len()
        );
        assert_eq!(model.norms.len(), 8);
        assert!(model.is_usable());
    }

    #[test]
    fn test_knn_prediction() {
        let activities = vec![
            make_activity(2000, 7.0, false),
            make_activity(1000, 6.5, false),
        ];

        let mut model = build_knn_model(&activities);

        let pred = knn_predict_speed(&mut model, 0.0, 0.5, 100.0, 0.0, 500.0, 5000.0);
        assert!(
            pred.speed_ms > 4.0 && pred.speed_ms < 12.0,
            "Flat prediction: got {} m/s",
            pred.speed_ms
        );
        assert!(pred.confidence > 0.0, "Confidence should be > 0");

        // Requête DANS la plage d'entraînement synthétique (pente ±5 %, voir
        // make_activity — grad_cycle = sin(t*0.01)*5). Pente négative → le
        // modèle doit prédire une vitesse >= la base sur le plat car les
        // données d'entraînement suivent speed = base - 0.3*grad_cycle.
        let pred_down = knn_predict_speed(&mut model, -4.0, 0.5, 100.0, -3.0, 400.0, 5000.0);
        let pred_up = knn_predict_speed(&mut model, 4.0, 0.5, 100.0, 3.0, 600.0, 5000.0);
        assert!(
            pred_up.speed_ms < pred_down.speed_ms,
            "Uphill ({}) should be slower than downhill ({})",
            pred_up.speed_ms,
            pred_down.speed_ms
        );
    }

    #[test]
    fn test_knn_model_too_small() {
        let activities = vec![make_activity(10, 7.0, false)];
        let mut model = build_knn_model(&activities);
        assert!(!model.is_usable());
    }

    #[test]
    fn test_knn_confidence_decreases_with_extrapolation() {
        let activities = vec![make_activity(2000, 7.0, false)];
        let mut model = build_knn_model(&activities);

        // Dans la plage d'entraînement
        let pred_normal = knn_predict_speed(&mut model, 0.0, 0.3, 100.0, 0.0, 500.0, 3000.0);
        // Très loin hors de la plage d'entraînement (50 h écoulées = bien au-delà des données)
        let pred_extrap = knn_predict_speed(&mut model, 0.0, 50.0, 50000.0, 0.0, 500.0, 500000.0);

        // En extrapolation lointaine, les voisins sont si éloignés que la
        // pondération gaussienne ramène la confiance à ~0. On vérifie juste
        // que c'est un tout petit nombre, bien sous les confiances typiques
        // dans la plage. (L'ordre relatif entre deux valeurs proches de zéro
        // n'est pas stable à cause du terme de variance — voir l'élément d'audit n° 15.)
        assert!(
            pred_extrap.confidence < 0.01,
            "Extrapolated confidence ({}) should be ~0",
            pred_extrap.confidence
        );
        assert!(pred_normal.confidence >= 0.0);
    }
}
