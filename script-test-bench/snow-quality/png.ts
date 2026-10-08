// Rédacteur PNG minimal + rendu de carte (ombrage, palette de hauteur de neige) pour les images du banc.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Image RGB (ligne 0 = haut) → octets PNG. */
export function encodePng(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Ombrage (0–1) d'une grille de nœuds, ligne 0 = sud, soleil du NO à 45°. */
export function hillshade(z: Float32Array, w: number, h: number, cell: number): Float32Array {
  const out = new Float32Array(w * h);
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const lx = Math.sin(az) * Math.cos(alt);
  const ly = Math.cos(az) * Math.cos(alt);
  const lz = Math.sin(alt);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const zx = (z[y * w + Math.min(w - 1, x + 1)] - z[y * w + Math.max(0, x - 1)]) / (2 * cell);
      const zy = (z[Math.min(h - 1, y + 1) * w + x] - z[Math.max(0, y - 1) * w + x]) / (2 * cell);
      const nx = -zx, ny = -zy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      out[y * w + x] = Math.max(0, (nx * lx + ny * ly + nz * lz) / len);
    }
  }
  return out;
}

// Palette de hauteur de neige : sol nu, mince (gris lavande) → épaisse (bleu profond), dans un ordre perceptif.
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [236, 240, 245]],
  [25, [203, 220, 240]],
  [60, [150, 190, 230]],
  [100, [96, 152, 214]],
  [160, [52, 108, 188]],
  [240, [36, 66, 150]],
  [350, [44, 28, 104]],
  [500, [20, 10, 50]],
];

export function depthColor(cm: number): [number, number, number] {
  if (cm <= STOPS[0][0]) return STOPS[0][1];
  for (let k = 1; k < STOPS.length; k++) {
    if (cm <= STOPS[k][0]) {
      const [c0, a] = STOPS[k - 1];
      const [c1, b] = STOPS[k];
      const t = (cm - c0) / (c1 - c0);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/** Palette divergente pour les erreurs (cm) : bleu = modèle trop épais, rouge = trop mince. */
export function errorColor(cm: number, range = 150): [number, number, number] {
  const t = Math.max(-1, Math.min(1, cm / range));
  if (t >= 0) return [247 - 200 * t, 247 - 150 * t, 247 - 40 * t];
  const u = -t;
  return [247 - 40 * u, 247 - 170 * u, 247 - 190 * u];
}

/**
 * Rend une carte de hauteurs sur son ombrage. Le sol nu (< 1 cm) montre le
 * terrain en gris chaud ; la neige est dessinée avec la palette, ombrée par le
 * relief.
 */
export function renderDepth(hs: Float32Array, shade: Float32Array, w: number, h: number, mode: 'depth' | 'error' = 'depth', errorRange = 150): Uint8Array {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w; // ligne 0 = sud → haut de l'image = nord
    for (let x = 0; x < w; x++) {
      const v = hs[src + x];
      const s = 0.55 + 0.6 * shade[src + x];
      let c: [number, number, number];
      if (mode === 'error') c = errorColor(v, errorRange);
      else if (v < 1) c = [150, 136, 120];
      else c = depthColor(v);
      const o = (y * w + x) * 3;
      rgb[o] = Math.max(0, Math.min(255, c[0] * s));
      rgb[o + 1] = Math.max(0, Math.min(255, c[1] * s));
      rgb[o + 2] = Math.max(0, Math.min(255, c[2] * s));
    }
  }
  return rgb;
}
