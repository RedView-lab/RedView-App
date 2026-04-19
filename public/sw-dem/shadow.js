// ---------------------------------------------------------------------------
// Shadow computation from DEM elevations — sweep-line horizon algorithm
//
// For the entire 3×3 padded DEM neighbourhood (768×768 pixels), a single-pass
// sweep propagates the "shadow line" in the direction away from the sun:
//
//   For each pixel along the sweep (from the sun-facing edge outward):
//     shadowElev -= dropPerStep          // sun ray descends
//     if terrain[px] < shadowElev → in shadow (shadow continues)
//     else → lit, terrain becomes the new shadow caster
//
// Complexity: O(N) — exactly one comparison per pixel, vs the old per-pixel
// ray-march which was O(N × maxSteps). This makes shadow computation
// essentially instant (<10 ms for a 768² buffer) even in the service worker.
//
// Output: 8-bit RGBA PNG
//   R = shadow factor: 0 = fully lit, 255 = fully shadowed
//   G, B = 0 (reserved)
//   A = 0 on NoData, 255 otherwise
//
// Decoded GPU-side via Mapbox raster-color-mix [1, 0, 0, 0] → [0..1]
// ---------------------------------------------------------------------------

// ── Build padded elevation buffer (3×3 tile neighborhood) ─────────────
// Returns a (3S)×(3S) Float32Array where the center tile sits at [S,S].
// Missing neighbours get NaN-filled; the sweep treats NaN as "no terrain"
// (shadow cannot originate from or cross a NaN pixel).
async function buildShadowPaddedElevations(centerElev, z, x, y, demCache) {
  const S = DEM_TILE_SIZE; // 256
  const P = S * 3;
  const pad = new Float32Array(P * P);
  pad.fill(NaN);

  async function cachedElev(nx, ny) {
    if (ny < 0 || nx < 0 || nx >= (1 << z)) return null;
    const resp = await demCache.match(new Request(`/dem-tiles/${z}/${nx}/${ny}`));
    if (!resp || resp.status !== 200) return null;
    try { return await decodeTerrainRGBBlob(await resp.clone().blob()); }
    catch { return null; }
  }

  // Fetch all 8 neighbours + center in parallel
  const offsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0], [0,  0], [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];
  const tiles = await Promise.all(
    offsets.map(([dx, dy]) => {
      if (dx === 0 && dy === 0) return Promise.resolve(centerElev);
      return cachedElev(x + dx, y + dy);
    })
  );

  for (let i = 0; i < offsets.length; i++) {
    const elev = tiles[i];
    if (!elev) continue;
    const [dx, dy] = offsets[i];
    const ox = (dx + 1) * S;
    const oy = (dy + 1) * S;
    for (let r = 0; r < S; r++) {
      const srcOff = r * S;
      const dstOff = (oy + r) * P + ox;
      for (let c = 0; c < S; c++) {
        pad[dstOff + c] = elev[srcOff + c];
      }
    }
  }

  return pad;
}

// ── Sweep-line shadow computation (O(N)) ──────────────────────────────
//
// Algorithm: decompose the sun direction into a major axis (the grid axis
// most aligned with the shadow propagation) and a minor fractional step.
// Sweep one major-axis slice at a time; within each slice, step across all
// pixels perpendicular to the major axis. For each pixel, inherit the
// shadow line from the previous pixel one major-step toward the sun, offset
// by the minor fraction (nearest-neighbour). This is the standard "local
// horizon" approach used by ArcGIS Hillshade and GDAL.
//
// Shadow direction = opposite of sun direction.
// Sun toward:  dcol = sin(az), drow = -cos(az)
// Shadow prop: dcol = -sin(az), drow = cos(az)
//
function computeSweepShadow(pad, z, x, y, sunAzDeg, sunAltDeg) {
  const S = DEM_TILE_SIZE;
  const P = S * 3;

  // Trivial cases
  if (sunAltDeg <= 0) {
    const out = new Uint8Array(S * S);
    out.fill(255);
    return out;
  }
  if (sunAltDeg >= 85) {
    // Sun nearly overhead — no appreciable terrain shadows
    return new Uint8Array(S * S); // all zeros = lit
  }

  // Cell size in meters
  const bounds = mercatorTileBounds(z, x, y);
  const midLat = (bounds.north + bounds.south) / 2;
  const latRad = (midLat * Math.PI) / 180;
  const metersX = ((bounds.east - bounds.west) * Math.PI * 6378137 * Math.cos(latRad)) / 180;
  const metersY = ((bounds.north - bounds.south) * Math.PI * 6378137) / 180;
  const cellSizeX = metersX / S;
  const cellSizeY = metersY / S;

  const azRad = (sunAzDeg * Math.PI) / 180;
  const tanAlt = Math.tan((sunAltDeg * Math.PI) / 180);

  // Shadow propagation direction in grid coords
  // (col increases East, row increases South)
  const shadowDC = -Math.sin(azRad); // column component
  const shadowDR = Math.cos(azRad);  // row component (cos because az=0→N→row decreases, shadow goes south→+row)

  const absDC = Math.abs(shadowDC);
  const absDR = Math.abs(shadowDR);

  // Shadow elevation buffer for propagation (on the full padded grid)
  const shadowElev = new Float32Array(P * P);
  shadowElev.fill(-Infinity);

  // Result buffer (center tile only)
  const shadowOut = new Uint8Array(S * S);

  if (absDC >= absDR) {
    // ── Column-major sweep ──────────────────────────────────────────
    // Step 1 column per iteration in the shadow direction.
    // Minor step = fractional row shift per column step.
    const colStep = shadowDC > 0 ? 1 : -1;
    const rowShift = shadowDR / absDC; // rows per column step (can be fractional)

    // Horizontal distance per major step (meters)
    const stepDistM = Math.sqrt(
      cellSizeX * cellSizeX + (rowShift * cellSizeY) * (rowShift * cellSizeY)
    );
    const dropPerStep = stepDistM * tanAlt;

    // Sweep start/end columns
    const colStart = colStep > 0 ? 0 : P - 1;
    const colEnd = colStep > 0 ? P : -1;

    for (let c = colStart; c !== colEnd; c += colStep) {
      for (let r = 0; r < P; r++) {
        const idx = r * P + c;
        const elev = pad[idx];

        if (isNaN(elev)) {
          shadowElev[idx] = -Infinity; // NaN breaks shadow chain
          continue;
        }

        // Predecessor: one step toward the sun
        const predC = c - colStep;
        const predR = Math.round(r - rowShift);

        if (predC < 0 || predC >= P || predR < 0 || predR >= P) {
          // Edge — no predecessor, pixel is lit by default
          shadowElev[idx] = elev;
          continue;
        }

        const predIdx = predR * P + predC;
        const propagated = shadowElev[predIdx] - dropPerStep;

        if (elev < propagated) {
          // Terrain is below the descending shadow line → in shadow
          shadowElev[idx] = propagated; // shadow continues at this height
          // Mark output if within center tile
          const cr = r - S;
          const cc = c - S;
          if (cr >= 0 && cr < S && cc >= 0 && cc < S) {
            shadowOut[cr * S + cc] = 255;
          }
        } else {
          // Terrain is above shadow line → lit, becomes new caster
          shadowElev[idx] = elev;
        }
      }
    }
  } else {
    // ── Row-major sweep ─────────────────────────────────────────────
    const rowStep = shadowDR > 0 ? 1 : -1;
    const colShift = shadowDC / absDR; // columns per row step

    const stepDistM = Math.sqrt(
      (colShift * cellSizeX) * (colShift * cellSizeX) + cellSizeY * cellSizeY
    );
    const dropPerStep = stepDistM * tanAlt;

    const rowStart = rowStep > 0 ? 0 : P - 1;
    const rowEnd = rowStep > 0 ? P : -1;

    for (let r = rowStart; r !== rowEnd; r += rowStep) {
      for (let c = 0; c < P; c++) {
        const idx = r * P + c;
        const elev = pad[idx];

        if (isNaN(elev)) {
          shadowElev[idx] = -Infinity;
          continue;
        }

        const predR = r - rowStep;
        const predC = Math.round(c - colShift);

        if (predR < 0 || predR >= P || predC < 0 || predC >= P) {
          shadowElev[idx] = elev;
          continue;
        }

        const predIdx = predR * P + predC;
        const propagated = shadowElev[predIdx] - dropPerStep;

        if (elev < propagated) {
          shadowElev[idx] = propagated;
          const cr = r - S;
          const cc = c - S;
          if (cr >= 0 && cr < S && cc >= 0 && cc < S) {
            shadowOut[cr * S + cc] = 255;
          }
        } else {
          shadowElev[idx] = elev;
        }
      }
    }
  }

  return shadowOut;
}

// ── 3×3 box blur for soft shadow edges (penumbra) ─────────────────────
// Converts binary 0/255 shadow into a smooth gradient at edges.
// Single pass, O(N). Output values in [0, 255].
function blurShadow(shadow) {
  const S = DEM_TILE_SIZE;
  const out = new Uint8Array(S * S);

  for (let r = 0; r < S; r++) {
    for (let c = 0; c < S; c++) {
      let sum = 0;
      let cnt = 0;
      const rMin = r > 0 ? r - 1 : 0;
      const rMax = r < S - 1 ? r + 1 : S - 1;
      const cMin = c > 0 ? c - 1 : 0;
      const cMax = c < S - 1 ? c + 1 : S - 1;
      for (let rr = rMin; rr <= rMax; rr++) {
        for (let cc = cMin; cc <= cMax; cc++) {
          sum += shadow[rr * S + cc];
          cnt++;
        }
      }
      out[r * S + c] = (sum / cnt + 0.5) | 0;
    }
  }
  return out;
}

// ── Encode shadow buffer as RGBA PNG ──────────────────────────────────
async function encodeShadowPng(shadow, centerElev) {
  const size = DEM_TILE_SIZE;
  const n = size * size;
  const rgba = new Uint8Array(n * 4);

  for (let j = 0; j < n; j++) {
    const idx = j * 4;
    const elev = centerElev[j];
    if (elev <= DEM_NODATA_THRESHOLD) {
      // Transparent on NoData
      rgba[idx + 3] = 0;
      continue;
    }
    rgba[idx]     = shadow[j]; // R = shadow factor
    rgba[idx + 1] = 0;
    rgba[idx + 2] = 0;
    rgba[idx + 3] = 255;
  }

  return buildRawPng(size, size, rgba);
}

// ── Full pipeline: DEM blob → shadow PNG blob ─────────────────────────
async function buildShadowTile(demBlob, z, x, y, sunAzDeg, sunAltDeg, demCache) {
  const t0 = performance.now();
  const centerElev = await decodeTerrainRGBBlob(demBlob);
  const t1 = performance.now();
  const pad = await buildShadowPaddedElevations(centerElev, z, x, y, demCache);
  const t2 = performance.now();
  let shadow = computeSweepShadow(pad, z, x, y, sunAzDeg, sunAltDeg);
  const t3 = performance.now();
  shadow = blurShadow(shadow);
  const t3b = performance.now();
  const blob = await encodeShadowPng(shadow, centerElev);
  const t4 = performance.now();

  if (DEBUG) {
    console.log(
      `[shadow] ${z}/${x}/${y} az=${sunAzDeg.toFixed(1)} alt=${sunAltDeg.toFixed(1)} ` +
      `dec=${(t1 - t0).toFixed(0)} pad=${(t2 - t1).toFixed(0)} sweep=${(t3 - t2).toFixed(0)} ` +
      `blur=${(t3b - t3).toFixed(0)} enc=${(t4 - t3b).toFixed(0)} total=${(t4 - t0).toFixed(0)}ms`
    );
  }
  return blob;
}
