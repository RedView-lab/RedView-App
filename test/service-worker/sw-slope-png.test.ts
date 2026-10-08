import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';

// Les tuiles de la surcouche de pente sont encodées dans le navigateur par
// les scripts classiques du Service Worker (public/sw-dem/core/terrain-rgb.js),
// chargés ici dans un contexte vm comme le SW et son pool de workers de pente
// les importScripts(). Le test vit avec ceux du serveur pour les types de Node
// (zlib, Buffer).
type SwPng = {
  zlibDeflateRle: (data: Uint8Array) => Uint8Array;
  buildGrayPng: (width: number, height: number, gray: Uint8Array) => Promise<Blob>;
};

function loadSwPng(): SwPng {
  const context = vm.createContext({ Blob, CompressionStream, Response });
  for (const file of ['core/config.js', 'core/terrain-rgb.js']) {
    const full = path.resolve(import.meta.dirname, '../../public/sw-dem', file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  }
  return context as unknown as SwPng;
}

const sw = loadSwPng();

function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** Champ gris lisse façon pente (octets en gamma racine) avec un peu de texture. */
function slopeField(size: number): Uint8Array {
  const rnd = seeded(3);
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 120 + 60 * Math.sin(x / 37) * Math.cos(y / 29) + 20 * Math.sin((x + y) / 9) + 3 * rnd();
      out[y * size + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Lignes PNG de `gray`, filtrées en Paeth comme buildGrayPng. */
function paeth(gray: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    out[y * (width + 1)] = 4;
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? gray[y * width + x - 1] : 0;
      const b = y > 0 ? gray[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? gray[(y - 1) * width + x - 1] : 0;
      out[y * (width + 1) + 1 + x] = (gray[y * width + x] - paethPredictor(a, b, c)) & 0xff;
    }
  }
  return out;
}

function unpaeth(scanlines: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(scanlines[y * (width + 1)]).toBe(4);
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? out[y * width + x - 1] : 0;
      const b = y > 0 ? out[(y - 1) * width + x] : 0;
      const c = x > 0 && y > 0 ? out[(y - 1) * width + x - 1] : 0;
      out[y * width + x] = (scanlines[y * (width + 1) + 1 + x] + paethPredictor(a, b, c)) & 0xff;
    }
  }
  return out;
}

describe('zlibDeflateRle (slope tile PNG stream)', () => {
  it('inflates back to the exact input, edge cases included', () => {
    const rnd = seeded(11);
    const runs: number[] = [];
    for (let r = 1; r < 600; r++) for (let k = 0; k < r; k++) runs.push(r & 0xff);
    const cases = [
      new Uint8Array(0),
      Uint8Array.of(42),
      Uint8Array.of(5, 5, 5, 5),
      new Uint8Array(1 << 20), // une seule valeur d'octet : des correspondances qui couvrent beaucoup de blocs
      Uint8Array.from(runs), // chaque longueur de répétition, de part et d'autre du plafond de 258
      Uint8Array.from({ length: 100_000 }, () => (rnd() * 256) | 0),
    ];
    for (let t = 0; t < 40; t++) {
      const n = (rnd() * 70_000) | 0;
      const alphabet = 1 + ((rnd() * 255) | 0);
      const repeat = rnd();
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = i > 0 && rnd() < repeat ? data[i - 1] : (rnd() * alphabet) | 0;
      cases.push(data);
    }
    for (const data of cases) {
      expect(Buffer.from(zlib.inflateSync(sw.zlibDeflateRle(data))).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('compresses a slope field like zlib Z_RLE, close to level 6', () => {
    const scanlines = paeth(slopeField(512), 512, 512);
    const ours = sw.zlibDeflateRle(scanlines).length;
    const rle = zlib.deflateSync(scanlines, { strategy: zlib.constants.Z_RLE }).length;
    const level6 = zlib.deflateSync(scanlines).length;
    expect(ours).toBeLessThanOrEqual(rle * 1.02);
    expect(ours).toBeLessThanOrEqual(level6 * 1.15);
  });
});

describe('buildGrayPng', () => {
  it('writes a gray PNG whose pixels decode to the slope bytes', async () => {
    const gray = slopeField(512);
    const png = new Uint8Array(await (await sw.buildGrayPng(512, 512, gray)).arrayBuffer());
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    let pos = 8;
    const idat: Buffer[] = [];
    const chunks: string[] = [];
    while (pos < png.length) {
      const len = view.getUint32(pos);
      const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
      chunks.push(type);
      if (type === 'IHDR') {
        expect(view.getUint32(pos + 8)).toBe(512);
        expect(png[pos + 8 + 9]).toBe(0); // type de couleur : gris
      }
      if (type === 'IDAT') idat.push(Buffer.from(png.subarray(pos + 8, pos + 8 + len)));
      expect(view.getUint32(pos + 8 + len)).toBe(zlib.crc32(png.subarray(pos + 4, pos + 8 + len)));
      pos += 12 + len;
    }
    expect(chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    const decoded = unpaeth(zlib.inflateSync(Buffer.concat(idat)), 512, 512);
    expect(Buffer.from(decoded).equals(Buffer.from(gray))).toBe(true);
  });
});
