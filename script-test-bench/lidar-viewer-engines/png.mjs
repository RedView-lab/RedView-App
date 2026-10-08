/**
 * Lecteur PNG minimal (RGB / RGBA 8 bits, non entrelacé : captures d'écran de
 * navigateur) et mesures d'image du test des moteurs.
 */
import { inflateSync } from 'node:zlib';

/** @returns {{ width: number, height: number, rgb: Uint8Array }} */
export function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG non pris en charge (profondeur ou entrelacement)');
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG de type ${colorType} non pris en charge`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rgb = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      rgb.set(cur.subarray(x * bpp, x * bpp + 3), (y * width + x) * 3);
    }
    prev.set(cur);
  }
  return { width, height, rgb };
}

/** Part des pixels plus loin que `tolerance` de `colour` (ce que la scène couvre sur le ciel). */
export function coverage(image, colour, tolerance = 12) {
  let covered = 0;
  const n = image.width * image.height;
  for (let i = 0; i < n; i++) {
    const d = Math.max(
      Math.abs(image.rgb[i * 3] - colour[0]),
      Math.abs(image.rgb[i * 3 + 1] - colour[1]),
      Math.abs(image.rgb[i * 3 + 2] - colour[2]),
    );
    if (d > tolerance) covered++;
  }
  return covered / n;
}

/** Différence absolue moyenne par canal de deux images de même taille (0–255). */
export function meanDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 255;
  let sum = 0;
  for (let i = 0; i < a.rgb.length; i++) sum += Math.abs(a.rgb[i] - b.rgb[i]);
  return sum / a.rgb.length;
}
