import { createInMemoryLodTile } from '../../src/features/lidar/lib/lodCache.ts';
import {
  extractFrustumPlanes,
  frustumTestAABB,
  OUTSIDE,
} from '../../src/features/lidar/viewer/lod/frustum.ts';
import {
  buildLodTile,
  LOD_POINT_STRIDE,
  lodNodeCube,
  unpackLodPosition,
  type LodTile,
} from '../../src/features/lidar/viewer/lod/lodTile.ts';
import { SceneLod, type SceneNode } from '../../src/features/lidar/viewer/lod/sceneLod.ts';
import { mat4MultiplyInto } from '../../src/features/lidar/viewer/renderer/math.ts';
import { check } from './harness.ts';
import { syntheticTile } from './lodTileCheck.ts';
import { orbitViewMatrix, renderProjection } from './screenSizeCheck.ts';
import { CountingUploader, settle } from './streamingCheck.ts';

// ---------------------------------------------------------------------------
// 5–8. Sélection : chargements, couverture, masques d'octants, bornes serrées
// ---------------------------------------------------------------------------

function selectedIds(scene: SceneLod): string {
  return scene.getSelectedNodes().map((node) => node.id).join(',');
}

/** Points of a node in the render frame (x east, y up, z = −north), relative to `center`. */
function nodePoints(tile: LodTile, node: SceneNode, center: { x: number; y: number; z: number }): Float64Array {
  const view = new DataView(tile.packed.buffer, tile.packed.byteOffset, tile.packed.byteLength);
  const cube = lodNodeCube(tile.header, node.entry);
  const out = new Float64Array(node.entry.count * 3);
  for (let k = 0; k < node.entry.count; k++) {
    const [x, y, z] = unpackLodPosition(view, node.entry.byteOffset + k * LOD_POINT_STRIDE, cube);
    out[k * 3] = tile.header.origin.x + x - center.x;
    out[k * 3 + 1] = tile.header.origin.z + z - center.z;
    out[k * 3 + 2] = -(tile.header.origin.y + y - center.y);
  }
  return out;
}

export async function runSelectionCheck(): Promise<void> {
  // Denser than the streaming scene: deeper octrees (≈ 0.9 m spacing).
  const built: LodTile[] = [];
  for (let ty = -1; ty <= 1; ty++) {
    for (let tx = -1; tx <= 1; tx++) built.push(buildLodTile(syntheticTile(tx, ty, 1_200_000)));
  }
  const tiles = built.map((tile) => createInMemoryLodTile(tile));
  const center = { x: 1_000_500, y: 6_543_500, z: 1200 };
  const uploader = new CountingUploader();
  const scene = new SceneLod(tiles, center, {
    pointBudget: 2_000_000,
    poolBudget: 2_700_000,
    maxResidentNodes: 16384,
    uploader,
    onNodeResident: () => undefined,
  });
  const proj = renderProjection(1920 / 1080);
  const viewProj = new Float32Array(16);
  const frameAt = (radius: number, theta: number, phi: number) => () => {
    const { view, eye } = orbitViewMatrix(radius, theta, phi);
    mat4MultiplyInto(viewProj, proj, view);
    scene.update(viewProj, proj[5]!, eye[0], eye[1], eye[2], 1080);
  };

  // 5. A fresh scene and a still camera load exactly what is drawn, then stop changing.
  const oblique = frameAt(700, 0.4, 1.1);
  await settle(scene, oblique);
  const loads = uploader.uploads;
  const drawnNodes = scene.getStats().selectedNodes;
  const reference = selectedIds(scene);
  let churn = 0;
  for (let i = 0; i < 30; i++) {
    oblique();
    if (selectedIds(scene) !== reference) churn++;
  }
  check(
    'Chargements : la sélection cible compte les nœuds en attente',
    loads <= drawnNodes + 2 && churn === 0,
    'nœuds en attente hors budget : la sélection se recompose à chaque arrivée (3–5× plus de blocs lus sur tuiles IGN)',
    `${loads} blocs lus pour ${drawnNodes} nœuds affichés, sélection figée sur 30 frames`,
  );

  // 6. Grazing view with a tiny budget: no visible tile goes blank.
  scene.setPointBudget(150_000);
  const grazing = frameAt(450, 0.4, 1.47);
  await settle(scene, grazing);
  const drawn = new Set(scene.getSelectedNodes().map((node) => node.id));
  const planes = Float64Array.from(extractFrustumPlanes(viewProj));
  let visibleRoots = 0;
  let drawnRoots = 0;
  for (const node of scene.nodes) {
    if (node.parent >= 0 || frustumTestAABB(planes, node) === OUTSIDE) continue;
    visibleRoots++;
    if (drawn.has(node.id)) drawnRoots++;
  }
  check(
    'Couverture : la racine de chaque tuile visible est toujours affichée',
    visibleRoots > 0 && drawnRoots === visibleRoots,
    'priorité seule : un budget serré pouvait laisser une tuile lointaine vide',
    `${drawnRoots}/${visibleRoots} tuiles visibles en vue rasante avec 150 k pts de budget`,
  );

  // 7. Octant masks of the adaptive point size match the drawn children.
  scene.setPointBudget(2_000_000);
  const close = frameAt(150, 1.2, 0.8);
  await settle(scene, close);
  const frameDrawn = new Set(scene.getSelectedNodes().map((node) => node.id));
  let maskErrors = 0;
  let partialMasks = 0;
  for (const node of scene.getSelectedNodes()) {
    let expected = 0;
    for (const childId of node.children) {
      const child = scene.nodes[childId]!;
      if (child.entry.count > 0 && frameDrawn.has(childId)) {
        expected |= 1 << ((child.entry.x & 1) | ((child.entry.y & 1) << 1) | ((child.entry.z & 1) << 2));
      }
    }
    if (node.children.every((id) => scene.nodes[id]!.entry.count > 0) && expected !== node.childMask) maskErrors++;
    if (node.childMask !== 0 && node.childMask !== 0xff) partialMasks++;
  }
  check(
    'Taille adaptative : masques d’octants conformes aux enfants affichés',
    maskErrors === 0,
    'taille de point unique : les niveaux grossiers laissent voir le terrain (51 % de pixels ajourés à 1,5 M pts sur tuile IGN)',
    `${scene.getSelectedNodes().length} nœuds, ${partialMasks} masques partiels, ${maskErrors} incohérence(s)`,
  );

  // 8. Bounds shrunk to the loaded points still hold every point of the subtree.
  await settle(scene, frameAt(900, 2.5, 0.05));
  await settle(scene, frameAt(60, 4.0, 1.0));
  let checkedPoints = 0;
  let outside = 0;
  let heightRatio = 0;
  let tightened = 0;
  for (const node of scene.nodes) {
    if (node.entry.count === 0) continue;
    if (node.depth > 0) {
      heightRatio += (node.maxY - node.minY) / node.size;
      tightened++;
    }
    const points = nodePoints(built[node.tileIndex]!, node, center);
    for (let k = 0; k < node.entry.count; k++) {
      const x = points[k * 3]!, y = points[k * 3 + 1]!, z = points[k * 3 + 2]!;
      checkedPoints++;
      for (let at: SceneNode | undefined = node; at; at = at.parent >= 0 ? scene.nodes[at.parent] : undefined) {
        const tol = 1e-3;
        if (x < at.minX - tol || x > at.maxX + tol || y < at.minY - tol || y > at.maxY + tol || z < at.minZ - tol || z > at.maxZ + tol) {
          outside++;
          break;
        }
      }
    }
  }
  check(
    'Bornes serrées des nœuds : toujours conservatrices',
    outside === 0 && checkedPoints > 0,
    'cube de l’octree : hauteur = largeur, surtout de l’air sur un terrain',
    `${(checkedPoints / 1e6).toFixed(1)} M pts testés dans leur nœud et tous ses ancêtres, ${outside} hors bornes · ` +
    `hauteur moyenne ${((heightRatio / Math.max(1, tightened)) * 100).toFixed(0)} % du cube`,
  );
}
