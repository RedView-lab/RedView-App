// ── Point de données de vent renvoyé par Open-Meteo ───────────────────

export interface WindPoint {
  lat: number;
  lng: number;
  /** Wind speed in m/s */
  speed: number;
  /** Direction météorologique du vent en degrés (0–360, d'où vient le vent) */
  direction: number;
  /** Wind gusts in m/s */
  gusts: number;
}

// ── Configuration de la grille d'échantillonnage de la vue ────────────

export interface WindGridConfig {
  /** Latitude minimale */
  south: number;
  /** Latitude maximale */
  north: number;
  /** Longitude minimale */
  west: number;
  /** Longitude maximale */
  east: number;
  /** Pas de la grille, en degrés */
  spacing: number;
}

export interface WindGridPoint {
  lat: number;
  lng: number;
  row: number;
  col: number;
}

export interface WindGridDefinition {
  bounds: WindGridConfig;
  rows: number;
  cols: number;
  spacing: number;
  points: WindGridPoint[];
}

export type WindDataSource = 'self-hosted-vps' | 'unknown';

// ── État du hook renvoyé par useWind ──────────────────────────────────

export interface WindTimeSelection {
  date: string;
  time: string;
  forecastDay?: number;
}

export interface WindState {
  loading: boolean;
  error: string | null;
  pointCount: number;
  lastUpdate: number | null;
  progress: number;
  detail: string | null;
  source: WindDataSource | null;
}
