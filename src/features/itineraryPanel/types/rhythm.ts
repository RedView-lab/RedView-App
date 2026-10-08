import type { PoiCategory } from './poi';

// Rythme : départ, profil de prédiction, pauses (vélo, trail, running).

/** Une pause définie par l'utilisateur, insérée à intervalle régulier. */
export interface PauseIntervalRow {
  id: string;
  /** Libellé affiché (« Pause 1 », « Pause 2 », …). */
  label: string;
  /** Durée de la pause en minutes (par ex. 5, 210 → 3h30). */
  durationMin: number;
  /** Intervalle de répétition en minutes (par ex. 60 → toutes les heures). */
  intervalMin: number;
}

export type RhythmGender = 'default' | 'male' | 'female';

/**
 * "Profil de rythme" : `preset` = un niveau par défaut (Débutant → Expert),
 * `custom` = "Personalisé" (activités .fit + FTP / poids / pneus saisis).
 */
export type RhythmProfileMode = 'preset' | 'custom';

export interface RhythmState {
  /** Date ISO (yyyy-mm-dd) ou null si vide. */
  startDate: string | null;
  /** Heure sur 24h (HH:MM) ou null si vide. */
  startTime: string | null;
  /** Surcharge du sexe pour le moteur de prédiction. `default` laisse le backend décider. */
  gender?: RhythmGender;
  usePastActivities: boolean;
  /**
   * Absent sur les projets antérieurs : voir `isCustomRhythmProfile`, qui
   * l'infère des valeurs saisies.
   */
  rhythmProfile?: RhythmProfileMode;
  /** Niveau du profil par défaut ; ignoré en mode `custom`. */
  practiceLevel?: string | null;
  applyToAllItineraries?: boolean;
  ftp: number | null;
  systemWeightKg: number | null;
  tiresMm: number | null;
  useWeather: boolean;
  weatherWeight: number;
  useSurfaces: boolean;
  surfacesWeight: number;
  pauseAtFavoritePois: boolean;
  /**
   * Durées de pause par POI (en minutes). Affichées dans la grille dépliée sous
   * la bascule « Ajouter des pauses à chaque POI favori » (Figma 1695:22638
   * Variant2). Une valeur `null` signifie que l'utilisateur a décoché cette
   * catégorie de POI — elle apparaît encore dans la grille (grisée) mais est
   * exclue du routage. Les clés reprennent `PoiCategory`.
   */
  poiPauseDurations: Record<PoiCategory, number | null>;
  /**
   * Bascule principale des « pauses par intervalle ». À false, les lignes sont
   * gardées dans `pauseIntervals` mais le moteur de routage les ignore. À true
   * avec une liste vide, la section crée automatiquement une ligne par défaut.
   */
  pauseEveryIntervalEnabled: boolean;
  /**
   * @deprecated gardé pour la compatibilité avec les projets enregistrés
   * auparavant qui ne stockaient qu'une seule valeur « toutes les N minutes ».
   * Le nouveau code doit s'appuyer sur `pauseIntervals`.
   */
  pauseEveryIntervalMin: number | null;
  /** Lignes de pause définies par l'utilisateur, affichées quand la bascule principale est activée. */
  pauseIntervals: PauseIntervalRow[];
  /** Surcharges de distance par pause générée, indexées par id de pause. */
  pausePositionOverridesKm: Record<string, number>;

  // ── Trail / course (ignorés par le moteur vélo) ──
  /** Quelle référence alimente le moteur de course : VMA ou un temps de course. */
  runReferenceMode?: RunReferenceMode;
  /** Vitesse maximale aérobie (km/h). */
  vmaKmh?: number | null;
  /** Distance de la course de référence (m) pour `runReferenceMode === 'chrono'`. */
  refRaceDistanceM?: number | null;
  /** Reference race finish time (s). */
  refRaceTimeS?: number | null;
  /** Poids du coureur sac compris (kg) — distinct du poids du système vélo. */
  runWeightKg?: number | null;
  /** Technicité du terrain de 0 (roulant) … à 1 (très technique), trail seulement. */
  terrainTechnicality?: number | null;
}

export type RunReferenceMode = 'vma' | 'chrono';
