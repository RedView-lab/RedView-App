/** Mean albedo (linear) of the terrain colours, sampled: the photo mode's distant ground and bounce light. */
export function meanTerrainAlbedo(colors: Uint8Array): number {
  let sum = 0;
  let count = 0;
  const step = Math.max(4, Math.floor(colors.length / 4 / 4096) * 4);
  for (let i = 0; i + 2 < colors.length; i += step) {
    const l = (0.2126 * colors[i]! + 0.7152 * colors[i + 1]! + 0.0722 * colors[i + 2]!) / 255;
    sum += l <= 0.04045 ? l / 12.92 : Math.pow((l + 0.055) / 1.055, 2.4);
    count++;
  }
  return count > 0 ? Math.max(0.05, Math.min(0.5, (sum / count) * 0.9)) : 0.18;
}
