// ---------------------------------------------------------------------------
// Mapbox DEM tile fetching (passthrough for non-France areas)
// ---------------------------------------------------------------------------

// Mapbox Terrain DEM v1 native max zoom — beyond this, Mapbox returns
// overzoomed (interpolated) tiles that are progressively flatter.
const MAPBOX_DEM_MAXZOOM = 14;

async function fetchMapboxTile(z, x, y) {
  if (!mapboxToken) return null;

  // Clamp to Mapbox native maxzoom — requesting z15+ returns
  // server-side overzoomed tiles with less elevation detail.
  // Better to let Mapbox GL's GPU handle overzooming from z14 tiles.
  const fetchZ = Math.min(z, MAPBOX_DEM_MAXZOOM);
  const fetchX = fetchZ < z ? x >> (z - fetchZ) : x;
  const fetchY = fetchZ < z ? y >> (z - fetchZ) : y;
  const clamped = fetchZ < z;

  // NOTE: request NATIVE 256×256 (no @2x). The @2x.pngraw response is 512×512
  // and forced us through a canvas downsample path (ctx.drawImage → 256) which
  // bilinear-filters the R,G,B channels of terrain-RGB *independently*. That is
  // mathematically invalid for packed-int elevation — at every channel-carry
  // boundary it produces single-pixel km-high spikes that later contaminate
  // compositeIGNMapbox / the Mapbox prefill path in buildIGNTile, visible as
  // vertical needles on the mesh. Native 256 matches DEM_TILE_SIZE so the
  // fast-path `return blob` below is reachable and no canvas touch happens.
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${fetchZ}/${fetchX}/${fetchY}.pngraw?access_token=${mapboxToken}`;
  try {
    const t0 = performance.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const dt = (performance.now() - t0).toFixed(0);

    if (!res.ok) {
      console.warn(
        `[sw-dem][mapbox] %c FAIL %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ}/${fetchX}/${fetchY})` : ''} — HTTP ${res.status}, ${dt}ms`,
        'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', ''
      );
      return null;
    }

    const blob = await res.blob();
    const img = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });

    try {
      console.log(
        `[sw-dem][mapbox] %c OK %c ${z}/${x}/${y}${clamped ? ` (clamped→${fetchZ})` : ''} ${img.width}x${img.height} blob=${blob.size}B, ${dt}ms`,
        'background:#4CAF50;color:#fff;padding:2px 4px;border-radius:2px', ''
      );

      // If we clamped zoom, extract the sub-tile via overzoom
      if (clamped) {
        const result = await overzoomDemTile(blob, fetchZ, fetchX, fetchY, z, x, y);
        if (result) {
          console.log(
            `[sw-dem][mapbox] %c OVERZOOM %c ${fetchZ}/${fetchX}/${fetchY}→${z}/${x}/${y} (mapbox clamped overzoom)`,
            'background:#FF9800;color:#fff;padding:2px 4px;border-radius:2px', ''
          );
        }
        return result;
      }

      if (img.width === DEM_TILE_SIZE && img.height === DEM_TILE_SIZE) {
        return blob;
      }
      // Unexpected size (shouldn't happen without @2x). We avoid resampling
      // RGB terrain-RGB bytes through a canvas (that's the spike bug) — decode
      // to Float32, resample in elevation space via nearest-neighbor, re-encode.
      console.warn(
        `[sw-dem][mapbox] unexpected size ${img.width}×${img.height} for ${z}/${x}/${y} — float-resampling`,
      );
      const srcElev = await decodeTerrainRGBBlob(blob);
      const srcSize = img.width;
      const out = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
      const scale = srcSize / DEM_TILE_SIZE;
      for (let py = 0; py < DEM_TILE_SIZE; py++) {
        const sy = Math.min((py * scale) | 0, srcSize - 1);
        for (let px = 0; px < DEM_TILE_SIZE; px++) {
          const sx = Math.min((px * scale) | 0, srcSize - 1);
          out[py * DEM_TILE_SIZE + px] = srcElev[sy * srcSize + sx];
        }
      }
      return encodeTerrainRGBPng(out);
    } finally {
      img.close();
    }
  } catch (err) {
    console.warn(`[sw-dem][mapbox] %c ERROR %c ${z}/${x}/${y} — ${err.message || err}`, 'background:#f44336;color:#fff;padding:2px 4px;border-radius:2px', '');
    return null;
  }
}
