import { performance } from 'node:perf_hooks';
import {
  buildLodTile,
  LOD_POINT_STRIDE,
  LOD_RECORD,
  lodNodeCube,
  type LodTile,
} from '../../src/features/lidar/viewer/lod/lodTile.ts';
import { REST_SAMPLES, RestRefinement } from '../../src/features/lidar/viewer/lod/restRefinement.ts';
import { buildChunkIndices } from '../../src/features/lidar/viewer/renderer/terrainLodCore.ts';
import { check } from './harness.ts';
import { syntheticTile } from './lodTileCheck.ts';

// ---------------------------------------------------------------------------
// 11–13. Qualité de rendu : couleurs filtrées, terrain LOD sans fissure, image au repos
// ---------------------------------------------------------------------------

/**
 * Couleur filtrée de chaque point d'un nœud qui a des enfants = rouge moyen
 * des points de son sous-arbre dans sa cellule. La référence requantifie les
 * positions décodées, donc un point à moins d'un quantum (≈ 1 cm) d'un bord de
 * cellule peut tomber dans la cellule voisine : les erreurs sont comptées, sans
 * exiger qu'elles soient toutes nulles.
 */
function filterError(tile: LodTile): { checked: number; within: number; inner: number } {
  const view = new DataView(tile.packed.buffer, tile.packed.byteOffset, tile.packed.byteLength);
  const nodes = tile.nodes;
  const isAncestor = (a: (typeof nodes)[number], b: (typeof nodes)[number]) => {
    const shift = b.depth - a.depth;
    return shift >= 0 && (b.x >> shift) === a.x && (b.y >> shift) === a.y && (b.z >> shift) === a.z;
  };
  let checked = 0;
  let within = 0;
  let inner = 0;
  for (const node of nodes) {
    const subtree = nodes.filter((other) => other.count > 0 && isAncestor(node, other));
    if (subtree.length <= 1 || node.count === 0) continue;
    inner++;
    const cube = lodNodeCube(tile.header, node);
    // Sommes par cellule de la grille de ce nœud sur le sous-arbre (positions décodées dans leurs propres cubes).
    const sums = new Map<number, [number, number]>();
    for (const other of subtree) {
      const otherCube = lodNodeCube(tile.header, other);
      for (let k = 0; k < other.count; k++) {
        const at = other.byteOffset + k * LOD_POINT_STRIDE;
        const s = otherCube.size / 65535;
        const px = otherCube.minX + view.getUint16(at, true) * s;
        const py = otherCube.minY + view.getUint16(at + 2, true) * s;
        const pz = otherCube.minZ + view.getUint16(at + 4, true) * s;
        const q = (v: number, min: number) => Math.min(127, Math.max(0, Math.round(((v - min) * 65535) / cube.size) >> 9));
        const key = q(px, cube.minX) | (q(py, cube.minY) << 7) | (q(pz, cube.minZ) << 14);
        const entry = sums.get(key) ?? [0, 0];
        entry[0] += tile.packed[at + LOD_RECORD.rgb]!;
        entry[1] += 1;
        sums.set(key, entry);
      }
    }
    for (let k = 0; k < node.count; k += Math.max(1, Math.floor(node.count / 50))) {
      const at = node.byteOffset + k * LOD_POINT_STRIDE;
      const key = (view.getUint16(at, true) >> 9) | ((view.getUint16(at + 2, true) >> 9) << 7) | ((view.getUint16(at + 4, true) >> 9) << 14);
      const entry = sums.get(key);
      if (!entry) continue;
      if (Math.abs(Math.round(entry[0] / entry[1]) - tile.packed[at + LOD_RECORD.filteredRgb]!) <= 3) within++;
      checked++;
    }
  }
  return { checked, within, inner };
}

/**
 * Sommets de bord (positions de grille le long d'un côté de chunk) utilisés
 * par un motif : un bord fin recousu doit utiliser exactement les sommets du
 * voisin grossier.
 */
function edgeVertices(indices: Uint32Array, gridWidth: number, quads: number, side: 'rowMin' | 'colMax'): number[] {
  const used = new Set<number>();
  for (const index of indices) {
    const r = Math.floor(index / gridWidth);
    const c = index % gridWidth;
    if (side === 'rowMin' && r === 0) used.add(c);
    if (side === 'colMax' && c === quads) used.add(r);
  }
  return [...used].sort((a, b) => a - b);
}

function runFilterCheck(): void {
  // Tuile synthétique bicolore : un damier de 2 m, pour que les cellules grossières mélangent les deux couleurs.
  const input = syntheticTile(3, 2, 400_000);
  for (let i = 0; i < input.count; i++) {
    const x = input.positions[i * 3]!, y = input.positions[i * 3 + 1]!;
    input.colors[i * 3] = ((Math.floor(x / 2) + Math.floor(y / 2)) & 1) ? 230 : 20;
  }
  const t0 = performance.now();
  const tile = buildLodTile(input);
  const buildMs = performance.now() - t0;
  const { checked, within, inner } = filterError(tile);
  // Points de la racine : couleur propre 20 ou 230, couleur filtrée une moyenne de cellule entre les deux.
  const root = tile.nodes.find((node) => node.depth === 0)!;
  let mixed = 0;
  for (let k = 0; k < root.count; k++) {
    const v = tile.packed[root.byteOffset + k * LOD_POINT_STRIDE + LOD_RECORD.filteredRgb]!;
    if (v > 40 && v < 210) mixed++;
  }
  check(
    `Couleurs filtrées des niveaux grossiers (${inner} nœuds internes, ${buildMs.toFixed(0)} ms avec l'octree)`,
    checked > 100 && within >= checked * 0.97 && mixed > root.count * 0.5,
    'chaque point grossier = un échantillon de l’ortho (bruit poivre et sel au loin)',
    `moyenne de la maille du nœud sur tout le sous-arbre : ${((within / checked) * 100).toFixed(1)} % de ${checked} points à ≤ 3/255 ` +
    '(le reste à ≈ 1 cm d’une limite de maille), ' +
    `${((mixed / root.count) * 100).toFixed(0)} % des points racine mélangent les deux couleurs du damier`,
  );
}

function runTerrainStitchCheck(): void {
  const gridWidth = 1025;
  const quads = 128;
  let pass = true;
  let worstTriangles = 0;
  for (let level = 0; level < 5; level++) {
    const stride = 1 << level;
    const coarse = edgeVertices(buildChunkIndices(gridWidth, quads, quads, stride * 2, 0), gridWidth, quads, 'rowMin');
    const stitchedRow = edgeVertices(buildChunkIndices(gridWidth, quads, quads, stride, 1), gridWidth, quads, 'rowMin');
    const coarseCol = edgeVertices(buildChunkIndices(gridWidth, quads, quads, stride * 2, 0), gridWidth, quads, 'colMax');
    const stitchedCol = edgeVertices(buildChunkIndices(gridWidth, quads, quads, stride, 2), gridWidth, quads, 'colMax');
    if (coarse.join(',') !== stitchedRow.join(',') || coarseCol.join(',') !== stitchedCol.join(',')) pass = false;
    worstTriangles = Math.max(worstTriangles, buildChunkIndices(gridWidth, quads, quads, stride, 15).length / 3);
  }
  // Un chunk partiel (bord de grille non multiple de la taille de chunk) garde sa dernière ligne / colonne.
  const partial = buildChunkIndices(gridWidth, 77, 50, 4, 0);
  const lastCol = edgeVertices(partial, gridWidth, 77, 'colMax');
  if (!lastCol.includes(0) || !lastCol.includes(50)) pass = false;
  const full = buildChunkIndices(gridWidth, quads, quads, 1, 0).length / 3;
  const coarsest = buildChunkIndices(gridWidth, quads, quads, 32, 0).length / 3;
  check(
    'Terrain LOD : bords recousus vers le voisin plus grossier',
    pass,
    'maillage pleine résolution dessiné en entier (19 M triangles pour 9 tuiles)',
    `arêtes cousues = sommets exacts du niveau voisin à chaque niveau ; un chunk passe de ${full} à ${coarsest} triangles ` +
    `(${worstTriangles} au plus avec ses 4 côtés cousus)`,
  );
}

function runRestRefinementCheck(): void {
  // GPU simulé : le coût croît linéairement avec les points dessinés (3 ms par million en plus de 4 ms).
  const costMs = (points: number) => 4 + (points / 1e6) * 3;
  const rest = new RestRefinement(true);
  const moving = 1_500_000;
  const ceiling = 20_000_000;
  const target = 30_000_000; // points dont la vue aurait besoin à pleine densité
  rest.startRefine();
  let frames = 0;
  let budget = moving;
  while (rest.phase === 'refine' && frames < 200) {
    budget = rest.budget(moving, ceiling);
    const drawn = Math.min(budget, target);
    rest.onRefineFrame({ lodIdle: true, gpuMs: costMs(drawn), budgetLimited: drawn >= budget * 0.95 }, moving, ceiling);
    frames++;
  }
  const settledBudget = rest.budget(moving, ceiling);
  const settledCost = costMs(Math.min(settledBudget, target));
  let samples = 0;
  const offsets = new Set<string>();
  while (rest.phase === 'accumulate' && samples < 100) {
    offsets.add(rest.jitter().map((v) => v.toFixed(3)).join(','));
    rest.onAccumulatedFrame(settledCost, moving);
    samples++;
  }
  rest.setMoving();
  const movingAgain = rest.budget(moving, ceiling) === moving;
  check(
    'Image au repos : budget raffiné puis anti-aliasing progressif',
    settledBudget > moving * 4 && settledCost <= 50 * 1.35 && samples === REST_SAMPLES && offsets.size === REST_SAMPLES && movingAgain,
    'image fixe au budget du mouvement (1,5 M points sur iGPU), sans anti-aliasing',
    `budget au repos ${(settledBudget / 1e6).toFixed(1)} M points en ${frames} frames ` +
    `(${settledCost.toFixed(0)} ms/frame simulés), ${samples} frames décalées distinctes accumulées, retour immédiat au budget mouvement`,
  );
}

export function runRenderQualityCheck(): void {
  runFilterCheck();
  runTerrainStitchCheck();
  runRestRefinementCheck();
}
