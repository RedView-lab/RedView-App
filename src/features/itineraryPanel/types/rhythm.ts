import type { PoiCategory } from './poi';

// Rythme : départ, profil de prédiction, pauses (vélo, trail, running).

/** A single user-defined pause inserted at a recurring interval. */
export interface PauseIntervalRow {
  id: string;
  /** Display label ("Pause 1", "Pause 2", …). */
  label: string;
  /** Pause duration in minutes (e.g. 5, 210 → 3h30). */
  durationMin: number;
  /** Repetition interval in minutes (e.g. 60 → every hour). */
  intervalMin: number;
}

export type RhythmGender = 'default' | 'male' | 'female';

/**
 * "Profil de rythme" : `preset` = un niveau par défaut (Débutant → Expert),
 * `custom` = "Personalisé" (activités .fit + FTP / poids / pneus saisis).
 */
export type RhythmProfileMode = 'preset' | 'custom';

export interface RhythmState {
  /** ISO date (yyyy-mm-dd) or null when empty. */
  startDate: string | null;
  /** 24h time (HH:MM) or null when empty. */
  startTime: string | null;
  /** Prediction engine gender override. `default` lets the backend decide. */
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
   * Per-POI pause durations (in minutes). Displayed in the expanded grid
   * below the "Ajouter des pauses à chaque POI favori" toggle (Figma
   * 1695:22638 Variant2). A value of `null` means the user has unchecked
   * that POI category — it still appears in the grid (greyed out) but is
   * excluded from routing. Keys mirror `PoiCategory`.
   */
  poiPauseDurations: Record<PoiCategory, number | null>;
  /**
   * Master toggle for "pauses par interval". When false the rows are kept in
   * `pauseIntervals` but the routing engine ignores them. When true and the
   * list is empty, the section auto-creates a single default row.
   */
  pauseEveryIntervalEnabled: boolean;
  /**
   * @deprecated kept for backward compatibility with previously-saved
   * projects that only stored a single "every N minutes" value. New code
   * should rely on `pauseIntervals`.
   */
  pauseEveryIntervalMin: number | null;
  /** User-defined pause rows displayed when the master toggle is on. */
  pauseIntervals: PauseIntervalRow[];
  /** Per-generated-pause distance overrides keyed by pause id. */
  pausePositionOverridesKm: Record<string, number>;

  // ── Trail / Running (ignored by the cycling engine) ──
  /** Which reference feeds the running engine: VMA or a race time. */
  runReferenceMode?: RunReferenceMode;
  /** Maximal aerobic speed (km/h). */
  vmaKmh?: number | null;
  /** Reference race distance (m) for `runReferenceMode === 'chrono'`. */
  refRaceDistanceM?: number | null;
  /** Reference race finish time (s). */
  refRaceTimeS?: number | null;
  /** Runner weight including pack (kg) — separate from the bike system weight. */
  runWeightKg?: number | null;
  /** Terrain technicality 0 (smooth) … 1 (very technical), trail only. */
  terrainTechnicality?: number | null;
}

export type RunReferenceMode = 'vma' | 'chrono';
