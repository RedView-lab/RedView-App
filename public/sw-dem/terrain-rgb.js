// ---------------------------------------------------------------------------
// Terrain-RGB PNG encoding & decoding via OffscreenCanvas
// ---------------------------------------------------------------------------

async function encodeTerrainRGBPng(elevations) {
  const size = DEM_TILE_SIZE;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(size, size);
  const pixels = imageData.data;

  for (let i = 0; i < elevations.length; i++) {
    const height = sanitizeElevation(elevations[i]);
    const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) / 0.1)));
    const idx = i * 4;
    pixels[idx] = (val >> 16) & 0xff;
    pixels[idx + 1] = (val >> 8) & 0xff;
    pixels[idx + 2] = val & 0xff;
    pixels[idx + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function decodeTerrainRGBBlob(blob) {
  const img = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  const pixels = imageData.data;
  const elevations = new Float32Array(img.width * img.height);

  for (let i = 0; i < elevations.length; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    elevations[i] = -10000 + (r * 65536 + g * 256 + b) * 0.1;
  }
  return elevations;
}
