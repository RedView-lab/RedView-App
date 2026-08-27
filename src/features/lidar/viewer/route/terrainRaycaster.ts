import { fromWgs84, toWgs84 } from '../../lib/coordConvert';
import type { ViewerRouteSceneParams } from './types';

export interface ScreenRay {
  origin: [number, number, number];
  direction: [number, number, number];
}

export interface TerrainHitResult {
  localX: number;
  localY: number;
  localZ: number;
  projX: number;
  projY: number;
  lat: number;
  lon: number;
  elevationM: number;
  distanceFromCamera: number;
}

export interface ProjectedScreenPoint {
  screenX: number;
  screenY: number;
  inFront: boolean;
  distance: number;
}

/**
 * Invert a 4x4 column-major matrix
 */
export function invertMatrix4(out: Float32Array, m: Float32Array): boolean {
  const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
  const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
  const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
  const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

  const b00 = m00 * m11 - m01 * m10;
  const b01 = m00 * m12 - m02 * m10;
  const b02 = m00 * m13 - m03 * m10;
  const b03 = m01 * m12 - m02 * m11;
  const b04 = m01 * m13 - m03 * m11;
  const b05 = m02 * m13 - m03 * m12;
  const b06 = m20 * m31 - m21 * m30;
  const b07 = m20 * m32 - m22 * m30;
  const b08 = m20 * m33 - m23 * m30;
  const b09 = m21 * m32 - m22 * m31;
  const b10 = m21 * m33 - m23 * m31;
  const b11 = m22 * m33 - m23 * m32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || Math.abs(det) < 1e-12) return false;
  const invDet = 1.0 / det;

  out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * invDet;
  out[1] = (-m01 * b11 + m02 * b10 - m03 * b09) * invDet;
  out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * invDet;
  out[3] = (-m21 * b05 + m22 * b04 - m23 * b03) * invDet;
  out[4] = (-m10 * b11 + m12 * b08 - m13 * b07) * invDet;
  out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * invDet;
  out[6] = (-m30 * b05 + m32 * b02 - m33 * b01) * invDet;
  out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * invDet;
  out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * invDet;
  out[9] = (-m00 * b10 + m01 * b08 - m03 * b06) * invDet;
  out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * invDet;
  out[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * invDet;
  out[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * invDet;
  out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * invDet;
  out[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * invDet;
  out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * invDet;

  return true;
}

/**
 * Multiply matrix 4x4 by vector 4
 */
function multiplyMat4Vec4(m: Float32Array, v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

/**
 * Unprojects screen pixel coordinates into a 3D ray (origin & normalized direction).
 */
export function unprojectScreenRay(
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
  viewMatrix: Float32Array,
  projMatrix: Float32Array,
): ScreenRay | null {
  if (canvasWidth <= 0 || canvasHeight <= 0) return null;

  // Normalized Device Coordinates (NDC)
  const ndcX = (screenX / canvasWidth) * 2 - 1;
  const ndcY = 1 - (screenY / canvasHeight) * 2;

  // Compute View-Projection Matrix: VP = P * V
  const vp = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      vp[j * 4 + i] =
        projMatrix[0 * 4 + i] * viewMatrix[j * 4 + 0] +
        projMatrix[1 * 4 + i] * viewMatrix[j * 4 + 1] +
        projMatrix[2 * 4 + i] * viewMatrix[j * 4 + 2] +
        projMatrix[3 * 4 + i] * viewMatrix[j * 4 + 3];
    }
  }

  const invVp = new Float32Array(16);
  if (!invertMatrix4(invVp, vp)) return null;

  // Near plane in WebGPU is depth 0.0 (or -1.0 in standard clip space)
  const nearVec = multiplyMat4Vec4(invVp, [ndcX, ndcY, 0.0, 1.0]);
  const farVec = multiplyMat4Vec4(invVp, [ndcX, ndcY, 1.0, 1.0]);

  if (Math.abs(nearVec[3]) < 1e-9 || Math.abs(farVec[3]) < 1e-9) return null;

  const pNear: [number, number, number] = [
    nearVec[0] / nearVec[3],
    nearVec[1] / nearVec[3],
    nearVec[2] / nearVec[3],
  ];
  const pFar: [number, number, number] = [
    farVec[0] / farVec[3],
    farVec[1] / farVec[3],
    farVec[2] / farVec[3],
  ];

  let dirX = pFar[0] - pNear[0];
  let dirY = pFar[1] - pNear[1];
  let dirZ = pFar[2] - pNear[2];
  const len = Math.hypot(dirX, dirY, dirZ);
  if (len < 1e-7) return null;

  dirX /= len;
  dirY /= len;
  dirZ /= len;

  return {
    origin: pNear,
    direction: [dirX, dirY, dirZ],
  };
}

/**
 * Projects a local 3D point (x, y, z) into 2D screen coordinates.
 */
export function projectToScreen(
  localX: number,
  localY: number,
  localZ: number,
  canvasWidth: number,
  canvasHeight: number,
  viewMatrix: Float32Array,
  projMatrix: Float32Array,
): ProjectedScreenPoint {
  // 1) View transform
  const vx =
    viewMatrix[0] * localX +
    viewMatrix[4] * localY +
    viewMatrix[8] * localZ +
    viewMatrix[12];
  const vy =
    viewMatrix[1] * localX +
    viewMatrix[5] * localY +
    viewMatrix[9] * localZ +
    viewMatrix[13];
  const vz =
    viewMatrix[2] * localX +
    viewMatrix[6] * localY +
    viewMatrix[10] * localZ +
    viewMatrix[14];
  const vw =
    viewMatrix[3] * localX +
    viewMatrix[7] * localY +
    viewMatrix[11] * localZ +
    viewMatrix[15];

  // 2) Proj transform
  const cx = projMatrix[0] * vx + projMatrix[4] * vy + projMatrix[8] * vz + projMatrix[12] * vw;
  const cy = projMatrix[1] * vx + projMatrix[5] * vy + projMatrix[9] * vz + projMatrix[13] * vw;
  const cz = projMatrix[2] * vx + projMatrix[6] * vy + projMatrix[10] * vz + projMatrix[14] * vw;
  const cw = projMatrix[3] * vx + projMatrix[7] * vy + projMatrix[11] * vz + projMatrix[15] * vw;

  if (cw <= 0.001) {
    return { screenX: -9999, screenY: -9999, inFront: false, distance: 999999 };
  }

  const ndcX = cx / cw;
  const ndcY = cy / cw;
  const ndcZ = cz / cw;

  const screenX = (ndcX + 1) * 0.5 * canvasWidth;
  const screenY = (1 - ndcY) * 0.5 * canvasHeight;
  const inFront = ndcZ >= -0.1 && ndcZ <= 1.1;

  return {
    screenX,
    screenY,
    inFront,
    distance: Math.hypot(vx, vy, vz),
  };
}

/**
 * Samples LiDAR terrain elevation at projected coordinates (projX, projY).
 */
export function sampleElevationAtProj(
  projX: number,
  projY: number,
  params: ViewerRouteSceneParams,
): number {
  const { bounds, heightGrid, gridWidth, gridHeight, centerZ } = params;
  if (!heightGrid || !gridWidth || !gridHeight || gridWidth < 2 || gridHeight < 2) {
    return 0;
  }

  const rangeX = bounds.maxX - bounds.minX;
  const rangeY = bounds.maxY - bounds.minY;
  if (rangeX <= 0 || rangeY <= 0) return 0;

  const gx = ((projX - bounds.minX) / rangeX) * (gridWidth - 1);
  const gy = ((projY - bounds.minY) / rangeY) * (gridHeight - 1);

  if (gx < 0 || gx > gridWidth - 1 || gy < 0 || gy > gridHeight - 1) {
    return 0;
  }

  const x0 = Math.min(gridWidth - 2, Math.max(0, Math.floor(gx)));
  const y0 = Math.min(gridHeight - 2, Math.max(0, Math.floor(gy)));
  const fx = gx - x0;
  const fy = gy - y0;

  const z00 = heightGrid[y0 * gridWidth + x0];
  const z10 = heightGrid[y0 * gridWidth + (x0 + 1)];
  const z01 = heightGrid[(y0 + 1) * gridWidth + x0];
  const z11 = heightGrid[(y0 + 1) * gridWidth + (x0 + 1)];

  if (
    Number.isFinite(z00) &&
    Number.isFinite(z10) &&
    Number.isFinite(z01) &&
    Number.isFinite(z11)
  ) {
    let interpolated =
      (1 - fx) * (1 - fy) * z00! +
      fx * (1 - fy) * z10! +
      (1 - fx) * fy * z01! +
      fx * fy * z11!;

    if (centerZ > 50 && Math.abs(interpolated - centerZ) < Math.abs(interpolated)) {
      interpolated -= centerZ;
    }
    return interpolated;
  }

  return 0;
}

/**
 * Fast & precise Ray-LiDAR terrain intersection with binary bisection.
 */
export function raycastTerrain(
  ray: ScreenRay,
  params: ViewerRouteSceneParams,
  cameraEye?: [number, number, number],
): TerrainHitResult | null {
  const { bounds, centerX, centerY, centerZ, crs } = params;

  // Local bounding box of the tile terrain
  const minLocalX = bounds.minX - centerX - 50;
  const maxLocalX = bounds.maxX - centerX + 50;
  const minLocalZ = -(bounds.maxY - centerY) - 50;
  const maxLocalZ = -(bounds.minY - centerY) + 50;
  const minLocalY = bounds.minZ - centerZ - 200;
  const maxLocalY = bounds.maxZ - centerZ + 200;

  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;

  // Ray-AABB intersection bounds
  let tmin = 0.1;
  let tmax = 50000;

  // X slab
  if (Math.abs(dx) > 1e-6) {
    const tx1 = (minLocalX - ox) / dx;
    const tx2 = (maxLocalX - ox) / dx;
    tmin = Math.max(tmin, Math.min(tx1, tx2));
    tmax = Math.min(tmax, Math.max(tx1, tx2));
  }
  // Y slab
  if (Math.abs(dy) > 1e-6) {
    const ty1 = (minLocalY - oy) / dy;
    const ty2 = (maxLocalY - oy) / dy;
    tmin = Math.max(tmin, Math.min(ty1, ty2));
    tmax = Math.min(tmax, Math.max(ty1, ty2));
  }
  // Z slab
  if (Math.abs(dz) > 1e-6) {
    const tz1 = (minLocalZ - oz) / dz;
    const tz2 = (maxLocalZ - oz) / dz;
    tmin = Math.max(tmin, Math.min(tz1, tz2));
    tmax = Math.min(tmax, Math.max(tz1, tz2));
  }

  if (tmin > tmax || tmax < 0.5) {
    return null;
  }

  // March along ray to detect surface crossing
  const totalDist = tmax - tmin;
  const stepCount = Math.min(300, Math.max(40, Math.ceil(totalDist / 2.0)));
  const step = totalDist / stepCount;

  let prevT = tmin;
  let prevDiff = 0;

  for (let i = 0; i <= stepCount; i++) {
    const curT = tmin + i * step;
    const curX = ox + curT * dx;
    const curY = oy + curT * dy;
    const curZ = oz + curT * dz;

    const projX = curX + centerX;
    const projY = -curZ + centerY;
    const terrY = sampleElevationAtProj(projX, projY, params);
    const curDiff = curY - terrY;

    if (i > 0 && prevDiff * curDiff <= 0) {
      // Sign change: root lies in [prevT, curT]
      let lo = prevT;
      let hi = curT;

      for (let b = 0; b < 12; b++) {
        const mid = (lo + hi) * 0.5;
        const mx = ox + mid * dx;
        const my = oy + mid * dy;
        const mz = oz + mid * dz;
        const mProjX = mx + centerX;
        const mProjY = -mz + centerY;
        const mTerrY = sampleElevationAtProj(mProjX, mProjY, params);
        const mDiff = my - mTerrY;

        if (prevDiff * mDiff <= 0) {
          hi = mid;
        } else {
          lo = mid;
        }
      }

      const hitT = (lo + hi) * 0.5;
      const hitX = ox + hitT * dx;
      const hitZ = oz + hitT * dz;
      const hitProjX = hitX + centerX;
      const hitProjY = -hitZ + centerY;
      const hitY = sampleElevationAtProj(hitProjX, hitProjY, params);
      const [lon, lat] = toWgs84(hitProjX, hitProjY, crs);
      const elevationM = hitY + centerZ;

      const camDist = cameraEye
        ? Math.hypot(hitX - cameraEye[0], hitY - cameraEye[1], hitZ - cameraEye[2])
        : hitT;

      return {
        localX: hitX,
        localY: hitY,
        localZ: hitZ,
        projX: hitProjX,
        projY: hitProjY,
        lat,
        lon,
        elevationM,
        distanceFromCamera: camDist,
      };
    }

    prevT = curT;
    prevDiff = curDiff;
  }

  return null;
}

/**
 * Converts geographic coordinates (lat, lon) to local viewer space (localX, localY, localZ).
 */
export function geoToLocal3D(
  lat: number,
  lon: number,
  params: ViewerRouteSceneParams,
  elevationBias = 0.65,
  elevationMOverride?: number | null,
): { localX: number; localY: number; localZ: number; projX: number; projY: number; elevationM: number } {
  const { centerX, centerY, centerZ, crs } = params;
  const [projX, projY] = fromWgs84(lon, lat, crs);
  const sampleY = sampleElevationAtProj(projX, projY, params);
  const localY = (elevationMOverride != null ? elevationMOverride - centerZ : sampleY) + elevationBias;

  return {
    localX: projX - centerX,
    localY,
    localZ: -(projY - centerY),
    projX,
    projY,
    elevationM: sampleY + centerZ,
  };
}
