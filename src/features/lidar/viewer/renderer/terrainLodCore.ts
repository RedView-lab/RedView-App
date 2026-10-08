// ============================================
// LOD du maillage de terrain : geomipmapping par morceaux sur les grilles MNT des tuiles
// ============================================
//
// Le maillage du MNT (grille d'≈1 m, 2,1 M triangles par tuile) ne fait que
// combler les trous entre les points, et pourtant, dessiné en entier, il
// coûtait plus que les points : 19 M triangles pour 9 tuiles retenaient le
// budget de points d'un GPU intégré à 1,5 M points au lieu de 6 M. Chaque
// grille de tuile est découpée en morceaux de CHUNK_QUADS quads ; à chaque
// image, un morceau visible prend le pas le plus grossier (1…32 pas de
// grille) dont l'erreur de hauteur projetée reste sous ERROR_PX et dont les
// quads restent sous MAX_QUAD_PX ; deux morceaux voisins (y compris d'une
// tuile à l'autre) diffèrent d'un niveau au plus, et un bord face à un voisin
// plus grossier aligne ses sommets intermédiaires sur le bord grossier : pas
// de fissures en T.
// Un morceau grossier est repoussé le long des rayons de vue de son erreur de
// hauteur (`pushBack`, lu par le vertex shader du terrain) : il ne cache
// jamais un point posé sur la vraie surface ; un déplacement le long du rayon
// de vue garde chaque sommet sur le même pixel, donc des morceaux repoussés
// de valeurs différentes se raccordent toujours à l'écran. Les sommets restent
// les buffers en pleine résolution (chaque sommet gardé garde sa normale et
// sa couleur) ; un morceau est un dessin indexé d'un motif d'indices partagé
// par tous les morceaux de cette forme, relatif à son premier sommet.
//
// Ce module est la partie indépendante de l'API GPU (morceaux, niveaux,
// motifs), partagée par les dessinateurs WebGPU (`terrainLod.ts`) et WebGL 2
// (`webgl/glTerrainLod.ts`).

import { extractFrustumPlanes, frustumTestAABB, OUTSIDE } from '../lod/frustum';

/** Grille de sommets d'une tuile dans les buffers de terrain fusionnés (lignes de `gridWidth` sommets). */
export interface TerrainPart {
  vertexOffset: number;
  gridWidth: number;
  gridHeight: number;
}

export interface TerrainMeshData {
  /** x, y, z, nx, ny, nz per vertex (render frame). */
  vertices: Float32Array;
  /** RGBA8 per vertex. */
  colors: Uint8Array;
  parts: TerrainPart[];
}

const CHUNK_QUADS = 128;
/** Strides 1, 2, 4 … 32 grid steps. */
const LEVELS = 6;
/**
 * Plus grande erreur de hauteur d'un niveau plus grossier, projetée (px de
 * l'écran). Le maillage se tient derrière les points (repoussé de cette
 * erreur), il ne dessine donc que les trous et les silhouettes que les points
 * laissent ouverts.
 */
const ERROR_PX = 6;
/** Plus grand quad d'un niveau plus grossier, projeté (px de l'écran) : ombrage et silhouettes restent lisses. */
const MAX_QUAD_PX = 32;
/** Recul supplémentaire (m) de chaque morceau dessiné sous la pleine résolution. */
const PUSH_BACK_MARGIN = 0.05;
export const TERRAIN_VERTEX_FLOATS = 6;

/** Côtés d'un morceau, en bits du masque de raccord. */
const ROW_MIN = 1;
const COL_MAX = 2;
const ROW_MAX = 4;
const COL_MIN = 8;
const SIDES = [ROW_MIN, COL_MAX, ROW_MAX, COL_MIN] as const;

export interface TerrainChunk {
  quadsW: number;
  quadsH: number;
  gridWidth: number;
  /** Premier sommet du morceau dans les buffers fusionnés ; les indices du motif lui sont relatifs. */
  baseVertex: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  /** Taille dans le monde d'un pas de grille. */
  cell: number;
  /** Plus grande erreur de hauteur de chaque niveau (mètres), croissante ; Infinity au-delà de `maxLevel`. */
  errors: Float32Array;
  /** Niveau le plus grossier que permet la taille du morceau. */
  maxLevel: number;
  /** Morceau voisin par côté (ordre ROW_MIN, COL_MAX, ROW_MAX, COL_MIN), −1 au bord de la scène. */
  neighbours: [number, number, number, number];
  /** Direction (x, z) dans le monde des colonnes et lignes croissantes de la grille. */
  colAxis: [number, number];
  rowAxis: [number, number];
}

/** Liste d'indices d'une forme de morceau, indexée par `patternKey`. */
export interface TerrainIndexPattern {
  key: string;
  indices: Uint32Array<ArrayBuffer>;
}

/** Positions de grille d'un niveau le long d'un axe du morceau : multiples du pas, puis la fin. */
function levelPositions(quads: number, stride: number): number[] {
  const out: number[] = [];
  for (let p = 0; p < quads; p += stride) out.push(p);
  out.push(quads);
  return out;
}

/** Plus grande position de `coarse` (triée, commençant à 0) qui ne dépasse pas `p`. */
function snapDown(p: number, coarse: number[]): number {
  let best = 0;
  for (const c of coarse) {
    if (c > p) break;
    best = c;
  }
  return best;
}

/**
 * Liste d'indices d'un morceau de `quadsW`×`quadsH` quads au pas `stride`,
 * relative à son premier sommet dans une grille de `gridWidth` sommets par
 * ligne. Les bords de `stitch` font face à un voisin d'un niveau plus
 * grossier : leurs sommets s'alignent sur les positions de ce niveau (les
 * triangles dégénérés sont écartés). Même sens d'enroulement que le maillage
 * de la carte d'altitude (tl, tr, bl / tr, br, bl).
 */
export function buildChunkIndices(
  gridWidth: number,
  quadsW: number,
  quadsH: number,
  stride: number,
  stitch: number,
): Uint32Array<ArrayBuffer> {
  const cols = levelPositions(quadsW, stride);
  const rows = levelPositions(quadsH, stride);
  const coarseCols = levelPositions(quadsW, stride * 2);
  const coarseRows = levelPositions(quadsH, stride * 2);
  const index = (r: number, c: number): number => {
    let rr = r;
    let cc = c;
    if (r === 0 && (stitch & ROW_MIN)) cc = snapDown(c, coarseCols);
    else if (r === quadsH && (stitch & ROW_MAX)) cc = snapDown(c, coarseCols);
    if (c === 0 && (stitch & COL_MIN)) rr = snapDown(r, coarseRows);
    else if (c === quadsW && (stitch & COL_MAX)) rr = snapDown(r, coarseRows);
    return rr * gridWidth + cc;
  };
  const out: number[] = [];
  const triangle = (a: number, b: number, c: number) => {
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  };
  for (let ri = 0; ri < rows.length - 1; ri++) {
    for (let ci = 0; ci < cols.length - 1; ci++) {
      const tl = index(rows[ri]!, cols[ci]!);
      const tr = index(rows[ri]!, cols[ci + 1]!);
      const bl = index(rows[ri + 1]!, cols[ci]!);
      const br = index(rows[ri + 1]!, cols[ci + 1]!);
      triangle(tl, tr, bl);
      triangle(tr, br, bl);
    }
  }
  return new Uint32Array(out);
}

/** Plus grande erreur de hauteur de chaque niveau sur le morceau : surface grossière bilinéaire contre la grille complète. */
function chunkErrors(
  vertices: Float32Array,
  base: number,
  gridWidth: number,
  quadsW: number,
  quadsH: number,
  maxLevel: number,
): Float32Array {
  const errors = new Float32Array(LEVELS);
  for (let level = 1; level <= maxLevel; level++) {
    const stride = 1 << level;
    const cols = levelPositions(quadsW, stride);
    const rows = levelPositions(quadsH, stride);
    let worst = errors[level - 1]!;
    for (let ri = 0; ri < rows.length - 1; ri++) {
      const r0 = rows[ri]!, r1 = rows[ri + 1]!;
      for (let ci = 0; ci < cols.length - 1; ci++) {
        const c0 = cols[ci]!, c1 = cols[ci + 1]!;
        const at = (r: number, c: number) => (base + r * gridWidth + c) * TERRAIN_VERTEX_FLOATS + 1;
        const h00 = vertices[at(r0, c0)]!, h01 = vertices[at(r0, c1)]!;
        const h10 = vertices[at(r1, c0)]!, h11 = vertices[at(r1, c1)]!;
        for (let r = r0; r <= r1; r++) {
          const v = (r - r0) / (r1 - r0);
          const left = h00 + (h10 - h00) * v;
          const right = h01 + (h11 - h01) * v;
          let k = at(r, c0);
          for (let c = c0; c <= c1; c++, k += TERRAIN_VERTEX_FLOATS) {
            const error = Math.abs(vertices[k]! - (left + (right - left) * ((c - c0) / (c1 - c0))));
            if (error > worst) worst = error;
          }
        }
      }
    }
    errors[level] = worst;
  }
  for (let level = maxLevel + 1; level < LEVELS; level++) errors[level] = Infinity;
  return errors;
}

/** Morceaux des grilles de terrain et niveau auquel chacun est dessiné pour la caméra courante. */
export class TerrainLodSelector {
  readonly chunks: TerrainChunk[] = [];
  /** Niveau par morceau (pas 2^level), fixé par `select`. */
  readonly levels: Int32Array;
  /** 1 là où le morceau coupe le frustum, fixé par `select`. */
  readonly visible: Uint8Array;
  /** Recul (m) par morceau le long des rayons de vue, fixé par `select`. */
  readonly pushBack: Float32Array<ArrayBuffer>;

  constructor(mesh: TerrainMeshData) {
    mesh.parts.forEach((part) => this.addPart(mesh.vertices, part));
    this.linkNeighbours();
    this.levels = new Int32Array(this.chunks.length);
    this.visible = new Uint8Array(this.chunks.length);
    this.pushBack = new Float32Array(Math.max(1, this.chunks.length));
  }

  private addPart(vertices: Float32Array, part: TerrainPart): void {
    const { vertexOffset, gridWidth, gridHeight } = part;
    if (gridWidth < 2 || gridHeight < 2 || (vertexOffset + gridWidth * gridHeight) * TERRAIN_VERTEX_FLOATS > vertices.length) {
      console.warn('[LiDAR terrain] Skipped a terrain part whose grid does not match its vertices.');
      return;
    }
    for (let row0 = 0; row0 < gridHeight - 1; row0 += CHUNK_QUADS) {
      for (let col0 = 0; col0 < gridWidth - 1; col0 += CHUNK_QUADS) {
        const quadsW = Math.min(CHUNK_QUADS, gridWidth - 1 - col0);
        const quadsH = Math.min(CHUNK_QUADS, gridHeight - 1 - row0);
        const baseVertex = vertexOffset + row0 * gridWidth + col0;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let r = 0; r <= quadsH; r++) {
          for (let c = 0; c <= quadsW; c++) {
            const at = (baseVertex + r * gridWidth + c) * TERRAIN_VERTEX_FLOATS;
            const x = vertices[at]!, y = vertices[at + 1]!, z = vertices[at + 2]!;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
        // Pas jusqu'au plus petit côté du morceau (morceaux partiels au bord d'une grille).
        const maxLevel = Math.max(0, Math.min(LEVELS - 1, Math.floor(Math.log2(Math.min(quadsW, quadsH)))));
        const corner = (r: number, c: number): [number, number] => {
          const at = (baseVertex + r * gridWidth + c) * TERRAIN_VERTEX_FLOATS;
          return [vertices[at]!, vertices[at + 2]!];
        };
        const [x0, z0] = corner(0, 0);
        const [xc, zc] = corner(0, quadsW);
        const [xr, zr] = corner(quadsH, 0);
        this.chunks.push({
          quadsW,
          quadsH,
          gridWidth,
          baseVertex,
          minX, minY, minZ, maxX, maxY, maxZ,
          cell: Math.max((maxX - minX) / quadsW, (maxZ - minZ) / quadsH),
          errors: chunkErrors(vertices, baseVertex, gridWidth, quadsW, quadsH, maxLevel),
          maxLevel,
          neighbours: [-1, -1, -1, -1],
          colAxis: [Math.sign(xc - x0), Math.sign(zc - z0)],
          rowAxis: [Math.sign(xr - x0), Math.sign(zr - z0)],
        });
      }
    }
  }

  /**
   * Voisins par arête commune : chevauchement le long de l'arête et contact
   * au travers (à moins d'un demi-pas de grille), pour que les tuiles se
   * raccordent aussi.
   */
  private linkNeighbours(): void {
    const chunks = this.chunks;
    for (let i = 0; i < chunks.length; i++) {
      const a = chunks[i]!;
      const tolerance = a.cell * 0.5;
      for (let j = 0; j < chunks.length; j++) {
        if (i === j) continue;
        const b = chunks[j]!;
        const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
        const halfX = 0.5 * Math.min(a.maxX - a.minX, b.maxX - b.minX);
        const halfZ = 0.5 * Math.min(a.maxZ - a.minZ, b.maxZ - b.minZ);
        let side = -1;
        if (overlapZ > halfZ && Math.abs(b.minX - a.maxX) <= tolerance) side = this.sideOf(a, 1, 0);
        else if (overlapZ > halfZ && Math.abs(b.maxX - a.minX) <= tolerance) side = this.sideOf(a, -1, 0);
        else if (overlapX > halfX && Math.abs(b.minZ - a.maxZ) <= tolerance) side = this.sideOf(a, 0, 1);
        else if (overlapX > halfX && Math.abs(b.maxZ - a.minZ) <= tolerance) side = this.sideOf(a, 0, -1);
        if (side >= 0 && a.neighbours[side] === -1) a.neighbours[side] = j;
      }
    }
  }

  /** Indice du côté du morceau (ordre ROW_MIN, COL_MAX, ROW_MAX, COL_MIN) tourné vers la direction (dx, dz) du monde. */
  private sideOf(chunk: TerrainChunk, dx: number, dz: number): number {
    const alongCols = dx * chunk.colAxis[0] + dz * chunk.colAxis[1];
    const alongRows = dx * chunk.rowAxis[0] + dz * chunk.rowAxis[1];
    if (Math.abs(alongCols) >= Math.abs(alongRows)) return alongCols > 0 ? 1 : 3;
    return alongRows > 0 ? 2 : 0;
  }

  static patternKey(gridWidth: number, quadsW: number, quadsH: number, level: number, stitch: number): string {
    return `${gridWidth}:${quadsW}:${quadsH}:${level}:${stitch}`;
  }

  /**
   * Tous les motifs des morceaux de taille pleine (chaque niveau, chaque
   * combinaison de côtés raccordés ; ~8 Mo par largeur de grille), une liste
   * par largeur de grille : les dessinateurs les envoient une fois, aucun
   * buffer n'est donc créé pendant le dessin.
   */
  sharedPatterns(): TerrainIndexPattern[][] {
    const widths = new Set(this.chunks.filter((c) => c.quadsW === CHUNK_QUADS && c.quadsH === CHUNK_QUADS).map((c) => c.gridWidth));
    const groups: TerrainIndexPattern[][] = [];
    for (const gridWidth of widths) {
      const lists: TerrainIndexPattern[] = [];
      for (let level = 0; level < LEVELS; level++) {
        // Le niveau le plus grossier ne rencontre jamais de voisin plus grossier.
        const stitches = level < LEVELS - 1 ? 16 : 1;
        for (let stitch = 0; stitch < stitches; stitch++) {
          lists.push({
            key: TerrainLodSelector.patternKey(gridWidth, CHUNK_QUADS, CHUNK_QUADS, level, stitch),
            indices: buildChunkIndices(gridWidth, CHUNK_QUADS, CHUNK_QUADS, 1 << level, stitch),
          });
        }
      }
      groups.push(lists);
    }
    return groups;
  }

  /** Clé du motif avec lequel un morceau est dessiné au niveau `level` (voir `sharedPatterns`). */
  static chunkPatternKey(chunk: TerrainChunk, level: number, stitch: number): string {
    return TerrainLodSelector.patternKey(chunk.gridWidth, chunk.quadsW, chunk.quadsH, level, stitch);
  }

  /** Liste d'indices d'un morceau au niveau `level` : les morceaux partiels (bords de grille) ne sont pas dans `sharedPatterns`. */
  static chunkPatternIndices(chunk: TerrainChunk, level: number, stitch: number): Uint32Array<ArrayBuffer> {
    return buildChunkIndices(chunk.gridWidth, chunk.quadsW, chunk.quadsH, 1 << level, stitch);
  }

  /** Côtés du morceau `index` face à un voisin d'un niveau plus grossier (masque de raccord). */
  stitchOf(index: number): number {
    const chunk = this.chunks[index]!;
    const level = this.levels[index]!;
    let stitch = 0;
    for (let side = 0; side < 4; side++) {
      const n = chunk.neighbours[side]!;
      if (n >= 0 && this.levels[n]! === level + 1) stitch |= SIDES[side]!;
    }
    return stitch;
  }

  /**
   * Choisit le niveau et la visibilité de chaque morceau pour cette caméra.
   * `focalPx` = proj[1][1] × hauteur du viewport / 2 (px de l'écran à la
   * résolution du canvas, comme les points).
   */
  select(viewProj: Float32Array, camX: number, camY: number, camZ: number, focalPx: number): void {
    const planes = extractFrustumPlanes(viewProj);
    const chunks = this.chunks;
    const levels = this.levels;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      this.visible[i] = frustumTestAABB(planes, chunk) === OUTSIDE ? 0 : 1;
      const dx = Math.max(chunk.minX - camX, 0, camX - chunk.maxX);
      const dy = Math.max(chunk.minY - camY, 0, camY - chunk.maxY);
      const dz = Math.max(chunk.minZ - camZ, 0, camZ - chunk.maxZ);
      const pxPerMetre = focalPx / Math.max(0.05, Math.sqrt(dx * dx + dy * dy + dz * dz));
      let level = 0;
      for (let l = chunk.maxLevel; l >= 1; l--) {
        if (chunk.errors[l]! * pxPerMetre <= ERROR_PX && (1 << l) * chunk.cell * pxPerMetre <= MAX_QUAD_PX) {
          level = l;
          break;
        }
      }
      levels[i] = level;
    }
    // Deux voisins diffèrent d'un niveau au plus (le plus fin l'emporte) : un
    // bord raccordé ne rencontre donc jamais que le niveau suivant.
    for (let pass = 0; pass < LEVELS; pass++) {
      let changed = false;
      for (let i = 0; i < chunks.length; i++) {
        for (const n of chunks[i]!.neighbours) {
          if (n >= 0 && levels[i]! > levels[n]! + 1) {
            levels[i] = levels[n]! + 1;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    for (let i = 0; i < chunks.length; i++) {
      const level = levels[i]!;
      this.pushBack[i] = level > 0 ? chunks[i]!.errors[level]! + PUSH_BACK_MARGIN : 0;
    }
  }
}
