import type { WindGridDefinition } from '../types';

// ── Correspondance zoom → pas de grille ───────────────────────────────
// Utilise une grille régulière alignée sur la vue pour que le champ de vent
// puisse être récupéré directement du VPS et envoyé au GPU sans
// reconstruction IDW.

const SPACING_TABLE: [number, number][] = [
  [3, 0.6],
  [4, 0.3],
  [5, 0.16],
  [6, 0.08],
  [7, 0.04],
  [8, 0.02],
  [9, 0.01],
  [10, 0.005],
  [11, 0.0025],
  [12, 0.00125],
];

const MIN_SPACING = 0.00125;
const MIN_POINTS = 576;
const MAX_POINTS = 3_072;

/**
 * Pas de grille (degrés) pour un niveau de zoom donné.
 * Interpole entre les entrées de la table puis s'aligne sur la subdivision de
 * 1° en puissance de 2 la plus proche, pour garder la grille alignée.
 */
function spacingForZoom(zoom: number): number {
  if (zoom <= SPACING_TABLE[0][0]) return SPACING_TABLE[0][1];

  let raw = MIN_SPACING;
  for (let i = 1; i < SPACING_TABLE.length; i++) {
    const [z1, s1] = SPACING_TABLE[i - 1];
    const [z2, s2] = SPACING_TABLE[i];
    if (zoom <= z2) {
      const t = (zoom - z1) / (z2 - z1);
      raw = s1 + t * (s2 - s1);
      break;
    }
  }

  // S'aligne sur la fraction de 1° en puissance de 2 la plus proche pour
  // l'alignement de la grille : p. ex. 0.07 → 0.0625, 0.18 → 0.125, etc.
  if (raw >= 0.01) {
    const log2 = Math.round(Math.log2(1 / raw));
    raw = 1 / Math.pow(2, log2);
  }

  return Math.max(raw, MIN_SPACING);
}

/**
 * Arrondit une coordonnée au pas de grille le plus proche.
 */
function snapToGrid(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function snapDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function snapUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function estimatedPointCount(
  bounds: { north: number; south: number; east: number; west: number },
  spacing: number,
): number {
  const latSteps = Math.floor((bounds.north - bounds.south) / spacing) + 1;
  const lngSteps = Math.floor((bounds.east - bounds.west) / spacing) + 1;
  return Math.max(0, latSteps) * Math.max(0, lngSteps);
}

function spacingForBudget(
  bounds: { north: number; south: number; east: number; west: number },
  baseSpacing: number,
  maxPoints: number,
): number {
  let currentSpacing = baseSpacing;

  for (let attempt = 0; attempt < 10; attempt++) {
    const total = estimatedPointCount(bounds, currentSpacing);
    if (total <= maxPoints) break;
    currentSpacing *= Math.sqrt(total / maxPoints) * 1.05;
  }

  return currentSpacing;
}

function maxPointsForZoom(zoom: number): number {
  const boostedBudget = MIN_POINTS + Math.max(0, Math.round((zoom - 4) * 320));
  return Math.max(MIN_POINTS, Math.min(MAX_POINTS, boostedBudget));
}

/**
 * Calcule une grille de vent régulière couvrant l'emprise récupérée.
 * Les points renvoyés sont ligne par ligne (haut = nord, gauche = ouest) pour
 * être envoyés directement comme texture de vent, sans passe de reconstruction.
 */
export function computeWindGrid(
  bounds: { north: number; south: number; east: number; west: number },
  _viewportBounds: { north: number; south: number; east: number; west: number },
  zoom: number,
): WindGridDefinition {
  const maxPoints = maxPointsForZoom(zoom);
  let spacing = spacingForBudget(bounds, spacingForZoom(zoom), maxPoints);

  let north = snapToGrid(bounds.north, spacing);
  let south = snapToGrid(bounds.south, spacing);
  let east = snapToGrid(bounds.east, spacing);
  let west = snapToGrid(bounds.west, spacing);
  let rows = 0;
  let cols = 0;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    north = Math.min(90, snapUp(bounds.north, spacing));
    south = Math.max(-90, snapDown(bounds.south, spacing));
    east = Math.min(180, snapUp(bounds.east, spacing));
    west = Math.max(-180, snapDown(bounds.west, spacing));
    rows = Math.max(2, Math.round((north - south) / spacing) + 1);
    cols = Math.max(2, Math.round((east - west) / spacing) + 1);
    if (rows * cols <= maxPoints) break;
    spacing = spacingForBudget({ north, south, east, west }, spacing * 1.12, maxPoints);
  }

  const points = [] as WindGridDefinition['points'];
  for (let row = 0; row < rows; row += 1) {
    const lat = Math.max(-90, Math.min(90, Math.round((north - row * spacing) * 1e6) / 1e6));
    for (let col = 0; col < cols; col += 1) {
      const lng = Math.max(-180, Math.min(180, Math.round((west + col * spacing) * 1e6) / 1e6));
      points.push({ lat, lng, row, col });
    }
  }

  return {
    bounds: { north, south, east, west, spacing },
    rows,
    cols,
    spacing,
    points,
  };
}

/**
 * Crée une clé de cache stable pour une paire de coordonnées (arrondie à la
 * précision de la grille).
 */
export function coordCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}
