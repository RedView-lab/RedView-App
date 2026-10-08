use serde::{Deserialize, Serialize};

// ─── Genre / sexe (modèle physiologique) ─────────────────────────────────────

/// Genre du cycliste / coureur : choisit le gabarit des préréglages
/// (masse, puissance absolue, traînée), jamais un coefficient de vitesse.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Gender {
    Male,
    Female,
    /// Non précisé : gabarit masculin moyen.
    Unspecified,
}

impl Default for Gender {
    fn default() -> Self {
        Gender::Unspecified
    }
}

// ─── Type de surface (d'après les données OpenStreetMap) ────────────────────

/// Type de surface détecté dans les données OSM.
/// Influe sur la résistance au roulement (Crr) et la pénalité de vitesse.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceType {
    /// Route revêtue (asphalte, béton, pavés)
    Road,
    /// Surface non revêtue (gravier, terre, herbe, sable, stabilisé)
    Gravel,
    /// Inconnue — pas de donnée OSM, valeurs par défaut prudentes
    Unknown,
}

impl Default for SurfaceType {
    fn default() -> Self {
        SurfaceType::Unknown
    }
}

// ─── Stratégie d'arrêts / de sommeil pour les épreuves d'ultra-distance ─────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StopStrategy {
    /// Aucun arrêt prédit (comportement hérité)
    None,
    /// Détection automatique selon la distance de la route (> 200 km → Ultra)
    Auto,
    /// Ultra-distance : micro-arrêts + arrêts ravitaillement + arrêts sommeil optionnels
    Ultra,
    /// Personnalisé : l'appelant fournit la cadence exacte des arrêts
    Custom {
        /// Minutes d'arrêt par heure de selle
        stop_min_per_hour: f64,
    },
}

impl Default for StopStrategy {
    fn default() -> Self {
        StopStrategy::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SleepStrategy {
    /// Pas de modélisation du sommeil
    None,
    /// Le cycliste fait des micro-siestes (10-20 min) — cumul circadien léger
    MicroNaps,
    /// Le cycliste fait des arrêts sommeil planifiés (60-90 min) — récupération modérée
    SleepStops,
}

impl Default for SleepStrategy {
    fn default() -> Self {
        SleepStrategy::None
    }
}

// ─── Point de données brut d'un fichier FIT ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataPoint {
    /// Secondes depuis le début de l'activité
    pub timestamp_s: f64,
    pub lat: f64,
    pub lon: f64,
    /// Mètres
    pub altitude_m: f64,
    /// m/s
    pub speed_ms: f64,
    /// Watts (0 sans capteur de puissance)
    pub power_w: f64,
    /// tr/min
    pub cadence_rpm: f64,
    /// bpm
    pub heart_rate_bpm: f64,
    /// Degrés Celsius
    pub temperature_c: f64,
    /// Distance cumulée en mètres depuis le début de l'activité
    pub distance_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitySummary {
    pub duration_s: f64,
    pub distance_m: f64,
    pub elevation_gain_m: f64,
    pub avg_speed_ms: f64,
    pub avg_power_w: f64,
    pub avg_hr_bpm: f64,
    pub has_power: bool,
    pub has_hr: bool,
    /// Énumération FIT `sport` du message Session / Sport, quand elle est enregistrée
    /// (1 course à pied, 2 vélo, 11 marche, 17 randonnée — voir FIT_SPORT_*).
    #[serde(default)]
    pub sport: Option<u8>,
}

/// Codes `sport` du profil FIT utilisés pour orienter les activités vers le bon moteur.
pub const FIT_SPORT_RUNNING: u8 = 1;
pub const FIT_SPORT_CYCLING: u8 = 2;
pub const FIT_SPORT_WALKING: u8 = 11;
pub const FIT_SPORT_HIKING: u8 = 17;

impl ActivitySummary {
    /// Activité à pied (course, marche, randonnée).
    pub fn is_foot_sport(&self) -> bool {
        matches!(
            self.sport,
            Some(FIT_SPORT_RUNNING) | Some(FIT_SPORT_WALKING) | Some(FIT_SPORT_HIKING)
        )
    }

    pub fn is_cycling_sport(&self) -> bool {
        self.sport == Some(FIT_SPORT_CYCLING)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityData {
    pub points: Vec<DataPoint>,
    pub summary: ActivitySummary,
}

// ─── Route GPX ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutePoint {
    pub lat: f64,
    pub lon: f64,
    /// Altitude lissée (mètres)
    pub elevation_m: f64,
    /// Distance cumulée depuis le départ de la route (mètres)
    pub distance_m: f64,
    /// Pente jusqu'au point suivant (%)
    pub gradient_pct: f64,
    /// Longueur du segment jusqu'au point suivant (mètres)
    pub segment_length_m: f64,
    /// Densité de courbure de la route (degrés de changement de cap par km).
    /// Plus élevé = plus technique / sinueux. 0 = route droite.
    pub curvature_deg_per_km: f64,
    /// Type de surface d'après OSM (route, gravier, inconnu).
    /// Influe sur la résistance au roulement et la pénalité de vitesse.
    #[serde(default)]
    pub surface_type: SurfaceType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub points: Vec<RoutePoint>,
    pub total_distance_m: f64,
    pub total_elevation_gain_m: f64,
    pub total_elevation_loss_m: f64,
}

// ─── Sortie de prédiction ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionPoint {
    /// Distance cumulée (m)
    pub distance_m: f64,
    /// Altitude en ce point (m)
    pub elevation_m: f64,
    /// Pente locale (%)
    pub gradient_pct: f64,
    /// Vitesse prédite (km/h)
    pub predicted_speed_kmh: f64,
    /// Puissance prédite (W) — 0 sans modèle de puissance
    pub predicted_power_w: f64,
    /// Temps écoulé depuis le départ (s)
    pub elapsed_time_s: f64,
    /// Temps de ce seul segment (s)
    pub segment_time_s: f64,
    /// Facteur de fatigue en ce point [0-1]
    #[serde(default)]
    pub fatigue_factor: f64,
    /// Facteur de rythme circadien [0-1]
    #[serde(default)]
    pub circadian_factor: f64,
    /// Facteur d'efficacité selon la distance [0-1]
    #[serde(default)]
    pub distance_eff_factor: f64,
    /// Confiance du KNN en ce point [0-1]
    #[serde(default)]
    pub knn_confidence: f64,
    /// Borne basse de la vitesse prédite (km/h) — intervalle de confiance à 90 %
    #[serde(default)]
    pub predicted_speed_low_kmh: f64,
    /// Borne haute de la vitesse prédite (km/h) — intervalle de confiance à 90 %
    #[serde(default)]
    pub predicted_speed_high_kmh: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentSummary {
    pub start_distance_m: f64,
    pub end_distance_m: f64,
    pub distance_m: f64,
    pub elevation_gain_m: f64,
    pub elevation_loss_m: f64,
    pub avg_gradient_pct: f64,
    pub avg_speed_kmh: f64,
    pub time_s: f64,
    pub segment_type: String, // "climb", "descent", "flat"
    /// VAM (Velocità Ascensionale Media) en m/h — n'a de sens que sur les segments de montée
    #[serde(default)]
    pub vam_mh: f64,
}

// ─── Configuration venue du JS ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionConfig {
    /// Forçage de la FTP en watts. Quand elle est fournie, elle prime sur la FTP estimée.
    /// Doit être la FTP connue du cycliste (test en laboratoire, Zwift, TrainingPeaks, etc.).
    #[serde(default)]
    pub ftp_w: Option<f64>,
    /// Poids du cycliste seul (kg). Utilisé avec bike_weight_kg pour calculer la masse
    /// totale et le rapport W/kg. Prime sur mass_kg.
    #[serde(default)]
    pub rider_weight_kg: Option<f64>,
    /// Poids du vélo + sacoches + équipement (kg). Combiné avec rider_weight_kg.
    /// Par défaut : 10 kg si rider_weight_kg est fourni mais pas celui-ci.
    #[serde(default)]
    pub bike_weight_kg: Option<f64>,
    /// Forçage de la masse cycliste + vélo + équipement (kg). Si None, estimée.
    /// HÉRITÉ : préférer rider_weight_kg + bike_weight_kg pour un W/kg juste.
    #[serde(default)]
    pub mass_kg: Option<f64>,
    /// Forçage du CdA (m²). Si None, estimé ou valeur par défaut.
    #[serde(default)]
    pub cda: Option<f64>,
    /// Forçage du Crr. Si None, 0,005 par défaut.
    #[serde(default)]
    pub crr: Option<f64>,
    /// Facteur de stratégie d'allure (0,8 = prudent, 1,0 = normal, 1,1 = agressif)
    #[serde(default = "default_pacing")]
    pub pacing_factor: f64,
    /// Mode course : utilise le percentile haut des classes de vitesse au lieu de la médiane
    #[serde(default)]
    pub race_mode: bool,
    /// Distance de la fenêtre de lissage en mètres (par défaut : 50). Plus grand = profil d'altitude plus lisse.
    #[serde(default)]
    pub smoothing_window_m: Option<f64>,
    /// Nombre maximal de points de route après sous-échantillonnage (par défaut : 15000).
    /// Plus bas = plus rapide mais moins de résolution. 0 désactive le sous-échantillonnage.
    #[serde(default)]
    pub max_route_points: Option<usize>,
    /// Forçage du plancher de fatigue (0,0-1,0). Plus bas = plus de fatigue pour les épreuves d'ultra.
    #[serde(default)]
    pub fatigue_floor: Option<f64>,
    /// Forçage du lambda de décroissance de la fatigue. Plus haut = fatigue plus précoce.
    #[serde(default)]
    pub fatigue_lambda: Option<f64>,
    /// Temps d'arrêt par heure de selle (secondes). Estimé par défaut selon la durée de l'épreuve.
    /// Typique : 180-300 s/h (3-5 min/h) pour les épreuves d'ultra. 0 le désactive.
    /// DÉPRÉCIÉ : le temps d'arrêt n'est plus calculé. Gardé pour la compatibilité des anciennes configurations.
    #[serde(default)]
    pub stop_time_per_hour_s: Option<f64>,
    /// Rendement de la transmission (0,90-1,0). Par défaut : 0,97. Réduit la puissance
    /// effective qui atteint la roue arrière. Plus bas pour une transmission ancienne / sale.
    #[serde(default)]
    pub drivetrain_efficiency: Option<f64>,
    /// Facteur d'agressivité en course (0,0-1,0). Par défaut : 0,5.
    /// 0,0 = prudent (vitesse médiane), 1,0 = agressif (percentile haut).
    /// Remplace l'ancien booléen race_mode par une échelle continue.
    #[serde(default)]
    pub race_aggressiveness: Option<f64>,
    /// Heure de départ dans la journée (0,0-24,0, heures). Quand elle est fournie, active la
    /// modulation du rythme circadien — modélise la baisse de performance de 5 à 15 % entre 2 h et 6 h.
    /// Exemple : 8.0 = départ à 8 h.
    #[serde(default)]
    pub start_time_h: Option<f64>,
    /// Stratégie d'arrêts / de repos de l'épreuve.
    #[serde(default)]
    pub stop_strategy: StopStrategy,
    /// Stratégie de sommeil — influe sur le cumul circadien sur plusieurs nuits.
    #[serde(default)]
    pub sleep_strategy: SleepStrategy,
    /// Types de surface d'après OpenStreetMap, un par point de route.
    /// Encodés en u8 : 0=Route, 1=Gravier, 2=Inconnu.
    /// Si None ou vide, tous les points valent Inconnu.
    #[serde(default)]
    pub surface_types: Option<Vec<u8>>,
    /// Température ambiante (°C) — influe sur le modèle de stress thermique.
    /// Par défaut : 18,0 (thermoneutre). Mettre la prévision réelle pour plus de justesse.
    #[serde(default)]
    pub ambient_temperature_c: Option<f64>,
    /// Vitesse du vent de face (m/s) — positive = vent de face, négative = vent arrière.
    /// Par défaut : 0,0 (pas de vent). Vent moyen attendu sur la route.
    #[serde(default)]
    pub headwind_ms: Option<f64>,
    /// Genre du cycliste pour les ajustements physiologiques.
    /// Influe sur la prédiction de vitesse via les différences VO2max / puissance-vitesse.
    #[serde(default)]
    pub gender: Gender,
}

fn default_pacing() -> f64 {
    1.0
}

impl Default for PredictionConfig {
    fn default() -> Self {
        Self {
            ftp_w: None,
            rider_weight_kg: None,
            bike_weight_kg: None,
            mass_kg: None,
            cda: None,
            crr: None,
            pacing_factor: 1.0,
            race_mode: false,
            smoothing_window_m: None,
            max_route_points: None,
            fatigue_floor: None,
            fatigue_lambda: None,
            stop_time_per_hour_s: None,
            drivetrain_efficiency: None,
            race_aggressiveness: None,
            start_time_h: None,
            stop_strategy: StopStrategy::None,
            sleep_strategy: SleepStrategy::None,
            surface_types: None,
            ambient_temperature_c: None,
            headwind_ms: None,
            gender: Gender::Unspecified,
        }
    }
}
