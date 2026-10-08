// Échantillonnage orthophoto des couleurs des points (pur : ni DOM ni réseau),
// utilisé par `colorizePointCloud` une fois décodées les tuiles WMTS de l'emprise de la tuile.

export const ORTHO_TILE_SIZE = 256;
const DEFAULT_GREY = 128;

/** Tuiles RGBA décodées de l'emprise, par colonnes : slot = col · rows + row. */
export interface OrthoTileGrid {
  minTileCol: number;
  minTileRow: number;
  cols: number;
  rows: number;
  tiles: ReadonlyArray<Uint8Array | null>;
}

/**
 * Point (relatif à l'origine du nuage) → pixel WMTS absolu : interpolation
 * bilinéaire des positions en pixels des quatre coins de l'emprise.
 */
export interface OrthoPixelMapping {
  xMin: number;
  yMin: number;
  invDx: number;
  invDy: number;
  px00: number; py00: number;
  px10: number; py10: number;
  px01: number; py01: number;
  px11: number; py11: number;
}

/**
 * Slot, dans le tableau par colonnes des tuiles ortho, de la tuile contenant
 * un pixel absolu, ou -1 hors de la plage chargée. Tester col et row
 * séparément compte : une borne unique sur `col·rows + row` laissait une ligne
 * juste après la dernière retomber sur la première tuile de la colonne suivante.
 */
export function orthoTileSlot(absPx: number, absPy: number, minCol: number, minRow: number, cols: number, rows: number): number {
  const col = (absPx >> 8) - minCol;
  const row = (absPy >> 8) - minRow;
  return col >= 0 && col < cols && row >= 0 && row < rows ? col * rows + row : -1;
}

/**
 * Colore les points [start, end) par échantillonnage bilinéaire des tuiles
 * ortho ; les échantillons hors des tuiles chargées sont exclus des poids, et un
 * point sans aucun échantillon reçoit un gris moyen. Quand l'empreinte 2×2 tient
 * dans une tuile (tous les pixels de chaque tuile sauf la dernière ligne/colonne),
 * la tuile n'est cherchée qu'une fois : même arithmétique dans le même ordre,
 * donc les mêmes octets que le chemin par échantillon.
 */
export function sampleOrthoColors(
  positions: Float32Array,
  colors: Uint8Array,
  start: number,
  end: number,
  mapping: OrthoPixelMapping,
  grid: OrthoTileGrid,
): void {
  const { xMin, yMin, invDx, invDy, px00, py00, px10, py10, px01, py01, px11, py11 } = mapping;
  const { minTileCol, minTileRow, cols, rows, tiles } = grid;
  const rowStride = ORTHO_TILE_SIZE * 4;

  for (let i = start; i < end; i++) {
    const fx = (positions[i * 3]! - xMin) * invDx;
    const fy = (positions[i * 3 + 1]! - yMin) * invDy;
    const fx1 = 1 - fx;
    const fy1 = 1 - fy;

    const absPx = fx1 * fy1 * px00 + fx * fy1 * px10 + fx1 * fy * px01 + fx * fy * px11;
    const absPy = fx1 * fy1 * py00 + fx * fy1 * py10 + fx1 * fy * py01 + fx * fy * py11;

    const floorPx = absPx | 0;
    const floorPy = absPy | 0;
    const fracX = absPx - floorPx;
    const fracY = absPy - floorPy;

    const w00 = (1 - fracX) * (1 - fracY);
    const w10 = fracX * (1 - fracY);
    const w01 = (1 - fracX) * fracY;
    const w11 = fracX * fracY;

    let r = 0, g = 0, b = 0, hits = 0;
    const localX = floorPx & 255;
    const localY = floorPy & 255;

    if (localX !== 255 && localY !== 255) {
      const slot = orthoTileSlot(floorPx, floorPy, minTileCol, minTileRow, cols, rows);
      const pixels = slot >= 0 ? tiles[slot] : null;
      if (pixels) {
        const p = (localY * ORTHO_TILE_SIZE + localX) * 4;
        const q = p + rowStride;
        r += pixels[p]! * w00; g += pixels[p + 1]! * w00; b += pixels[p + 2]! * w00; hits += w00;
        r += pixels[p + 4]! * w10; g += pixels[p + 5]! * w10; b += pixels[p + 6]! * w10; hits += w10;
        r += pixels[q]! * w01; g += pixels[q + 1]! * w01; b += pixels[q + 2]! * w01; hits += w01;
        r += pixels[q + 4]! * w11; g += pixels[q + 5]! * w11; b += pixels[q + 6]! * w11; hits += w11;
      }
    } else {
      for (let s = 0; s < 4; s++) {
        const spx = floorPx + (s & 1);
        const spy = floorPy + (s >> 1);
        const slot = orthoTileSlot(spx, spy, minTileCol, minTileRow, cols, rows);
        const pixels = slot >= 0 ? tiles[slot] : null;
        if (!pixels) continue;
        const w = s === 0 ? w00 : s === 1 ? w10 : s === 2 ? w01 : w11;
        const p = ((spy & 255) * ORTHO_TILE_SIZE + (spx & 255)) * 4;
        r += pixels[p]! * w;
        g += pixels[p + 1]! * w;
        b += pixels[p + 2]! * w;
        hits += w;
      }
    }

    const ci = i * 3;
    if (hits > 0) {
      const inv = 1 / hits;
      colors[ci] = (r * inv + 0.5) | 0;
      colors[ci + 1] = (g * inv + 0.5) | 0;
      colors[ci + 2] = (b * inv + 0.5) | 0;
    } else {
      colors[ci] = DEFAULT_GREY;
      colors[ci + 1] = DEFAULT_GREY;
      colors[ci + 2] = DEFAULT_GREY;
    }
  }
}
