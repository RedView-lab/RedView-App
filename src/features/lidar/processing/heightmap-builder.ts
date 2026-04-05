export interface HeightmapResult {
  vertices: Float32Array;   // xyz + normal (6 floats per vertex)
  colors: Uint8Array;       // rgb per vertex
  indices: Uint32Array;     // triangle indices
  heightGrid: Float32Array; // raw height grid for optional GPU use
  gridWidth: number;
  gridHeight: number;
  vertexCount: number;
  indexCount: number;
}

/**
 * Generate a terrain mesh from ground-classified LiDAR points.
 * Classifications 2 (ground), 9 (water), 17 (bridge deck) are used.
 */
export function buildHeightmap(
  positions: Float32Array,
  colors: Uint8Array,
  classifications: Uint8Array,
  count: number,
  resolution: number = 1.0,
): HeightmapResult {
  // 1. Find bounds of ground points
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  const groundIndices: number[] = [];

  for (let i = 0; i < count; i++) {
    const cls = classifications[i];
    if (cls === 2 || cls === 9 || cls === 17) {
      groundIndices.push(i);
      const x = positions[i * 3], y = positions[i * 3 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }

  // Fallback: if < 5% are classified ground, use all points
  if (groundIndices.length < count * 0.05) {
    groundIndices.length = 0;
    minX = Infinity; maxX = -Infinity;
    minY = Infinity; maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      groundIndices.push(i);
      const x = positions[i * 3], y = positions[i * 3 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }

  const gridW = Math.ceil((maxX - minX) / resolution) + 1;
  const gridH = Math.ceil((maxY - minY) / resolution) + 1;
  const heightGrid = new Float32Array(gridW * gridH).fill(NaN);
  const colorGrid = new Uint8Array(gridW * gridH * 3);
  const countGrid = new Float32Array(gridW * gridH);

  // 2. Bin ground points to grid — average height per cell
  for (const idx of groundIndices) {
    const x = positions[idx * 3], y = positions[idx * 3 + 1], z = positions[idx * 3 + 2];
    const gx = Math.min(gridW - 1, Math.floor((x - minX) / resolution));
    const gy = Math.min(gridH - 1, Math.floor((y - minY) / resolution));
    const gi = gy * gridW + gx;

    const prev = countGrid[gi];
    if (prev === 0) {
      heightGrid[gi] = z;
      colorGrid[gi * 3] = colors[idx * 3];
      colorGrid[gi * 3 + 1] = colors[idx * 3 + 1];
      colorGrid[gi * 3 + 2] = colors[idx * 3 + 2];
    } else {
      heightGrid[gi] = (heightGrid[gi] * prev + z) / (prev + 1);
      // Keep first color (no need to average)
    }
    countGrid[gi] = prev + 1;
  }

  // 3. BFS hole-filling (max 10 cells propagation)
  const MAX_FILL_DIST = 10;
  const filled = new Float32Array(heightGrid);
  const dist = new Int32Array(gridW * gridH).fill(MAX_FILL_DIST + 1);

  // Initialize distances for filled cells
  const queue: number[] = [];
  for (let i = 0; i < heightGrid.length; i++) {
    if (!isNaN(heightGrid[i])) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  // BFS
  let qi = 0;
  while (qi < queue.length) {
    const ci = queue[qi++];
    const cx = ci % gridW;
    const cy = (ci - cx) / gridW;
    const d = dist[ci];
    if (d >= MAX_FILL_DIST) continue;

    const neighbors = [
      cy > 0 ? ci - gridW : -1,
      cy < gridH - 1 ? ci + gridW : -1,
      cx > 0 ? ci - 1 : -1,
      cx < gridW - 1 ? ci + 1 : -1,
    ];

    for (const ni of neighbors) {
      if (ni < 0) continue;
      if (dist[ni] <= d + 1) continue;
      dist[ni] = d + 1;
      filled[ni] = filled[ci];
      // Copy color too
      colorGrid[ni * 3] = colorGrid[ci * 3];
      colorGrid[ni * 3 + 1] = colorGrid[ci * 3 + 1];
      colorGrid[ni * 3 + 2] = colorGrid[ci * 3 + 2];
      queue.push(ni);
    }
  }

  // 4. Build mesh vertices + normals + indices
  const validMask = new Uint8Array(gridW * gridH);
  let validCount = 0;
  for (let i = 0; i < filled.length; i++) {
    if (!isNaN(filled[i])) {
      validMask[i] = 1;
      validCount++;
    }
  }

  // Index map: grid cell → vertex index
  const vertexIndex = new Int32Array(gridW * gridH).fill(-1);
  let vi = 0;
  for (let i = 0; i < filled.length; i++) {
    if (validMask[i]) vertexIndex[i] = vi++;
  }

  const vertexCount = validCount;
  const vertices = new Float32Array(vertexCount * 6); // xyz + normal
  const outColors = new Uint8Array(vertexCount * 3);

  // Write vertex positions + compute normals from height gradients
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const gi = gy * gridW + gx;
      if (!validMask[gi]) continue;

      const idx = vertexIndex[gi];
      const x = minX + gx * resolution;
      const y = minY + gy * resolution;
      const z = filled[gi];

      vertices[idx * 6] = x;
      vertices[idx * 6 + 1] = y;
      vertices[idx * 6 + 2] = z;

      // Central difference normal
      const zL = gx > 0 && validMask[gi - 1] ? filled[gi - 1] : z;
      const zR = gx < gridW - 1 && validMask[gi + 1] ? filled[gi + 1] : z;
      const zD = gy > 0 && validMask[gi - gridW] ? filled[gi - gridW] : z;
      const zU = gy < gridH - 1 && validMask[gi + gridW] ? filled[gi + gridW] : z;

      const dzdx = (zR - zL) / (2 * resolution);
      const dzdy = (zU - zD) / (2 * resolution);
      let nx = -dzdx, ny = -dzdy, nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;

      vertices[idx * 6 + 3] = nx;
      vertices[idx * 6 + 4] = ny;
      vertices[idx * 6 + 5] = nz;

      outColors[idx * 3] = colorGrid[gi * 3];
      outColors[idx * 3 + 1] = colorGrid[gi * 3 + 1];
      outColors[idx * 3 + 2] = colorGrid[gi * 3 + 2];
    }
  }

  // Build triangle indices
  const triangles: number[] = [];
  for (let gy = 0; gy < gridH - 1; gy++) {
    for (let gx = 0; gx < gridW - 1; gx++) {
      const gi00 = gy * gridW + gx;
      const gi10 = gi00 + 1;
      const gi01 = gi00 + gridW;
      const gi11 = gi00 + gridW + 1;

      const v00 = vertexIndex[gi00];
      const v10 = vertexIndex[gi10];
      const v01 = vertexIndex[gi01];
      const v11 = vertexIndex[gi11];

      if (v00 >= 0 && v10 >= 0 && v01 >= 0) {
        triangles.push(v00, v10, v01);
      }
      if (v10 >= 0 && v11 >= 0 && v01 >= 0) {
        triangles.push(v10, v11, v01);
      }
    }
  }

  return {
    vertices,
    colors: outColors,
    indices: new Uint32Array(triangles),
    heightGrid: filled,
    gridWidth: gridW,
    gridHeight: gridH,
    vertexCount,
    indexCount: triangles.length,
  };
}
