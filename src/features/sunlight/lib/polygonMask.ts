/**
 * Masque de rastérisation du polygone de la zone d'analyse, utilisé par les
 * workers d'ensoleillement (image d'ombres portées + carte d'ensoleillement
 * cumulé) pour rogner leur PNG au polygone dessiné par l'utilisateur.
 *
 * La projection est celle de l'échantillonnage de la grille d'altitudes dans
 * dem-grid-worker.ts / shadowWorker.ts : colonnes linéaires en longitude,
 * lignes linéaires en Y MERCATOR — PAS linéaires en latitude. Le même
 * appariement garde le masque parfaitement calé sur la grille colorée.
 *
 * Remplissage par lignes suréchantillonné 2× + réduction par moyenne 2×2 =
 * bord adouci d'environ une cellule (pas de crénelage contre la surcouche du
 * relief).
 */

export type MaskBounds = [number, number, number, number];

function mercY(latDeg: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latDeg));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + rad / 2));
}

/**
 * @param flatRing Anneau du polygone [lng, lat, lng, lat, …] (fermé ou ouvert).
 * @param bounds   Emprise de la grille échantillonnée [ouest, sud, est, nord].
 * @param w        Largeur de la grille, en cellules.
 * @param h        Hauteur de la grille, en cellules.
 * @returns masque w×h (255 dedans, 0 dehors, bord adouci) ou null quand
 *          l'anneau est dégénéré / entièrement hors de l'emprise.
 */
export function rasterizePolygonMask(
  flatRing: readonly number[],
  bounds: MaskBounds,
  w: number,
  h: number,
): Uint8Array | null {
  if (!Array.isArray(flatRing) || flatRing.length < 6 || w <= 0 || h <= 0) return null;
  const [west, south, east, north] = bounds;
  const spanX = east - west;
  // mercY croît vers le nord tandis que les lignes de la grille croissent vers le sud (ligne 0 = nord).
  const nMercY = mercY(north);
  const sMercY = mercY(south);
  const spanY = nMercY - sMercY;
  if (spanX <= 0 || spanY <= 0) return null;

  const count = Math.floor(flatRing.length / 2);
  const px = new Float64Array(count);
  const py = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const lng = flatRing[i * 2];
    const lat = flatRing[i * 2 + 1];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    px[i] = ((lng - west) / spanX) * w;
    py[i] = ((nMercY - mercY(lat)) / spanY) * h;
  }

  // Tampon de couverture suréchantillonné 2×.
  const ss = 2;
  const sw = w * ss;
  const sh = h * ss;
  const mask = new Uint8Array(sw * sh);
  const xs: number[] = [];
  for (let row = 0; row < sh; row++) {
    const sy = row + 0.5;
    xs.length = 0;
    for (let e = 0; e < count; e++) {
      const i1 = (e + 1) % count;
      const y0 = py[e];
      const y1 = py[i1];
      if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) {
        const t = (sy - y0) / (y1 - y0);
        xs.push(px[e] + t * (px[i1] - px[e]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const rowBase = row * sw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cx0 = Math.max(0, Math.ceil(xs[k] * ss));
      const cx1 = Math.min(sw - 1, Math.floor(xs[k + 1] * ss));
      for (let cx = cx0; cx <= cx1; cx++) mask[rowBase + cx] = 255;
    }
  }

  // Réduction par moyenne 2×2 → alpha adouci.
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    const sRow = r * ss * sw;
    const oRow = r * w;
    for (let c = 0; c < w; c++) {
      const s0 = sRow + c * ss;
      out[oRow + c] = (mask[s0] + mask[s0 + 1] + mask[s0 + sw] + mask[s0 + sw + 1]) >> 2;
    }
  }
  return out;
}

/** Applique le masque au canal alpha d'un tampon RGBA non prémultiplié. */
export function applyPolygonMaskToRgba(rgba: Uint8Array, mask: Uint8Array): void {
  const n = mask.length;
  for (let j = 0; j < n; j++) {
    const m = mask[j];
    if (m >= 255) continue;
    const idx = j * 4;
    if (m === 0) {
      rgba[idx + 3] = 0;
    } else {
      rgba[idx + 3] = ((rgba[idx + 3] * m) + 127) >> 8;
    }
  }
}
