// ============================================================================
// Moteur neige v2 — grille de travail et géométrie de la scène
// ----------------------------------------------------------------------------
// La grille de travail est une grille de nœuds sur l'emprise de la scène (ligne
// 0 = sud, x vers l'est, y vers le nord de la grille). Les positions
// géographiques viennent des quatre nœuds de coin : sur quelques kilomètres, le
// mélange bilinéaire de leurs coordonnées WGS84 est exact à bien moins d'un
// mètre, donc le worker n'a jamais besoin de bibliothèque de projection.
// ============================================================================

import type { EngineDem, LonLat, SceneGeo } from './types';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

export interface WorkGrid {
  width: number;
  height: number;
  /** Pas entre nœuds, m. */
  dx: number;
  dy: number;
  /** Pas moyen entre nœuds, m (différences finies, distances en pixels). */
  ps: number;
  sizeX: number;
  sizeY: number;
  /** Altitude absolue, m. */
  z: Float32Array;
}

/** Table de sommes cumulées d'une grille (f64), avec une ligne / colonne de zéros en plus. */
function summedArea(src: Float32Array, w: number, h: number): Float64Array {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  return sat;
}

/** Moyenne par blocs de rayon r (pixels) autour de chaque nœud, bords bornés. */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return new Float32Array(src);
  const sat = summedArea(src, w, h);
  const out = new Float32Array(w * h);
  const W = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r) + 1;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r) + 1;
      const s = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Échantillon bilinéaire d'une grille de nœuds à des coordonnées de nœud fractionnaires (bornées). */
export function sampleBilinear(src: Float32Array, w: number, h: number, fx: number, fy: number): number {
  const x = Math.min(w - 1, Math.max(0, fx));
  const y = Math.min(h - 1, Math.max(0, fy));
  const x0 = Math.min(w - 2, Math.floor(x));
  const y0 = Math.min(h - 2, Math.floor(y));
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * w + x0;
  const a = src[i] + (src[i + 1] - src[i]) * tx;
  const b = src[i + w] + (src[i + w + 1] - src[i + w]) * tx;
  return a + (b - a) * ty;
}

/**
 * Rééchantillonne une grille de nœuds (même emprise) en `w × h` nœuds : préfiltre
 * par blocs au rapport de décimation, puis bilinéaire. Les valeurs source non
 * finies sont d'abord remplies.
 */
export function resampleNodeGrid(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
  if (sw === w && sh === h) return new Float32Array(src);
  const ratio = Math.max((sw - 1) / Math.max(1, w - 1), (sh - 1) / Math.max(1, h - 1));
  const filtered = ratio > 1.5 ? boxMean(src, sw, sh, Math.floor(ratio / 2)) : src;
  const out = new Float32Array(w * h);
  const sx = (sw - 1) / Math.max(1, w - 1);
  const sy = (sh - 1) / Math.max(1, h - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = sampleBilinear(filtered, sw, sh, x * sx, y * sy);
    }
  }
  return out;
}

/** Remplace les cellules non finies par la moyenne des cellules finies (un trou du MNT ne doit pas empoisonner les filtres). */
function fillNonFinite(src: Float32Array): Float32Array {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  if (n === src.length) return src;
  const mean = n > 0 ? sum / n : 0;
  const out = new Float32Array(src);
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = mean;
  return out;
}

export function buildWorkGrid(dem: EngineDem, maxResolution: number): WorkGrid {
  const cap = Math.max(32, Math.round(maxResolution));
  const scale = Math.min(1, (cap - 1) / Math.max(dem.width - 1, dem.height - 1));
  const width = Math.max(2, Math.round((dem.width - 1) * scale) + 1);
  const height = Math.max(2, Math.round((dem.height - 1) * scale) + 1);
  const z = resampleNodeGrid(fillNonFinite(dem.data), dem.width, dem.height, width, height);
  const dx = dem.sizeX / (width - 1);
  const dy = dem.sizeY / (height - 1);
  return { width, height, dx, dy, ps: (dx + dy) / 2, sizeX: dem.sizeX, sizeY: dem.sizeY, z };
}

/** Aide géographique pour la scène : nœud ↔ WGS84 et un repère métrique local. */
export class SceneFrame {
  readonly center: LonLat;
  readonly gridNorthBearingDeg: number;
  private readonly corners: SceneGeo['corners'];
  private readonly mPerDegLon: number;

  constructor(geo: SceneGeo) {
    this.corners = geo.corners;
    this.gridNorthBearingDeg = geo.gridNorthBearingDeg;
    const [sw, se, ne, nw] = geo.corners;
    this.center = {
      lon: (sw.lon + se.lon + ne.lon + nw.lon) / 4,
      lat: (sw.lat + se.lat + ne.lat + nw.lat) / 4,
    };
    this.mPerDegLon = M_PER_DEG_LON_EQ * Math.cos(this.center.lat * DEG);
  }

  /** WGS84 du point aux coordonnées normalisées de la scène (u vers l'est, v vers le nord, 0–1). */
  lonLatAt(u: number, v: number): LonLat {
    const [sw, se, ne, nw] = this.corners;
    const lonS = sw.lon + (se.lon - sw.lon) * u;
    const lonN = nw.lon + (ne.lon - nw.lon) * u;
    const latS = sw.lat + (se.lat - sw.lat) * u;
    const latN = nw.lat + (ne.lat - nw.lat) * u;
    return { lon: lonS + (lonN - lonS) * v, lat: latS + (latN - latS) * v };
  }

  /** Repère métrique local (est, nord), m, autour du centre de la scène (équirectangulaire). */
  toLocal(lon: number, lat: number): { e: number; n: number } {
    return { e: (lon - this.center.lon) * this.mPerDegLon, n: (lat - this.center.lat) * M_PER_DEG_LAT };
  }

  distanceKm(lon: number, lat: number): number {
    const p = this.toLocal(lon, lat);
    return Math.hypot(p.e, p.n) / 1000;
  }

  /** Azimut de grille (degrés, depuis le nord de la grille) d'un azimut vrai. */
  toGridAzimuth(trueDeg: number): number {
    return (((trueDeg - this.gridNorthBearingDeg) % 360) + 360) % 360;
  }

  /**
   * Coordonnées normalisées de la scène (u, v) d'un point WGS84, en inversant le
   * mélange bilinéaire des coins (Newton, converge en 2 ou 3 pas sur une
   * application quasi affine).
   */
  sceneUvOf(lon: number, lat: number): { u: number; v: number } {
    let u = 0.5;
    let v = 0.5;
    for (let it = 0; it < 6; it++) {
      const p = this.lonLatAt(u, v);
      const pu = this.lonLatAt(u + 1e-4, v);
      const pv = this.lonLatAt(u, v + 1e-4);
      const a = (pu.lon - p.lon) / 1e-4;
      const b = (pv.lon - p.lon) / 1e-4;
      const c = (pu.lat - p.lat) / 1e-4;
      const d = (pv.lat - p.lat) / 1e-4;
      const det = a * d - b * c;
      if (Math.abs(det) < 1e-18) break;
      const rl = lon - p.lon;
      const rt = lat - p.lat;
      u += (d * rl - b * rt) / det;
      v += (-c * rl + a * rt) / det;
    }
    return { u, v };
  }
}

/** Coordonnées WGS84 par nœud de la grille de travail (ligne par ligne). */
export function nodeLonLat(frame: SceneFrame, w: number, h: number): { lon: Float64Array; lat: Float64Array } {
  const lon = new Float64Array(w * h);
  const lat = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      const p = frame.lonLatAt(w > 1 ? x / (w - 1) : 0, v);
      lon[y * w + x] = p.lon;
      lat[y * w + x] = p.lat;
    }
  }
  return { lon, lat };
}
