import type { WindData } from '../wind-gl';

// ── Réexporte WindData pour que les consommateurs n'aient pas besoin de wind-gl ──
export type { WindData };

// ── Constantes de géométrie ────────────────────────────────────────────

export const LAYER_ID = 'wind-particles';
export const VERTEX_STRIDE = 7;        // x, y, z, r, g, b, a
export const EQUATORIAL_CIRCUMFERENCE = 40_075_017;

// ── Constantes de géométrie des traînées ───────────────────────────────

export const TRAIL_LENGTH = 64;                        // taille du tampon circulaire par particule
export const VERTS_PER_SEGMENT = 6;                    // 2 triangles par segment de traînée
export const MAX_TRAIL_SEGMENTS = TRAIL_LENGTH - 1;    // = 63

// ── Constantes de simulation ───────────────────────────────────────────

export const MAX_DELTA_SECONDS = 0.05;
export const DIRECTION_SMOOTH = 0.22;
export const FADE_IN_RATE = 4.5;
export const WIND_BLEND_DURATION = 1.2; // secondes de fondu enchaîné précédent → courant
export const DROP_RATE = 0.001;          // probabilité de base de renaissance aléatoire par image
export const DROP_RATE_BUMP = 0.001;     // taux de renaissance supplémentaire × speed_t

// ── Max allocation (avoids re-allocation on zoom) ──────────────────────

export const MAX_PARTICLE_ALLOC = 2000;
const PARTICLE_COUNT_REDUCTION_FACTOR = 3;

// ── Interfaces ─────────────────────────────────────────────────────────

export interface WindBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ParticleProgram {
  program: WebGLProgram;
  a_position: number;
  a_color: number;
  u_matrix: WebGLUniformLocation | null;
}

export interface SavedGLState {
  blend: boolean;
  depthTest: boolean;
  stencilTest: boolean;
  scissorTest: boolean;
  cullFace: boolean;
  depthMask: boolean;
  blendSrcRgb: number;
  blendDstRgb: number;
  blendSrcAlpha: number;
  blendDstAlpha: number;
  blendEquationRgb: number;
  blendEquationAlpha: number;
  activeTexture: number;
  program: WebGLProgram | null;
  framebuffer: WebGLFramebuffer | null;
  arrayBuffer: WebGLBuffer | null;
  viewport: Int32Array;
  attribEnabled: boolean[];
  polygonOffsetFill: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
}

export interface WindSample {
  u: number;
  v: number;
  speed: number;
}

// ── Fonctions utilitaires ──────────────────────────────────────────────

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── Fonctions de paramètres adaptatifs ─────────────────────────────────
// Tous les paramètres visuels sont des fonctions continues du zoom /
// de l'inclinaison / de la densité — pas de seuils fixes. Inspiré de Windy.com
// et earth.nullschool.net.

/** Nombre de particules — selon la densité à l'écran, pour une couverture uniforme à tous les zooms. */
export function adaptiveParticleCount(zoom: number, _viewportWidthDeg: number, _viewportHeightDeg: number): number {
  const zoomT = clamp((zoom - 4) / 12, 0, 1);
  return Math.max(1, Math.round(lerp(1000, MAX_PARTICLE_ALLOC, zoomT * zoomT) / PARTICLE_COUNT_REDUCTION_FACTOR));
}

/** Demi-largeur de la traînée en pixels d'écran. Lignes de courant visibles à tous les zooms. */
export function adaptiveTrailWidth(zoom: number, speed: number, dpr: number): number {
  const zoomT = clamp((zoom - 4) / 12, 0, 1);
  const basePx = lerp(2.0, 3.5, zoomT);
  const speedBoost = clamp(speed * 0.04, 0, 1.0);
  return (basePx + speedBoost) / Math.max(1, dpr * 0.75);
}

/** La durée de vie d'une particule s'adapte à la vitesse du vent (rapide = courte, lent = longue). */
export function adaptiveLifetime(speed: number): number {
  const t = clamp(speed / 25, 0, 1);
  return lerp(16, 5, t); // calme = 16 s, coup de vent = 5 s (plus long pour des traînées fluides)
}

/** Échelle de vitesse de simulation — exponentielle pour que les traînées restent ~150 px à tous les zooms.
 *  1_500_000 * 2^(-zoom) donne ~4,5 px d'écran par image à 60 fps pour un vent de 10 m/s. */
export function adaptiveSimulationScale(zoom: number): number {
  return clamp(1_500_000 * Math.pow(2, -zoom), 10, 50_000);
}

/** Correction de taille selon l'inclinaison : à forte inclinaison, les flèches vues de côté paraissent plus petites. */
export function pitchSizeCorrection(pitchDeg: number): number {
  const pitchRad = pitchDeg * Math.PI / 180;
  return 1 / Math.max(0.45, Math.cos(pitchRad));
}
