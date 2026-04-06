// ============================================
// PCA Normal Estimation — Web Worker
// ============================================

interface WorkerInput {
  type: 'compute';
  positions: Float32Array;
  count: number;
}

interface WorkerProgress {
  type: 'progress';
  pct: number;
}

interface WorkerDone {
  type: 'done';
  normals: Float32Array;
}

self.onmessage = (e: MessageEvent<WorkerInput>) => {
  if (e.data.type !== 'compute') return;
  const { positions, count } = e.data;
  const normals = computeNormals(positions, count);
  (self as any).postMessage({ type: 'done', normals } as WorkerDone, [normals.buffer]);
};

function computeNormals(positions: Float32Array, count: number): Float32Array {
  const normals = new Float32Array(count * 3);

  if (count < 4) {
    for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
    return normals;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }

  const volume = Math.max((maxX - minX) * (maxY - minY) * Math.max(maxZ - minZ, 1), 1);
  const avgSpacing = Math.cbrt(volume / count);
  const cellSize = avgSpacing * 3;

  const gridNx = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1);
  const gridNy = Math.max(1, Math.ceil((maxY - minY) / cellSize) + 1);
  const gridNz = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 1);
  const gridTotal = gridNx * gridNy * gridNz;

  // Flat spatial hash (count sort)
  const cellCount = new Uint32Array(gridTotal);
  const cellOf = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const cx = Math.floor((positions[i * 3] - minX) / cellSize);
    const cy = Math.floor((positions[i * 3 + 1] - minY) / cellSize);
    const cz = Math.floor((positions[i * 3 + 2] - minZ) / cellSize);
    const key = cx + cy * gridNx + cz * gridNx * gridNy;
    cellOf[i] = key;
    cellCount[key]++;
  }

  const cellStart = new Uint32Array(gridTotal + 1);
  for (let i = 0; i < gridTotal; i++) {
    cellStart[i + 1] = cellStart[i] + cellCount[i];
  }

  const sortedIndices = new Uint32Array(count);
  const writePos = new Uint32Array(gridTotal);
  for (let i = 0; i < count; i++) {
    const key = cellOf[i];
    sortedIndices[cellStart[key] + writePos[key]] = i;
    writePos[key]++;
  }

  (self as any).postMessage({ type: 'progress', pct: 5 } as WorkerProgress);

  const K = 12;
  const kDist = new Float64Array(K);
  const kIdx = new Int32Array(K);
  const REPORT_INTERVAL = 50_000;

  for (let i = 0; i < count; i++) {
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
    const cx = Math.floor((px - minX) / cellSize);
    const cy = Math.floor((py - minY) / cellSize);
    const cz = Math.floor((pz - minZ) / cellSize);

    let kFound = 0;
    let kMaxDist = Infinity;

    for (let dz = -1; dz <= 1; dz++) {
      const nz = cz + dz;
      if (nz < 0 || nz >= gridNz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= gridNy) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= gridNx) continue;
          const key = nx + ny * gridNx + nz * gridNx * gridNy;
          const start = cellStart[key];
          const end = cellStart[key + 1];
          for (let s = start; s < end; s++) {
            const j = sortedIndices[s];
            if (j === i) continue;
            const ddx = positions[j * 3] - px;
            const ddy = positions[j * 3 + 1] - py;
            const ddz = positions[j * 3 + 2] - pz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;

            if (kFound < K) {
              kDist[kFound] = d2;
              kIdx[kFound] = j;
              kFound++;
              if (kFound === K) {
                kMaxDist = kDist[0];
                for (let m = 1; m < K; m++) {
                  if (kDist[m] > kMaxDist) kMaxDist = kDist[m];
                }
              }
            } else if (d2 < kMaxDist) {
              let maxSlot = 0;
              for (let m = 1; m < K; m++) {
                if (kDist[m] > kDist[maxSlot]) maxSlot = m;
              }
              kDist[maxSlot] = d2;
              kIdx[maxSlot] = j;
              kMaxDist = kDist[0];
              for (let m = 1; m < K; m++) {
                if (kDist[m] > kMaxDist) kMaxDist = kDist[m];
              }
            }
          }
        }
      }
    }

    if (kFound < 3) {
      normals[i * 3 + 1] = 1;
      continue;
    }

    let centX = px, centY = py, centZ = pz;
    for (let m = 0; m < kFound; m++) {
      const j = kIdx[m];
      centX += positions[j * 3];
      centY += positions[j * 3 + 1];
      centZ += positions[j * 3 + 2];
    }
    const n = kFound + 1;
    centX /= n; centY /= n; centZ /= n;

    let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    let ex = px - centX, ey = py - centY, ez = pz - centZ;
    cxx += ex * ex; cxy += ex * ey; cxz += ex * ez;
    cyy += ey * ey; cyz += ey * ez; czz += ez * ez;

    for (let m = 0; m < kFound; m++) {
      const j = kIdx[m];
      ex = positions[j * 3] - centX;
      ey = positions[j * 3 + 1] - centY;
      ez = positions[j * 3 + 2] - centZ;
      cxx += ex * ex; cxy += ex * ey; cxz += ex * ez;
      cyy += ey * ey; cyz += ey * ez; czz += ez * ez;
    }

    const normal = smallestEigenvector3x3(cxx, cxy, cxz, cyy, cyz, czz);
    if (normal[1] < 0) {
      normal[0] = -normal[0]; normal[1] = -normal[1]; normal[2] = -normal[2];
    }

    normals[i * 3] = normal[0];
    normals[i * 3 + 1] = normal[1];
    normals[i * 3 + 2] = normal[2];

    if (i % REPORT_INTERVAL === 0 && i > 0) {
      (self as any).postMessage({ type: 'progress', pct: 5 + Math.round((i / count) * 95) } as WorkerProgress);
    }
  }

  return normals;
}

function smallestEigenvector3x3(
  a11: number, a12: number, a13: number,
  a22: number, a23: number, a33: number
): [number, number, number] {
  const p1 = a12 * a12 + a13 * a13 + a23 * a23;

  if (p1 < 1e-12) {
    const e1 = a11, e2 = a22, e3 = a33;
    const minE = Math.min(e1, e2, e3);
    if (minE === e1) return [1, 0, 0];
    if (minE === e2) return [0, 1, 0];
    return [0, 0, 1];
  }

  const q = (a11 + a22 + a33) / 3;
  const p2 = (a11 - q) ** 2 + (a22 - q) ** 2 + (a33 - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);

  const b11 = (a11 - q) / p;
  const b12 = a12 / p;
  const b13 = a13 / p;
  const b22 = (a22 - q) / p;
  const b23 = a23 / p;
  const b33 = (a33 - q) / p;

  const detB = b11 * (b22 * b33 - b23 * b23)
             - b12 * (b12 * b33 - b23 * b13)
             + b13 * (b12 * b23 - b22 * b13);

  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const e3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);

  const r1x = a11 - e3, r1y = a12,      r1z = a13;
  const r2x = a12,      r2y = a22 - e3, r2z = a23;
  const r3x = a13,      r3y = a23,      r3z = a33 - e3;

  let vx = r1y * r2z - r1z * r2y;
  let vy = r1z * r2x - r1x * r2z;
  let vz = r1x * r2y - r1y * r2x;
  let len = Math.sqrt(vx * vx + vy * vy + vz * vz);

  if (len < 1e-10) {
    vx = r1y * r3z - r1z * r3y;
    vy = r1z * r3x - r1x * r3z;
    vz = r1x * r3y - r1y * r3x;
    len = Math.sqrt(vx * vx + vy * vy + vz * vz);
  }

  if (len < 1e-10) {
    vx = r2y * r3z - r2z * r3y;
    vy = r2z * r3x - r2x * r3z;
    vz = r2x * r3y - r2y * r3x;
    len = Math.sqrt(vx * vx + vy * vy + vz * vz);
  }

  if (len < 1e-10) return [0, 1, 0];
  return [vx / len, vy / len, vz / len];
}
