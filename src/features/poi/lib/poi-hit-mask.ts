// Test de clic au pixel près sur les sprites des POI.
//
// Mapbox teste un symbole sur toute son image, et les sprites des POI portent
// une marge transparente (ombres intégrées, canvas rendu symétrique autour de
// l'ancrage géographique) : un disque de 19 px tient dans une image de 66 px,
// une épingle de favori dans une image de 88×126 px centrée sur sa pointe. Un
// clic 30 px sous une épingle l'ouvrait, et la marge d'un voisin couvrait un
// favori dessiné par-dessus.
//
// Chaque sprite reçoit un masque de ce qui est vraiment dessiné — alpha ≥ 50 %,
// pour laisser de côté les ombres douces (≤ 45 %) — avec un champ de distance
// de chanfrein : la carte choisit le POI le plus haut dont des pixels dessinés
// sont sous le pointeur, sinon le plus proche dans une petite tolérance.

/** Alpha à partir duquel un pixel de sprite compte comme dessiné (les ombres restent en dessous). */
const DRAWN_ALPHA_MIN = 128;
/** Poids du chanfrein 3-4 (orthogonal, diagonal), en tiers de cellule. */
const CHAMFER_ORTHO = 3;
const CHAMFER_DIAG = 4;
/** Distances stockées en quarts de px, plafonnées (255 = 63,75 px ou plus). */
const DISTANCE_STEPS_PER_PX = 4;
const DISTANCE_CAP = 255;

interface PoiHitBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PoiHitMask {
  /** Taille de la grille, une cellule par px CSS à icon-size 1. */
  width: number;
  height: number;
  /** Ancrage géographique dans la grille (px CSS à icon-size 1). */
  anchorX: number;
  anchorY: number;
  /** Distance de chaque cellule à la cellule dessinée la plus proche, en quarts de px. */
  distance: Uint8Array;
  /** Étendue dessinée autour de l'ancrage (px CSS à icon-size 1) ; null quand rien n'est dessiné. */
  bounds: PoiHitBounds | null;
}

/**
 * Masque d'un sprite rastérisé. `rgba` est son `ImageData.data`
 * (`imageWidth × imageHeight` px physiques à `pixelRatio`), l'ancrage est
 * donné en px CSS depuis le coin haut gauche de l'image.
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

  // Transformée de distance de chanfrein en deux passes.
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
 * Distance d'un point aux pixels dessinés du sprite, en px CSS à icon-size 1.
 * `localX/Y` sont relatifs à l'ancrage ; 0 = sur un pixel dessiné.
 */
export function poiHitDistancePx(mask: PoiHitMask, localX: number, localY: number): number {
  if (!mask.bounds) return Infinity;
  const gx = localX + mask.anchorX;
  const gy = localY + mask.anchorY;
  // Hors de l'image : distance à son bord plus la distance de cette cellule de bord.
  const cx = Math.min(mask.width - 1, Math.max(0, Math.floor(gx)));
  const cy = Math.min(mask.height - 1, Math.max(0, Math.floor(gy)));
  const outsideX = gx < 0 ? -gx : gx > mask.width ? gx - mask.width : 0;
  const outsideY = gy < 0 ? -gy : gy > mask.height ? gy - mask.height : 0;
  const stored = mask.distance[cy * mask.width + cx]!;
  const inside = stored >= DISTANCE_CAP ? Infinity : stored / DISTANCE_STEPS_PER_PX;
  return inside + Math.hypot(outsideX, outsideY);
}

/** Où un candidat est dessiné : son ancrage à l'écran et son échelle (icon-size). */
interface PoiHitPlacement {
  x: number;
  y: number;
  scale: number;
}

export interface PoiHitCandidate<K> {
  key: K;
  mask: PoiHitMask;
  /** Ordre de dessin : un rang plus élevé est dessiné au-dessus. */
  drawRank: number;
  /** Un ou plusieurs placements (le POI survolé : au repos et soulevé) ; le plus proche compte. */
  placements: readonly PoiHitPlacement[];
}

/**
 * POI sous un point de l'écran : le plus haut dont les pixels dessinés le
 * contiennent, sinon le plus proche dans `tolerancePx` (px d'écran), le plus
 * haut en cas d'égalité.
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
