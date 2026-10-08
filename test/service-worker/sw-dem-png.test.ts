import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { describe, it, expect } from 'vitest';

// Les tuiles DEM sont encodées dans le navigateur par les scripts classiques
// du Service Worker (public/sw-dem/core/terrain-rgb.js), chargés ici dans un
// contexte vm comme le SW les importScripts(). Le PNG est décodé
// indépendamment (inflate + défiltrage PNG) pour vérifier ce que lit
// n'importe quel décodeur (Mapbox, createImageBitmap).
type SwDem = {
  encodeTerrainRGBPng: (elevations: Float32Array) => Promise<Blob>;
  decodedTerrainRgbGet: (blob: Blob) => Float32Array | undefined;
};

function loadSwDem(): SwDem {
  const context = vm.createContext({ Blob, CompressionStream, Response, Math, Float32Array, Uint8Array, DataView, Map });
  for (const file of ['core/config.js', 'core/interpolation.js', 'core/terrain-rgb.js']) {
    const full = path.resolve(import.meta.dirname, '../../public/sw-dem', file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  }
  return context as unknown as SwDem;
}

const sw = loadSwDem();
const SIZE = 256;

/** Surface de type alpin : deux crêtes, une falaise, le niveau de la mer et une fosse sous le zéro. */
function surface(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let h = 1800 + 900 * Math.sin(x / 41) * Math.cos(y / 33) + 150 * Math.sin((x + 2 * y) / 7) + 0.37 * x;
      if (x > 200) h += 400; // cliff
      if (y < 8) h = 0; // sea
      if (x < 4 && y > 240) h = -12.3; // sous le zéro
      out[y * SIZE + x] = h;
    }
  }
  return out;
}

/** Pixels d'un PNG 8 bits non entrelacé (tout filtre), à `channels` octets par pixel. */
function decodePng(png: Uint8Array): { colorType: number; channels: number; pixels: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let pos = 8;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  while (pos < png.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    if (type === 'IHDR') colorType = png[pos + 8 + 9];
    if (type === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    expect(view.getUint32(pos + 8 + len)).toBe(zlib.crc32(png.subarray(pos + 4, pos + 8 + len)));
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = SIZE * channels;
  const pixels = new Uint8Array(SIZE * stride);
  for (let y = 0; y < SIZE; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? pixels[(y - 1) * stride + i - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + predictor) & 0xff;
    }
  }
  return { colorType, channels, pixels };
}

describe('SW Terrain-RGB DEM tile', () => {
  it('decodes to the Terrain-RGB value of every elevation (RGB, Up filter)', async () => {
    const elevations = surface();
    const blob = await sw.encodeTerrainRGBPng(elevations);
    const { colorType, channels, pixels } = decodePng(new Uint8Array(await blob.arrayBuffer()));
    expect(colorType).toBe(2);
    let mismatches = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      const expected = Math.max(0, Math.min(16777215, Math.round((Math.max(elevations[i], -10000) + 10000) * 10)));
      const value = pixels[i * channels] * 65536 + pixels[i * channels + 1] * 256 + pixels[i * channels + 2];
      if (value !== expected) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });

  it('seeds the decode cache with exactly what a decoder reads back', async () => {
    const blob = await sw.encodeTerrainRGBPng(surface());
    const seeded = sw.decodedTerrainRgbGet(blob)!;
    const { channels, pixels } = decodePng(new Uint8Array(await blob.arrayBuffer()));
    for (let i = 0; i < SIZE * SIZE; i += 97) {
      const value = pixels[i * channels] * 65536 + pixels[i * channels + 1] * 256 + pixels[i * channels + 2];
      expect(seeded[i]).toBe(Math.fround(-10000 + value * 0.1));
    }
  });

  it('is smaller than the former RGBA unfiltered tile (zlib level 6)', async () => {
    const elevations = surface();
    const blob = await sw.encodeTerrainRGBPng(elevations);
    const rgba = new Uint8Array(SIZE * (1 + SIZE * 4));
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const val = Math.max(0, Math.min(16777215, Math.round((Math.max(elevations[y * SIZE + x], -10000) + 10000) * 10)));
        const o = y * (1 + SIZE * 4) + 1 + x * 4;
        rgba.set([(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff, 255], o);
      }
    }
    // 0,76 × ici (relief à forte fréquence) ; 0,69 à 0,81 × sur de vraies tuiles (Chromium).
    expect(blob.size).toBeLessThan(zlib.deflateSync(rgba).length * 0.85);
  });
});
