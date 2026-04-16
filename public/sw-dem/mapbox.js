// ---------------------------------------------------------------------------
// Mapbox DEM tile fetching (passthrough for non-France areas)
// ---------------------------------------------------------------------------

async function fetchMapboxTile(z, x, y) {
  if (!mapboxToken) return null;
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-terrain-dem-v1/${z}/${x}/${y}@2x.pngraw?access_token=${mapboxToken}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    const img = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    if (img.width === DEM_TILE_SIZE && img.height === DEM_TILE_SIZE) {
      img.close();
      return blob;
    }
    // Resample to DEM_TILE_SIZE × DEM_TILE_SIZE using raw PNG encoder
    // to avoid sRGB gamma corruption of terrain-RGB elevation data.
    const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
    ctx.drawImage(img, 0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
    img.close();
    const imageData = ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
    return buildRawPng(DEM_TILE_SIZE, DEM_TILE_SIZE, imageData.data);
  } catch {
    return null;
  }
}
