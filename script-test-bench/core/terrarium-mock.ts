/**
 * Tuiles Terrarium simulées pour mesurer les routes de secours du serveur
 * (/slope-tiles, /altitude-tiles : server/terrain-tiles.mjs) sans réseau.
 *
 * Ces routes gardent chaque tuile produite (et chaque Terrarium décodé) dans
 * un cache LRU : mesurer deux fois la même tuile ne mesure que le cache. Les
 * benchs demandent donc une tuile différente à chaque itération, servie par
 * ce `fetch` simulé (même PNG, autres coordonnées).
 */
import { crc32, deflateSync } from 'node:zlib';

/** PNG Terrarium RGB 256² (H = R·256 + G + B/256 − 32768) de `elevations`. */
export function encodeTerrariumPng(elevations: Float32Array, size = 256): Buffer {
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = elevations[y * size + x] + 32768;
      const o = y * rowBytes + 1 + x * 3;
      raw[o] = Math.floor(v / 256);
      raw[o + 1] = Math.floor(v) % 256;
      raw[o + 2] = Math.floor((v % 1) * 256);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Exécute `run` avec un `fetch` global qui répond `png` à toute requête. */
export async function withTerrariumFetch<T>(png: Buffer, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(png), { status: 200 })) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}
