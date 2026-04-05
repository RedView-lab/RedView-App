export function estimateNormals(
  positions: Float32Array,
  count: number,
): Float32Array {
  const normals = new Float32Array(count * 3);
  const K = 12;
  const CELL_SIZE = 2.0;
  const INV_CELL = 1.0 / CELL_SIZE;

  const grid = new Map<number, number[]>();

  for (let i = 0; i < count; i++) {
    const cx = Math.floor(positions[i * 3] * INV_CELL);
    const cy = Math.floor(positions[i * 3 + 1] * INV_CELL);
    const cz = Math.floor(positions[i * 3 + 2] * INV_CELL);
    const key = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }

  function findKNearest(idx: number): number[] {
    const px = positions[idx * 3];
    const py = positions[idx * 3 + 1];
    const pz = positions[idx * 3 + 2];
    const cx = Math.floor(px * INV_CELL);
    const cy = Math.floor(py * INV_CELL);
    const cz = Math.floor(pz * INV_CELL);

    const candidates: Array<[number, number]> = [];

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = ((cx + dx) * 73856093) ^ ((cy + dy) * 19349663) ^ ((cz + dz) * 83492791);
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j === idx) continue;
            const dx2 = positions[j * 3] - px;
            const dy2 = positions[j * 3 + 1] - py;
            const dz2 = positions[j * 3 + 2] - pz;
            candidates.push([j, dx2 * dx2 + dy2 * dy2 + dz2 * dz2]);
          }
        }
      }
    }

    candidates.sort((a, b) => a[1] - b[1]);
    return candidates.slice(0, K).map(c => c[0]);
  }

  function computeNormal(idx: number, neighbors: number[]): [number, number, number] {
    if (neighbors.length < 3) return [0, 0, 1];

    const px = positions[idx * 3];
    const py = positions[idx * 3 + 1];
    const pz = positions[idx * 3 + 2];
    const n = neighbors.length;

    let cxx = 0, cxy = 0, cxz = 0;
    let cyy = 0, cyz = 0, czz = 0;

    for (const j of neighbors) {
      const dx = positions[j * 3] - px;
      const dy = positions[j * 3 + 1] - py;
      const dz = positions[j * 3 + 2] - pz;
      cxx += dx * dx;
      cxy += dx * dy;
      cxz += dx * dz;
      cyy += dy * dy;
      cyz += dy * dz;
      czz += dz * dz;
    }

    cxx /= n; cxy /= n; cxz /= n;
    cyy /= n; cyz /= n; czz /= n;

    const p = -(cxx + cyy + czz);
    const q = cxx * cyy + cxx * czz + cyy * czz - cxy * cxy - cxz * cxz - cyz * cyz;
    const r = -(
      cxx * cyy * czz + 2 * cxy * cxz * cyz
      - cxx * cyz * cyz - cyy * cxz * cxz - czz * cxy * cxy
    );

    const p2 = p * p;
    const disc = p2 / 3 - q;
    if (disc <= 0) return [0, 0, 1];

    const sqrtDisc = Math.sqrt(disc);
    const m = 2 * sqrtDisc;
    const theta = Math.acos(
      Math.max(-1, Math.min(1, ((2 * p * p * p) / 27 - p * q / 3 + r) / (2 * disc * sqrtDisc))),
    ) / 3;

    const lambda0 = -p / 3 + m * Math.cos(theta);
    const lambda1 = -p / 3 + m * Math.cos(theta + (2 * Math.PI) / 3);
    const lambda2 = -p / 3 + m * Math.cos(theta + (4 * Math.PI) / 3);

    const minLambda = Math.min(lambda0, lambda1, lambda2);

    const a00 = cxx - minLambda;
    const a01 = cxy;
    const a02 = cxz;
    const a11 = cyy - minLambda;
    const a12 = cyz;
    const a22 = czz - minLambda;

    let nx = a01 * a12 - a02 * a11;
    let ny = a02 * a01 - a00 * a12;
    let nz = a00 * a11 - a01 * a01;

    if (nx === 0 && ny === 0 && nz === 0) {
      nx = a01 * a22 - a02 * a12;
      ny = a02 * a02 - a00 * a22;
      nz = a00 * a12 - a01 * a02;
    }

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-10) return [0, 0, 1];

    nx /= len;
    ny /= len;
    nz /= len;

    if (nz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    return [nx, ny, nz];
  }

  for (let i = 0; i < count; i++) {
    const neighbors = findKNearest(i);
    const [nx, ny, nz] = computeNormal(i, neighbors);
    normals[i * 3] = nx;
    normals[i * 3 + 1] = ny;
    normals[i * 3 + 2] = nz;
  }

  return normals;
}
