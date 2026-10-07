// Pixel-exact hit testing of the POI sprites.
//
// Mapbox hit-tests a symbol on its whole image, and the POI sprites carry
// transparent padding (baked shadows, a canvas made symmetric around the
// geographic anchor): a 19 px disc sits in a 66 px image, a favourite pin in
// an 88×126 px image centred on its tip. A click 30 px below a pin opened it,
// and the padding of a neighbour covered a favourite drawn on top of it.
//
// Each sprite gets a mask of what is really drawn — alpha ≥ 50 %, so the soft
// shadows (≤ 45 %) are left out — with a chamfer distance field: the map picks
// the topmost POI whose drawn pixels are under the pointer, else the nearest
// one within a small tolerance.

/** Alpha from which a sprite pixel counts as drawn (shadows stay below). */
const DRAWN_ALPHA_MIN = 128;
/** Chamfer 3-4 weights (orthogonal, diagonal), in thirds of a cell. */
const CHAMFER_ORTHO = 3;
const CHAMFER_DIAG = 4;
/** Distances are stored in quarter px, capped (255 = 63.75 px or more). */
const DISTANCE_STEPS_PER_PX = 4;
const DISTANCE_CAP = 255;

export interface PoiHitBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PoiHitMask {
  /** Grid size, one cell per CSS px at icon-size 1. */
  width: number;
  height: number;
  /** Geographic anchor inside the grid (CSS px at icon-size 1). */
  anchorX: number;
  anchorY: number;
  /** Distance of each cell to the nearest drawn cell, in quarter px. */
  distance: Uint8Array;
  /** Drawn extent around the anchor (CSS px at icon-size 1); null when nothing is drawn. */
  bounds: PoiHitBounds | null;
}

/**
 * Mask of a rasterised sprite. `rgba` is its `ImageData.data`
 * (`imageWidth × imageHeight` device px at `pixelRatio`), the anchor is given
 * in CSS px from the image's top-left corner.
 */
export function buildPoiHitMask(
  rgba: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
  pixelRatio: number,
  anchorX: number,
  anchorY: number,
): PoiHitMask {
  const ratio = pixelRatio > 0 ? pixelRatio : 1;
  const width = Math.max(1, Math.ceil(imageWidth / ratio));
  const height = Math.max(1, Math.ceil(imageHeight / ratio));
  const drawn = new Uint8Array(width * height);

  for (let y = 0; y < imageHeight; y += 1) {
    const row = Math.min(height - 1, Math.floor(y / ratio)) * width;
    for (let x = 0; x < imageWidth; x += 1) {
      if (rgba[(y * imageWidth + x) * 4 + 3]! >= DRAWN_ALPHA_MIN) {
        drawn[row + Math.min(width - 1, Math.floor(x / ratio))] = 1;
      }
    }
  }

  let minCx = Infinity;
  let minCy = Infinity;
  let maxCx = -Infinity;
  let maxCy = -Infinity;
  const far = (width + height) * CHAMFER_DIAG;
  const chamfer = new Uint32Array(width * height);
  for (let cy = 0; cy < height; cy += 1) {
    for (let cx = 0; cx < width; cx += 1) {
      const index = cy * width + cx;
      if (drawn[index]) {
        chamfer[index] = 0;
        if (cx < minCx) minCx = cx;
        if (cx > maxCx) maxCx = cx;
        if (cy < minCy) minCy = cy;
        if (cy > maxCy) maxCy = cy;
      } else {
        chamfer[index] = far;
      }
    }
  }

  // Two-pass chamfer distance transform.
  for (let cy = 0; cy < height; cy += 1) {
    for (let cx = 0; cx < width; cx += 1) {
      const index = cy * width + cx;
      let d = chamfer[index]!;
      if (d === 0) continue;
      if (cx > 0) d = Math.min(d, chamfer[index - 1]! + CHAMFER_ORTHO);
      if (cy > 0) {
        d = Math.min(d, chamfer[index - width]! + CHAMFER_ORTHO);
        if (cx > 0) d = Math.min(d, chamfer[index - width - 1]! + CHAMFER_DIAG);
        if (cx < width - 1) d = Math.min(d, chamfer[index - width + 1]! + CHAMFER_DIAG);
      }
      chamfer[index] = d;
    }
  }
  for (let cy = height - 1; cy >= 0; cy -= 1) {
    for (let cx = width - 1; cx >= 0; cx -= 1) {
      const index = cy * width + cx;
      let d = chamfer[index]!;
      if (d === 0) continue;
      if (cx < width - 1) d = Math.min(d, chamfer[index + 1]! + CHAMFER_ORTHO);
      if (cy < height - 1) {
        d = Math.min(d, chamfer[index + width]! + CHAMFER_ORTHO);
        if (cx < width - 1) d = Math.min(d, chamfer[index + width + 1]! + CHAMFER_DIAG);
        if (cx > 0) d = Math.min(d, chamfer[index + width - 1]! + CHAMFER_DIAG);
      }
      chamfer[index] = d;
    }
  }

  const distance = new Uint8Array(width * height);
  for (let index = 0; index < distance.length; index += 1) {
    const steps = Math.round((chamfer[index]! / CHAMFER_ORTHO) * DISTANCE_STEPS_PER_PX);
    distance[index] = Math.min(DISTANCE_CAP, steps);
  }

  return {
    width,
    height,
    anchorX,
    anchorY,
    distance,
    bounds: Number.isFinite(minCx)
      ? {
          minX: minCx - anchorX,
          minY: minCy - anchorY,
          maxX: maxCx + 1 - anchorX,
          maxY: maxCy + 1 - anchorY,
        }
      : null,
  };
}

/**
 * Distance from a point to the drawn pixels of the sprite, in CSS px at
 * icon-size 1. `localX/Y` are relative to the anchor; 0 = on a drawn pixel.
 */
export function poiHitDistancePx(mask: PoiHitMask, localX: number, localY: number): number {
  if (!mask.bounds) return Infinity;
  const gx = localX + mask.anchorX;
  const gy = localY + mask.anchorY;
  // Outside the image: distance to its edge plus that edge cell's distance.
  const cx = Math.min(mask.width - 1, Math.max(0, Math.floor(gx)));
  const cy = Math.min(mask.height - 1, Math.max(0, Math.floor(gy)));
  const outsideX = gx < 0 ? -gx : gx > mask.width ? gx - mask.width : 0;
  const outsideY = gy < 0 ? -gy : gy > mask.height ? gy - mask.height : 0;
  const stored = mask.distance[cy * mask.width + cx]!;
  const inside = stored >= DISTANCE_CAP ? Infinity : stored / DISTANCE_STEPS_PER_PX;
  return inside + Math.hypot(outsideX, outsideY);
}

/** Where a candidate is drawn: its anchor on screen and its scale (icon-size). */
export interface PoiHitPlacement {
  x: number;
  y: number;
  scale: number;
}

export interface PoiHitCandidate<K> {
  key: K;
  mask: PoiHitMask;
  /** Drawing order: a higher rank is drawn above. */
  drawRank: number;
  /** One or more placements (the hovered POI: resting and lifted); the closest counts. */
  placements: readonly PoiHitPlacement[];
}

/**
 * POI under a screen point: the topmost one whose drawn pixels contain it,
 * else the nearest one within `tolerancePx` (screen px), the topmost on a tie.
 */
export function pickPoiHit<K>(
  candidates: readonly PoiHitCandidate<K>[],
  point: { x: number; y: number },
  tolerancePx: number,
): K | null {
  let bestKey: K | null = null;
  let bestDistance = Infinity;
  let bestRank = -Infinity;
  for (const candidate of candidates) {
    let distance = Infinity;
    for (const placement of candidate.placements) {
      if (!(placement.scale > 0)) continue;
      const local = poiHitDistancePx(
        candidate.mask,
        (point.x - placement.x) / placement.scale,
        (point.y - placement.y) / placement.scale,
      ) * placement.scale;
      if (local < distance) distance = local;
    }
    if (!(distance <= tolerancePx)) continue;
    const closer = distance < bestDistance;
    const tieAbove = distance === bestDistance && candidate.drawRank > bestRank;
    if (closer || tieAbove) {
      bestKey = candidate.key;
      bestDistance = distance;
      bestRank = candidate.drawRank;
    }
  }
  return bestKey;
}
