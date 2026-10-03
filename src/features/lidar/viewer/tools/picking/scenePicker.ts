// ============================================
// LiDAR viewer tools — screen → scene picking
// ============================================
//
// A pick hits the LiDAR returns drawn under the cursor first (tree crown,
// rock, roof), then the ground model. `groundOnly` (Alt held) skips the
// returns: the foot of a tree, the snow-free ground under a forest.

import type { CameraController } from '../../camera';
import { unprojectScreenRay, type ScreenRay } from '../../route/terrainRaycaster';
import type { TerrainField } from '../terrain/terrainField';
import type { ScenePick, Vec3 } from '../types';
import type { PointCloudPicker } from './pointCloudPicker';

/** Half-size of the pick window on the point cloud, CSS px. */
const POINT_PICK_RADIUS_PX = 4;
/** Returns this far behind the ground model are still pickable (DTM smoothing), m. */
const BEHIND_GROUND_TOLERANCE_M = 3;

export interface ScenePickerOptions {
  canvas: HTMLCanvasElement;
  camera: CameraController;
  field: TerrainField;
  pointPicker: PointCloudPicker | null;
  /** Current point diameter, m. */
  getPointSize: () => number;
}

export class ScenePicker {
  private readonly opts: ScenePickerOptions;

  constructor(opts: ScenePickerOptions) {
    this.opts = opts;
  }

  /** Ray through a canvas position (CSS px from the canvas' top-left corner). */
  rayAt(screenX: number, screenY: number): ScreenRay | null {
    const { canvas, camera } = this.opts;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    return unprojectScreenRay(screenX, screenY, width, height, camera.getViewMatrix(), camera.getProjMatrix());
  }

  /** Ground-model pick (synchronous, for hover feedback). */
  pickTerrain(screenX: number, screenY: number): ScenePick | null {
    const ray = this.rayAt(screenX, screenY);
    if (!ray) return null;
    return this.terrainHit(ray)?.pick ?? null;
  }

  async pick(screenX: number, screenY: number, options: { groundOnly?: boolean } = {}): Promise<ScenePick | null> {
    const ray = this.rayAt(screenX, screenY);
    if (!ray) return null;
    const terrain = this.terrainHit(ray);
    const { pointPicker, canvas } = this.opts;
    if (options.groundOnly || !pointPicker) return terrain?.pick ?? null;

    const height = canvas.clientHeight || window.innerHeight;
    const hit = await pointPicker.pick({
      origin: ray.origin,
      direction: ray.direction,
      radiusPerMeter: (POINT_PICK_RADIUS_PX * 2 * Math.tan(this.opts.camera.getFovY() / 2)) / Math.max(1, height),
      minRadiusM: this.opts.getPointSize() * 0.5,
      maxDistance: terrain ? terrain.distance + BEHIND_GROUND_TOLERANCE_M : Number.POSITIVE_INFINITY,
    });
    if (!hit) return terrain?.pick ?? null;
    return this.pickAt(hit.local, 'points', hit.classification);
  }

  /** Builds a pick from a render-frame position. */
  pickAt(local: Vec3, source: ScenePick['source'], classification: number | null): ScenePick {
    const { field } = this.opts;
    const { projX, projY, altitudeM } = field.fromLocal(local);
    const [lon, lat] = field.toLonLat(projX, projY);
    return {
      local,
      projX,
      projY,
      altitudeM,
      lon,
      lat,
      source,
      classification,
      groundAltitudeM: source === 'terrain' ? altitudeM : field.altitudeAt(projX, projY),
    };
  }

  /** The same position on the ground model (tree top → its foot), `null` off the ground. */
  toGround(pick: ScenePick): ScenePick | null {
    if (pick.source === 'terrain') return pick;
    if (pick.groundAltitudeM == null) return null;
    return this.pickAt(this.opts.field.toLocal(pick.projX, pick.projY, pick.groundAltitudeM), 'terrain', null);
  }

  private terrainHit(ray: ScreenRay): { pick: ScenePick; distance: number } | null {
    const hit = this.opts.field.raycast(ray.origin, ray.direction);
    return hit ? { pick: this.pickAt(hit.local, 'terrain', null), distance: hit.distance } : null;
  }
}
