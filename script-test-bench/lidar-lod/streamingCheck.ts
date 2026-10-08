import { performance } from 'node:perf_hooks';
import {
  createInMemoryLodTile,
  type OpenedLodTile,
} from '../../src/features/lidar/lib/lodCache.ts';
import { buildLodTile } from '../../src/features/lidar/viewer/lod/lodTile.ts';
import {
  SceneLod,
  type SceneNode,
  type SceneNodeUploader,
} from '../../src/features/lidar/viewer/lod/sceneLod.ts';
import { mat4MultiplyInto } from '../../src/features/lidar/viewer/renderer/math.ts';
import { check } from './harness.ts';
import { syntheticTile } from './lodTileCheck.ts';
import { orbitViewMatrix, renderProjection } from './screenSizeCheck.ts';

// Streaming multi-tuiles : densité près de la caméra, budget et mémoire GPU bornés.

export class CountingUploader implements SceneNodeUploader {
  resident = new Set<number>();
  peakPoints = 0;
  uploads = 0;
  private points = 0;
  uploadNode(node: SceneNode): boolean {
    this.resident.add(node.id);
    this.uploads++;
    this.points += node.entry.count;
    this.peakPoints = Math.max(this.peakPoints, this.points);
    return true;
  }
  releaseNode(node: SceneNode): void {
    if (this.resident.delete(node.id)) this.points -= node.entry.count;
  }
}

export async function settle(scene: SceneLod, frame: () => void): Promise<number> {
  let frames = 0;
  for (; frames < 400; frames++) {
    frame();
    if (scene.isIdle()) {
      frame();
      if (scene.isIdle()) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return frames;
}

/** Part des points proches de (x, z) que la sélection dessine. */
function densityNear(scene: SceneLod, x: number, z: number, radius: number): number {
  const selected = new Set(scene.getSelectedNodes().map((node) => node.id));
  let drawn = 0;
  let total = 0;
  for (const node of scene.nodes) {
    if (node.entry.count === 0) continue;
    const dx = Math.max(node.minX - x, 0, x - node.maxX);
    const dz = Math.max(node.minZ - z, 0, z - node.maxZ);
    if (Math.hypot(dx, dz) > radius) continue;
    // Seuls les nœuds assez petits pour être « locaux » mesurent la densité, les gros couvrent la zone.
    if (node.size > radius * 4) continue;
    total += node.entry.count;
    if (selected.has(node.id)) drawn += node.entry.count;
  }
  return total > 0 ? drawn / total : 1;
}

/** Ancien plafond multituile (resolveMultiTilePointCap, 8 Go, GPU dédié), gardé pour rapporter l'« avant ». */
function legacyMultiTileCap(tileCount: number): number {
  let cap = 8_000_000;
  const boost = tileCount >= 8 ? 0.25 : tileCount >= 6 ? 0.5 : tileCount >= 4 ? 0.75 : 1;
  cap += 2_000_000 * boost;
  if (tileCount >= 8) cap *= 0.7;
  else if (tileCount >= 6) cap *= 0.8;
  else if (tileCount >= 4) cap *= 0.9;
  return Math.min(12_000_000, Math.max(2_500_000, Math.round(cap / 250_000) * 250_000));
}

export async function runStreamingCheck(): Promise<void> {
  const perTile = 400_000;
  const tiles: OpenedLodTile[] = [];
  for (let ty = -1; ty <= 1; ty++) {
    for (let tx = -1; tx <= 1; tx++) {
      tiles.push(createInMemoryLodTile(buildLodTile(syntheticTile(tx, ty, perTile))));
    }
  }
  const totalPoints = perTile * tiles.length;
  const center = { x: 1_000_500, y: 6_543_500, z: 1200 };
  const uploader = new CountingUploader();
  const pointBudget = 1_200_000;
  const poolBudget = 1_600_000;
  const scene = new SceneLod(tiles, center, {
    pointBudget,
    poolBudget,
    maxResidentNodes: 16384,
    uploader,
    onNodeResident: () => undefined,
  });
  const proj = renderProjection(1920 / 1080);
  const viewProj = new Float32Array(16);
  const frameAt = (target: [number, number, number], radius: number, phi: number) => () => {
    const { view, eye } = orbitViewMatrix(radius, 0.4, phi, target);
    mat4MultiplyInto(viewProj, proj, view);
    scene.update(viewProj, proj[5]!, eye[0], eye[1], eye[2], 1080);
  };

  // Vue rapprochée au-dessus de la tuile centrale, puis une vue large, puis retour.
  const near = frameAt([0, 0, 0], 60, 0.9);
  const t0 = performance.now();
  const framesNear = await settle(scene, near);
  const nearMs = performance.now() - t0;
  const stats = scene.getStats();
  const density = densityNear(scene, 0, 0, 25);
  const wide = frameAt([0, 0, 0], 2500, 0.7);
  await settle(scene, wide);
  const wideStats = scene.getStats();
  await settle(scene, near);
  const backDensity = densityNear(scene, 0, 0, 25);

  const legacyFraction = legacyMultiTileCap(9) / (20_000_000 * 9);
  check(
    `Streaming 9 tuiles : densité près de la caméra (${framesNear} frames, ${nearMs.toFixed(0)} ms)`,
    density >= 0.999 && backDensity >= 0.999,
    `${(legacyFraction * 100).toFixed(1)} % des points (plafond ${(legacyMultiTileCap(9) / 1e6).toFixed(1)} M pour 9 × 20 M)`,
    `${(density * 100).toFixed(1)} % (et ${(backDensity * 100).toFixed(1)} % après un aller-retour vue large)`,
  );
  check(
    'Streaming 9 tuiles : budget de points et mémoire GPU bornés',
    stats.selectedPoints <= pointBudget && wideStats.selectedPoints <= pointBudget && uploader.peakPoints <= poolBudget,
    'scène entière en mémoire GPU (16 o/pt), cap global avant octree',
    `sélection ${(stats.selectedPoints / 1e6).toFixed(2)} M / vue large ${(wideStats.selectedPoints / 1e6).toFixed(2)} M ≤ ${(pointBudget / 1e6).toFixed(1)} M · pic GPU ${(uploader.peakPoints / 1e6).toFixed(2)} M ≤ ${(poolBudget / 1e6).toFixed(1)} M pts sur ${(totalPoints / 1e6).toFixed(1)} M`,
  );
}
