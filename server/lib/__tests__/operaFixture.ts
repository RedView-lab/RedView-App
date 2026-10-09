import { deflateSync, inflateSync } from 'node:zlib';

import { projectToOpera } from '../opera-radar.mjs';

/**
 * Composite OPERA synthétique : un vrai GeoTIFF tuilé (TIFF classique,
 * 2 × 2 tuiles de 512 px, 1 km, float32 DBZH + qualité, DEFLATE) calé sur la
 * France. Tuile 0 (nord-ouest) : 40 dBZ ; 1 : rien détecté (NaN) ; 2 : hors
 * couverture (−9 999 000) ; 3 : 20 dBZ.
 */
export const FIXTURE_TILE_DBZ = [40, Number.NaN, -9_999_000, 20];
const SIZE = 1024;
const TILE = 512;
const PIXEL = 1000;
/** Centre de la grille : 2,5° E, 46,5° N. */
export const FIXTURE_CENTER = { lon: 2.5, lat: 46.5 };

export function buildFixtureCog(): Buffer {
  const [centerE, centerN] = projectToOpera(FIXTURE_CENTER.lon, FIXTURE_CENTER.lat);
  const originX = centerE - (SIZE / 2) * PIXEL;
  const originY = centerN + (SIZE / 2) * PIXEL;

  const tiles = FIXTURE_TILE_DBZ.map((dbz) => {
    const raw = Buffer.alloc(TILE * TILE * 2 * 4);
    for (let i = 0; i < TILE * TILE; i++) {
      raw.writeFloatLE(dbz, i * 8);
      raw.writeFloatLE(1, i * 8 + 4);
    }
    return deflateSync(raw);
  });

  type Entry = { tag: number; type: number; values: number[] };
  const entries: Entry[] = [
    { tag: 256, type: 4, values: [SIZE] },
    { tag: 257, type: 4, values: [SIZE] },
    { tag: 258, type: 3, values: [32, 32] },
    { tag: 259, type: 3, values: [8] },
    { tag: 262, type: 3, values: [1] },
    { tag: 277, type: 3, values: [2] },
    { tag: 284, type: 3, values: [1] },
    { tag: 322, type: 3, values: [TILE] },
    { tag: 323, type: 3, values: [TILE] },
    { tag: 324, type: 4, values: [0, 0, 0, 0] },
    { tag: 325, type: 4, values: tiles.map((tile) => tile.length) },
    { tag: 339, type: 3, values: [3, 3] },
    { tag: 33550, type: 12, values: [PIXEL, PIXEL, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, originX, originY, 0] },
  ];
  const typeSize = (type: number) => (type === 3 ? 2 : type === 4 ? 4 : 8);
  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = ifdOffset + ifdSize;
  const external = new Map<number, number>();
  for (const entry of entries) {
    const size = typeSize(entry.type) * entry.values.length;
    if (size > 4) {
      external.set(entry.tag, extra);
      extra += size;
    }
  }
  let dataOffset = extra;
  const offsets = tiles.map((tile) => {
    const at = dataOffset;
    dataOffset += tile.length;
    return at;
  });
  entries.find((entry) => entry.tag === 324)!.values = offsets;

  const buf = Buffer.alloc(dataOffset);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffset, 4);
  buf.writeUInt16LE(entries.length, ifdOffset);
  const write = (type: number, value: number, at: number) => {
    if (type === 3) buf.writeUInt16LE(value, at);
    else if (type === 4) buf.writeUInt32LE(value, at);
    else buf.writeDoubleLE(value, at);
  };
  entries.forEach((entry, i) => {
    const e = ifdOffset + 2 + i * 12;
    buf.writeUInt16LE(entry.tag, e);
    buf.writeUInt16LE(entry.type, e + 2);
    buf.writeUInt32LE(entry.values.length, e + 4);
    const at = external.get(entry.tag);
    if (at === undefined) entry.values.forEach((value, k) => write(entry.type, value, e + 8 + k * typeSize(entry.type)));
    else {
      buf.writeUInt32LE(at, e + 8);
      entry.values.forEach((value, k) => write(entry.type, value, at + k * typeSize(entry.type)));
    }
  });
  buf.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12);
  tiles.forEach((tile, i) => tile.copy(buf, offsets[i]));
  return buf;
}

/** Liste S3 (ListObjectsV2) des images `frames` (AAAAMMJJTHHMM), avec les autres produits d'OPERA mêlés. */
export function fixtureListing(frames: string[]): string {
  const keys = frames.flatMap((frame) => {
    const day = `${frame.slice(0, 4)}/${frame.slice(4, 6)}/${frame.slice(6, 8)}`;
    return [`${day}/OPERA/COMP/OPERA@${frame}@0@DBZH.h5`, `${day}/OPERA/COMP/OPERA@${frame}@0@DBZH.tiff`, `${day}/OPERA/COMP/OPERA@${frame}@0@RATE.tiff`];
  });
  return `<?xml version="1.0"?><ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join('')}</ListBucketResult>`;
}

/** Faux bucket OPERA : listes et lectures par plages (`Range`) du COG synthétique pour toute image. */
export function fixtureFetch(cog: Buffer, frames: string[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('list-type=2')) return new Response(fixtureListing(frames), { status: 200 });
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '');
    if (!url.endsWith('@0@DBZH.tiff') || !range) return new Response('not found', { status: 404 });
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), cog.length - 1);
    return new Response(new Uint8Array(cog.subarray(start, end + 1)), { status: 206 });
  };
}

/** Pixels RGBA d'un PNG 8 bits RGBA sans filtre (celui que produit opera-radar.mjs). */
export function decodeRgbaPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) raw.copy(pixels, row * width * 4, row * (width * 4 + 1) + 1, (row + 1) * (width * 4 + 1));
  return { width, height, pixels };
}
