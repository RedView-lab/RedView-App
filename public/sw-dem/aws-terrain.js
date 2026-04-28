// ---------------------------------------------------------------------------
// AWS Open Data — Terrarium DEM tile fetcher (drop-in for fetchMapboxTile)
//
// Endpoint: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//
// Why: Mapbox raster-DEM tiles (`mapbox.mapbox-terrain-dem-v1`) are billed
// against the Raster Tiles API SKU. The AWS Open Data Terrain Tiles dataset
// (legacy Mapzen, hosted free by AWS) covers the entire globe at ~30 m
// resolution and is free / unlimited. We swap it in everywhere the SW used
// to call Mapbox for global DEM, drastically cutting the Raster Tiles bill
// without any visible quality regression at the zoom levels concerned
// (z ≤ 14 globally, z ≤ ~11 over France/Switzerland where IGN/swissALTI
// take over for the high-resolution path).
//
// Encoding conversion:
//   Terrarium  : height = (R*256 + G + B/256) − 32768
//   Terrain-RGB: height = -10000 + (R*65536 + G*256 + B) * 0.1
// We decode terrarium → Float32 → re-encode as Terrain-RGB so the rest of
// the SW pipeline (composite, slope, altitude, overzoom) stays unchanged.
// ---------------------------------------------------------------------------

// Native max zoom of AWS Terrarium tiles. Beyond this, requests 404.
// Matches Mapbox terrain-DEM v1 (z14 native), so the existing clamp logic
// in callers keeps working unchanged.
const AWS_TERRAIN_MAXZOOM = 14;

// Public, unauthenticated endpoint. No CORS issues — bucket has
// Access-Control-Allow-Origin: * configured.
const AWS_TERRAIN_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

async function fetchAWSTerrainTile(z, x, y) {
  // Clamp to native max zoom — above z14 AWS returns 404. Mapbox GL's GPU
  // handles overzooming from the parent tile.
  const fetchZ = Math.min(z, AWS_TERRAIN_MAXZOOM);
  const fetchX = fetchZ < z ? x >> (z - fetchZ) : x;
  const fetchY = fetchZ < z ? y >> (z - fetchZ) : y;
  const clamped = fetchZ < z;

  const url = `${AWS_TERRAIN_BASE}/${fetchZ}/${fetchX}/${fetchY}.png`;
  try {
    const t0 = performance.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const dt = (performance.now() - t0).toFixed(0);

    if (!res.ok) {
      // 404 over oceans/poles is normal — Terrarium has no data there.
      // Treat exactly like Mapbox's missing-tile path: return null and let
      // the caller produce a 204 with appropriate TTL.
      if (DEBUG) {
        console.warn(
          `[sw-dem][aws] %c FAIL %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ}/${fetchX}/${fetchY})` : ''} — HTTP ${res.status}, ${dt}ms`,
          'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '',
        );
      }
      return null;
    }

    const blob = await res.blob();
    const img = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });

    let elevations;
    try {
      // Decode terrarium pixels → Float32 elevations
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, img.width, img.height).data;

      const srcSize = img.width;
      // Always resample to DEM_TILE_SIZE so the SW pipeline sees a consistent
      // grid. Terrarium native tiles are 256×256 — same as DEM_TILE_SIZE — so
      // the `else` fast-path normally fires.
      if (srcSize === DEM_TILE_SIZE && img.height === DEM_TILE_SIZE) {
        elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
        for (let i = 0; i < elevations.length; i++) {
          const idx = i * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];
          // Terrarium decode: height = (R*256 + G + B/256) - 32768
          elevations[i] = (r * 256 + g + b / 256) - 32768;
        }
      } else {
        // Defensive: nearest-neighbour resample (rare path).
        elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
        const scale = srcSize / DEM_TILE_SIZE;
        for (let py = 0; py < DEM_TILE_SIZE; py++) {
          const sy = Math.min((py * scale) | 0, srcSize - 1);
          for (let px = 0; px < DEM_TILE_SIZE; px++) {
            const sx = Math.min((px * scale) | 0, srcSize - 1);
            const idx = (sy * srcSize + sx) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            elevations[py * DEM_TILE_SIZE + px] = (r * 256 + g + b / 256) - 32768;
          }
        }
      }
    } finally {
      img.close();
    }

    if (DEBUG) {
      console.log(
        `[sw-dem][aws] %c OK %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ})` : ''} ${dt}ms`,
        'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', '',
      );
    }

    // If we clamped, extract & upsample the requested sub-tile from the
    // parent. We re-encode to Terrain-RGB first then run overzoomDemTile
    // so it can reuse the same decode path as cached tiles.
    const terrainRGBBlob = await encodeTerrainRGBPng(elevations);
    if (clamped) {
      const overzoomed = await overzoomDemTile(
        terrainRGBBlob, fetchZ, fetchX, fetchY, z, x, y,
      );
      return overzoomed || terrainRGBBlob;
    }
    return terrainRGBBlob;
  } catch (err) {
    if (DEBUG) {
      console.warn(
        `[sw-dem][aws] %c ERROR %c ${z}/${x}/${y} — ${err.message || err}`,
        'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '',
      );
    }
    return null;
  }
}
