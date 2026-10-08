// ============================================
// Outils du viewer LiDAR — lancer de rayon sur le nuage de points (CPU)
// ============================================
//
// Choisit le retour LiDAR le plus en avant à quelques pixels d'un rayon écran,
// parmi les nœuds LOD dessinés dans cette image : ce que l'utilisateur voit
// vraiment (couronne d'arbre, falaise, toit), pas le modèle de sol dessous. Les
// blocs de nœuds sont lus dans le cache LOD (les mêmes tranches OPFS qui ont
// alimenté le GPU) et gardés dans un petit LRU : des choix successifs dans une
// même zone restent instantanés.

import { readLodNodeBlock, type OpenedLodTile } from '../../../lib/lodCache';
import { LOD_POINT_STRIDE, lodNodeCube, lodNodeSpacing } from '../../lod/lodTile';
import type { SceneNode } from '../../lod/sceneLod';
import type { Vec3 } from '../types';

export interface PointPickQuery {
  origin: Vec3;
  /** Direction unitaire. */
  direction: Vec3;
  /** Rayon de sélection par mètre le long du rayon (cône de pixels). */
  radiusPerMeter: number;
  /** Plancher du rayon de sélection (un demi-diamètre de point), m. */
  minRadiusM: number;
  /** Les retours au-delà de cette distance sont cachés (derrière le sol), m. */
  maxDistance: number;
}

export interface PointPickHit {
  local: Vec3;
  /** Distance le long du rayon, m. */
  distance: number;
  classification: number;
}

interface Candidate {
  node: SceneNode;
  enter: number;
}

/** Budget LRU des blocs de nœuds décodés, octets. */
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
/** Nombre maximal de blocs de nœuds parcourus par sélection. */
const MAX_NODES_PER_PICK = 96;
/** Les classes de bruit ASPRS (bruit bas/haut) ne sont jamais choisies. */
const NOISE_CLASSES = new Set([7, 18]);

export class PointCloudPicker {
  private readonly cache = new Map<number, ArrayBuffer>();
  private cacheBytes = 0;

  private readonly tiles: readonly OpenedLodTile[];
  private readonly getDrawnNodes: () => readonly SceneNode[];
  private readonly isClassVisible: (classification: number) => boolean;

  constructor(
    tiles: readonly OpenedLodTile[],
    getDrawnNodes: () => readonly SceneNode[],
    isClassVisible: (classification: number) => boolean,
  ) {
    this.tiles = tiles;
    this.getDrawnNodes = getDrawnNodes;
    this.isClassVisible = isClassVisible;
  }

  async pick(query: PointPickQuery): Promise<PointPickHit | null> {
    const candidates = this.collectCandidates(query);
    let best: PointPickHit | null = null;
    for (const { node, enter } of candidates) {
      if (best && enter > best.distance) break;
      const block = await this.readBlock(node);
      if (!block) continue;
      const hit = this.scanBlock(node, block, query, best?.distance ?? query.maxDistance);
      if (hit) best = hit;
    }
    return best;
  }

  /**
   * Parcourt chaque retour (bruit exclu) des nœuds LOD dessinés dans une boîte
   * en plan du repère de rendu (x est, z = −nord), quel que soit le filtre de
   * classes : les outils de terrain lisent le couvert du sol, pas ce qui est affiché.
   */
  async forEachPointInBox(
    box: { minX: number; maxX: number; minZ: number; maxZ: number },
    visit: (x: number, y: number, z: number, classification: number) => void,
  ): Promise<void> {
    const nodes = this.getDrawnNodes().filter((node) => !node.virtual && node.entry.count > 0
      && node.maxX >= box.minX && node.minX <= box.maxX && node.maxZ >= box.minZ && node.minZ <= box.maxZ);
    for (const node of nodes) {
      const block = await this.readBlock(node);
      if (!block) continue;
      const count = Math.min(node.entry.count, Math.floor(block.byteLength / LOD_POINT_STRIDE));
      const words = new Uint16Array(block, 0, (count * LOD_POINT_STRIDE) >> 1);
      const bytes = new Uint8Array(block, 0, count * LOD_POINT_STRIDE);
      const s = node.size / 65535;
      const step = LOD_POINT_STRIDE >> 1;
      for (let p = 0, w = 0; p < count; p++, w += step) {
        const x = node.originX + words[w]! * s;
        const z = node.originZ - words[w + 1]! * s;
        if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
        const cls = bytes[p * LOD_POINT_STRIDE + 6]!;
        if (NOISE_CLASSES.has(cls)) continue;
        visit(x, node.originY + words[w + 2]! * s, z, cls);
      }
    }
  }

  /**
   * Parcourt chaque retour (bruit exclu) de la scène dans une boîte en plan du
   * CRS, jusqu'à un espacement d'octree d'environ `spacingM`, quoi que montre la
   * caméra : les analyses surfaciques ne doivent pas dépendre de la vue. Les
   * positions sont absolues (CRS x est, y nord, altitude). Les blocs sont lus
   * directement dans le cache LOD, pas gardés dans le LRU de sélection.
   */
  async forEachPointToSpacing(
    box: { minX: number; minY: number; maxX: number; maxY: number },
    spacingM: number,
    visit: (projX: number, projY: number, altitudeM: number, classification: number) => void,
  ): Promise<void> {
    for (const tile of this.tiles) {
      const { header } = tile;
      for (const node of tile.nodes) {
        // Octree additif : un niveau ajoute des points entre ceux de son parent,
        // les niveaux jusqu'à l'espacement donnent donc cette densité partout.
        if (node.count === 0 || lodNodeSpacing(header, node.depth) < spacingM * 0.75) continue;
        const cube = lodNodeCube(header, node);
        const x0 = header.origin.x + cube.minX;
        const y0 = header.origin.y + cube.minY;
        if (x0 > box.maxX || y0 > box.maxY || x0 + cube.size < box.minX || y0 + cube.size < box.minY) continue;
        let block: ArrayBuffer;
        try {
          block = await readLodNodeBlock(tile, node);
        } catch (error) {
          console.warn('[LiDAR tools] Node read failed:', error);
          continue;
        }
        const count = Math.min(node.count, Math.floor(block.byteLength / LOD_POINT_STRIDE));
        const words = new Uint16Array(block, 0, (count * LOD_POINT_STRIDE) >> 1);
        const bytes = new Uint8Array(block, 0, count * LOD_POINT_STRIDE);
        const s = cube.size / 65535;
        const z0 = header.origin.z + cube.minZ;
        const step = LOD_POINT_STRIDE >> 1;
        for (let p = 0, w = 0; p < count; p++, w += step) {
          const x = x0 + words[w]! * s;
          const y = y0 + words[w + 1]! * s;
          if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue;
          const cls = bytes[p * LOD_POINT_STRIDE + 6]!;
          if (NOISE_CLASSES.has(cls)) continue;
          visit(x, y, z0 + words[w + 2]! * s, cls);
        }
      }
    }
  }

  private collectCandidates(query: PointPickQuery): Candidate[] {
    const [ox, oy, oz] = query.origin;
    const [dx, dy, dz] = query.direction;
    const out: Candidate[] = [];
    for (const node of this.getDrawnNodes()) {
      if (node.virtual || node.entry.count === 0) continue;
      // Agrandir la boîte du rayon de sélection à sa distance.
      const cx = (node.minX + node.maxX) / 2 - ox;
      const cy = (node.minY + node.maxY) / 2 - oy;
      const cz = (node.minZ + node.maxZ) / 2 - oz;
      const margin = query.minRadiusM + query.radiusPerMeter * Math.hypot(cx, cy, cz);
      const enter = raySlab(ox, oy, oz, dx, dy, dz, node, margin, query.maxDistance);
      if (enter != null) out.push({ node, enter });
    }
    out.sort((a, b) => a.enter - b.enter);
    return out.slice(0, MAX_NODES_PER_PICK);
  }

  private scanBlock(node: SceneNode, block: ArrayBuffer, query: PointPickQuery, maxDistance: number): PointPickHit | null {
    const count = Math.min(node.entry.count, Math.floor(block.byteLength / LOD_POINT_STRIDE));
    const words = new Uint16Array(block, 0, (count * LOD_POINT_STRIDE) >> 1);
    const bytes = new Uint8Array(block, 0, count * LOD_POINT_STRIDE);
    const s = node.size / 65535;
    const [ox, oy, oz] = query.origin;
    const [dx, dy, dz] = query.direction;
    // Origine du rayon relative au coin de quantification du nœud.
    const rx = ox - node.originX;
    const ry = oy - node.originY;
    const rz = oz - node.originZ;
    let bestDistance = maxDistance;
    let bestIndex = -1;
    const step = LOD_POINT_STRIDE >> 1;
    for (let p = 0, w = 0; p < count; p++, w += step) {
      // Axes CRS quantifiés (est, nord, haut) → repère de rendu (est, haut, −nord).
      const vx = words[w]! * s - rx;
      const vy = words[w + 2]! * s - ry;
      const vz = -words[w + 1]! * s - rz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t <= 0.05 || t >= bestDistance) continue;
      const radius = Math.max(query.minRadiusM, query.radiusPerMeter * t);
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      if (perp2 > radius * radius) continue;
      const cls = bytes[p * LOD_POINT_STRIDE + 6]!;
      if (NOISE_CLASSES.has(cls) || !this.isClassVisible(cls)) continue;
      bestDistance = t;
      bestIndex = p;
    }
    if (bestIndex < 0) return null;
    const w = bestIndex * step;
    return {
      local: [
        node.originX + words[w]! * s,
        node.originY + words[w + 2]! * s,
        node.originZ - words[w + 1]! * s,
      ],
      distance: bestDistance,
      classification: bytes[bestIndex * LOD_POINT_STRIDE + 6]!,
    };
  }

  private async readBlock(node: SceneNode): Promise<ArrayBuffer | null> {
    const cached = this.cache.get(node.id);
    if (cached) {
      this.cache.delete(node.id);
      this.cache.set(node.id, cached);
      return cached;
    }
    const tile = this.tiles[node.tileIndex];
    if (!tile) return null;
    try {
      const block = await readLodNodeBlock(tile, node.entry);
      this.cache.set(node.id, block);
      this.cacheBytes += block.byteLength;
      for (const [id, old] of this.cache) {
        if (this.cacheBytes <= CACHE_BUDGET_BYTES) break;
        this.cache.delete(id);
        this.cacheBytes -= old.byteLength;
      }
      return block;
    } catch (error) {
      console.warn('[LiDAR tools] Node read failed during picking:', error);
      return null;
    }
  }
}

/** Distance d'entrée d'un rayon dans une boîte agrandie de `margin`, `null` s'il la manque. */
function raySlab(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  margin: number,
  maxDistance: number,
): number | null {
  let tmin = 0;
  let tmax = maxDistance;
  const axes: Array<[number, number, number, number]> = [
    [ox, dx, box.minX - margin, box.maxX + margin],
    [oy, dy, box.minY - margin, box.maxY + margin],
    [oz, dz, box.minZ - margin, box.maxZ + margin],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
