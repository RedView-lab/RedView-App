// ---------------------------------------------------------------------------
// Radar de précipitations européen : composites OPERA d'EUMETNET (plus de
// 150 radars de 30 pays, grille de 1 km, une image toutes les 5 minutes),
// diffusés sous CC BY 4.0 — usage commercial permis avec attribution
// (« © EUMETNET OPERA »). Remplace RainViewer, dont l'API gratuite est
// réservée à un usage personnel ou éducatif.
//
// Source : le bucket S3 public d'Open Radar Data (CloudFerro, 24 h glissantes,
// lecture anonyme ; https://eumetnet.github.io/openradardata-documentation/).
// Chaque image est un GeoTIFF optimisé pour le cloud (COG) : réflectivité
// maximale DBZH en float32 (+ indice de qualité), tuiles de 512 px compressées
// DEFLATE, aperçus à 2, 4, 8, 16 km. Projection azimutale équivalente de
// Lambert (55° N, 10° E, ellipsoïde WGS84).
//
// Le serveur ne lit que les plages d'octets des tuiles du COG dont une tuile
// de carte a besoin, les reprojette vers la tuile Web Mercator (512 px,
// comme la source radar de la carte), convertit la réflectivité en intensité
// de pluie (Marshall-Palmer, Z = 200 R^1,6) et la colore avec la palette de
// l'utilisateur (radar-recolor.mjs, même échelle 0–20 mm/h qu'avant). Tout
// est mis en cache, borné en octets : en-têtes et tuiles décodées par image,
// correspondances de pixels par tuile de carte (identiques d'une image à
// l'autre), PNG finaux.
// ---------------------------------------------------------------------------
import { deflateSync, inflateSync, crc32 } from 'node:zlib';

import { createByteLru } from './byte-lru.mjs';
import { radarPaletteIndex, radarPaletteLookup } from './radar-recolor.mjs';

const BUCKET_URL = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
const FETCH_TIMEOUT_MS = 10_000;
/** Images proposées au client : la dernière heure (le client n'affiche que la plus récente). */
const FRAME_COUNT = 12;
const FRAME_LIST_TTL_MS = 60_000;
const TILE_SIZE = 512;
/** Plus faible réflectivité affichée : en dessous, bruit et bruine négligeable (≈ 0,1 mm/h). */
const MIN_DBZ = 7;
const HEADER_FETCH_BYTES = 64 * 1024;

/** Hôte « logique » des images OPERA dans `radar.json` et `/radar-tiles?host=…`. */
export const OPERA_RADAR_HOST = 'opera';
/** Chemin d'image accepté : `/opera/AAAAMMJJTHHMM` (rien d'autre n'atteint le bucket). */
const FRAME_PATH_RE = /^\/?opera\/(\d{8}T\d{4})$/;

// ── Projection : azimutale équivalente de Lambert, ellipsoïde (EPSG 9820) ──

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const LAT0 = (55 * Math.PI) / 180;
const LON0 = (10 * Math.PI) / 180;
const FALSE_EASTING = 1_950_000;
const FALSE_NORTHING = -2_100_000;

function authalicQ(sinPhi) {
  return (1 - E2) * (sinPhi / (1 - E2 * sinPhi * sinPhi) - (1 / (2 * E)) * Math.log((1 - E * sinPhi) / (1 + E * sinPhi)));
}

const Q_POLE = authalicQ(1);
const R_Q = A * Math.sqrt(Q_POLE / 2);
const BETA0 = Math.asin(authalicQ(Math.sin(LAT0)) / Q_POLE);
const SIN_BETA0 = Math.sin(BETA0);
const COS_BETA0 = Math.cos(BETA0);
const D = (A * Math.cos(LAT0)) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2) / (R_Q * COS_BETA0);

/**
 * Coordonnées projetées OPERA (m) d'un point lon/lat (degrés).
 * @returns {[number, number]}
 */
export function projectToOpera(lonDeg, latDeg) {
  const lon = (lonDeg * Math.PI) / 180;
  const beta = Math.asin(authalicQ(Math.sin((latDeg * Math.PI) / 180)) / Q_POLE);
  const sinBeta = Math.sin(beta);
  const cosBeta = Math.cos(beta);
  const dLon = lon - LON0;
  const cosDLon = Math.cos(dLon);
  const b = R_Q * Math.sqrt(2 / (1 + SIN_BETA0 * sinBeta + COS_BETA0 * cosBeta * cosDLon));
  return [
    FALSE_EASTING + b * D * cosBeta * Math.sin(dLon),
    FALSE_NORTHING + (b / D) * (COS_BETA0 * sinBeta - SIN_BETA0 * cosBeta * cosDLon),
  ];
}

// ── Lecture du COG ─────────────────────────────────────────────────────────

/**
 * @typedef {{ width: number, height: number, tileWidth: number, tileHeight: number, tileOffsets: number[], tileByteCounts: number[], samples: number }} CogLevel
 * @typedef {{ levels: CogLevel[], originX: number, originY: number, pixelSize: number }} CogHeader
 */

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 11: 4, 12: 8, 16: 8, 17: 8 };

/**
 * En-tête d'un GeoTIFF tuilé (TIFF classique ou BigTIFF) : une entrée par
 * niveau (pleine résolution, puis aperçus), origine et taille de pixel.
 * `buf` doit contenir toutes les IFD et leurs tableaux ; sinon lève
 * `RangeError` avec `needBytes` (le lecteur relit alors un en-tête plus long).
 *
 * @param {Buffer} buf
 * @returns {CogHeader}
 */
export function parseCogHeader(buf) {
  const ensure = (end) => {
    if (end > buf.length) throw Object.assign(new RangeError('COG header truncated'), { needBytes: end });
  };
  ensure(16);
  const little = buf.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (ensure(o + 2), little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (ensure(o + 4), little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => (ensure(o + 8), Number(little ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o)));
  const f64 = (o) => (ensure(o + 8), little ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const big = u16(2) === 43;
  if (!big && u16(2) !== 42) throw new Error('Not a TIFF');

  const readValues = (type, count, at) => {
    const out = [];
    const size = TYPE_SIZES[type] ?? 1;
    for (let k = 0; k < count; k++) {
      const o = at + k * size;
      if (type === 3) out.push(u16(o));
      else if (type === 4) out.push(u32(o));
      else if (type === 16) out.push(u64(o));
      else if (type === 12) out.push(f64(o));
      else out.push(buf[o]);
    }
    return out;
  };

  /** @type {CogLevel[]} */
  const levels = [];
  let originX = 0;
  let originY = 0;
  let pixelSize = 0;
  let ifd = big ? u64(8) : u32(4);
  while (ifd && levels.length < 16) {
    const count = big ? u64(ifd) : u16(ifd);
    const entrySize = big ? 20 : 12;
    const first = ifd + (big ? 8 : 2);
    /** @type {Record<number, number[]>} */
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = first + i * entrySize;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = big ? u64(e + 4) : u32(e + 4);
      const inline = (TYPE_SIZES[type] ?? 1) * n <= (big ? 8 : 4);
      const at = inline ? e + (big ? 12 : 8) : (big ? u64(e + 12) : u32(e + 8));
      if ([256, 257, 259, 277, 322, 323, 324, 325, 33550, 33922].includes(tag)) tags[tag] = readValues(type, n, at);
    }
    if (tags[259]?.[0] !== 8 && tags[259]?.[0] !== 32946) throw new Error('COG compression must be DEFLATE');
    levels.push({
      width: tags[256][0],
      height: tags[257][0],
      tileWidth: tags[322][0],
      tileHeight: tags[323][0],
      tileOffsets: tags[324],
      tileByteCounts: tags[325],
      samples: tags[277]?.[0] ?? 1,
    });
    if (levels.length === 1) {
      pixelSize = tags[33550][0];
      originX = tags[33922][3] - tags[33922][0] * pixelSize;
      originY = tags[33922][4] + tags[33922][1] * pixelSize;
    }
    const next = first + count * entrySize;
    ifd = big ? u64(next) : u32(next);
  }
  if (levels.length === 0 || !pixelSize) throw new Error('COG without image');
  return { levels, originX, originY, pixelSize };
}

async function fetchRange(url, start, endInclusive) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${endInclusive}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status !== 206 && res.status !== 200) throw new Error(`OPERA HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function frameUrl(frame) {
  const day = `${frame.slice(0, 4)}/${frame.slice(4, 6)}/${frame.slice(6, 8)}`;
  return `${BUCKET_URL}/${day}/OPERA/COMP/OPERA@${frame}@0@DBZH.tiff`;
}

const headerCache = createByteLru({ maxBytes: 2 * 1024 * 1024, sizeOf: () => 8 * 1024, ttlMs: 26 * 3600_000 });
const headersInFlight = new Map();

/** @returns {Promise<CogHeader>} */
function frameHeader(frame) {
  const cached = headerCache.get(frame);
  if (cached) return Promise.resolve(cached);
  let pending = headersInFlight.get(frame);
  if (!pending) {
    pending = (async () => {
      let bytes = HEADER_FETCH_BYTES;
      for (;;) {
        const buf = await fetchRange(frameUrl(frame), 0, bytes - 1);
        try {
          const header = parseCogHeader(buf);
          headerCache.set(frame, header);
          return header;
        } catch (error) {
          const need = /** @type {{ needBytes?: number }} */ (error).needBytes;
          if (!need || bytes >= 4 * 1024 * 1024) throw error;
          bytes = Math.max(bytes * 2, need);
        }
      }
    })().finally(() => headersInFlight.delete(frame));
    headersInFlight.set(frame, pending);
  }
  return pending;
}

/**
 * Réflectivité d'une tuile du COG (première bande ; la seconde est l'indice
 * de qualité), sur un octet par pixel : 0 = rien à dessiner (rien détecté,
 * hors couverture, sous MIN_DBZ), sinon MIN_DBZ + (code − 1) / 4 dBZ, au
 * quart de dB près jusqu'à ~70 dBZ — 4 fois moins de mémoire qu'en float32,
 * pour une palette qui sature à 20 mm/h (≈ 46 dBZ).
 */
const decodedTiles = createByteLru({ maxBytes: 32 * 1024 * 1024, sizeOf: (value) => value.byteLength, ttlMs: 26 * 3600_000 });
const tilesInFlight = new Map();

/** Code d'un octet d'une réflectivité (dBZ) ; 0 = rien à dessiner. */
function encodeDbz(dbz) {
  if (!(dbz >= MIN_DBZ)) return 0;
  return Math.min(255, Math.round((dbz - MIN_DBZ) * 4) + 1);
}

function decodeDbz(code) {
  return MIN_DBZ + (code - 1) / 4;
}

/**
 * Case de palette de chaque code de réflectivité (le code tient sur un
 * octet) : la conversion en pluie (puissance) n'est jamais faite par pixel.
 * Remplie à la première tuile (rainRateFromDbz est défini plus bas).
 */
let paletteIndexByCode = null;

function paletteIndexForCode() {
  if (!paletteIndexByCode) {
    paletteIndexByCode = new Uint8Array(256);
    for (let code = 1; code < 256; code++) paletteIndexByCode[code] = radarPaletteIndex(rainRateFromDbz(decodeDbz(code)));
  }
  return paletteIndexByCode;
}

/** @returns {Promise<Uint8Array>} */
function cogTile(frame, header, levelIndex, tileIndex) {
  const key = `${frame}|${levelIndex}|${tileIndex}`;
  const cached = decodedTiles.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = tilesInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const level = header.levels[levelIndex];
      const offset = level.tileOffsets[tileIndex];
      const length = level.tileByteCounts[tileIndex];
      const pixels = level.tileWidth * level.tileHeight;
      const raw = inflateSync(await fetchRange(frameUrl(frame), offset, offset + length - 1), {
        maxOutputLength: pixels * level.samples * 4,
      });
      const values = new Uint8Array(pixels);
      for (let i = 0; i < pixels; i++) values[i] = encodeDbz(raw.readFloatLE(i * level.samples * 4));
      decodedTiles.set(key, values);
      return values;
    })().finally(() => tilesInFlight.delete(key));
    tilesInFlight.set(key, pending);
  }
  return pending;
}

// ── Images disponibles ─────────────────────────────────────────────────────

/** Clé d'image `AAAAMMJJTHHMM` (UTC) d'une date. */
function frameKey(date) {
  const p = (v) => String(v).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

function frameTimeSeconds(frame) {
  return Date.UTC(+frame.slice(0, 4), +frame.slice(4, 6) - 1, +frame.slice(6, 8), +frame.slice(9, 11), +frame.slice(11, 13)) / 1000;
}

/** Clés d'image des composites DBZH d'une liste S3 (ListObjectsV2). */
export function parseFrameListing(xml) {
  const frames = [];
  for (const match of xml.matchAll(/<Key>[^<]*OPERA@(\d{8}T\d{4})@0@DBZH\.tiff<\/Key>/g)) frames.push(match[1]);
  return frames;
}

let frameListCache = { at: 0, frames: /** @type {string[]} */ ([]) };
let frameListInFlight = null;

async function listDay(dayDate, startAfterFrame) {
  const p = (v) => String(v).padStart(2, '0');
  const prefix = `${dayDate.getUTCFullYear()}/${p(dayDate.getUTCMonth() + 1)}/${p(dayDate.getUTCDate())}/OPERA/COMP/`;
  const params = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
  if (startAfterFrame) params.set('start-after', `${prefix}OPERA@${startAfterFrame}`);
  const res = await fetch(`${BUCKET_URL}/?${params}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OPERA listing HTTP ${res.status}`);
  return parseFrameListing(await res.text());
}

/**
 * Dernières images radar (la plus récente en dernier), au format attendu par
 * le client (`radar.past` de radar.json).
 *
 * @returns {Promise<Array<{ time: number, path: string }>>}
 */
export async function listOperaFrames(now = new Date()) {
  if (Date.now() - frameListCache.at < FRAME_LIST_TTL_MS && frameListCache.frames.length) {
    return frameListCache.frames.map((frame) => ({ time: frameTimeSeconds(frame), path: `/opera/${frame}` }));
  }
  if (!frameListInFlight) {
    frameListInFlight = (async () => {
      const since = new Date(now.getTime() - 90 * 60_000);
      const days = since.getUTCDate() === now.getUTCDate() ? [now] : [since, now];
      const lists = await Promise.all(days.map((day) => listDay(day, frameKey(since))));
      const frames = [...new Set(lists.flat())].sort().slice(-FRAME_COUNT);
      frameListCache = { at: Date.now(), frames };
      return frames;
    })().finally(() => {
      frameListInFlight = null;
    });
  }
  const frames = await frameListInFlight;
  return frames.map((frame) => ({ time: frameTimeSeconds(frame), path: `/opera/${frame}` }));
}

/** Image d'un chemin `/opera/AAAAMMJJTHHMM`, ou null. */
export function operaFrameFromPath(path) {
  return FRAME_PATH_RE.exec(path ?? '')?.[1] ?? null;
}

// ── Tuile de carte ─────────────────────────────────────────────────────────

/** Niveau du COG dont le pixel est le plus grand sans dépasser celui de la tuile (pas de perte de détail). */
function levelForZoom(z, latDeg, header) {
  const tilePixelMeters = (40_075_016.686 * Math.cos((latDeg * Math.PI) / 180)) / (TILE_SIZE * 2 ** z);
  const ratio = tilePixelMeters / header.pixelSize;
  const level = ratio < 1 ? 0 : Math.floor(Math.log2(ratio));
  return Math.max(0, Math.min(header.levels.length - 1, level));
}

/**
 * Pour chaque pixel de la tuile de carte : index du pixel source dans le
 * niveau (ligne × largeur + colonne), ou −1 hors de la grille. Ne dépend que
 * de la tuile et du niveau, donc gardé d'une image à l'autre.
 */
const pixelMaps = createByteLru({ maxBytes: 24 * 1024 * 1024, sizeOf: (value) => value.byteLength });

function sourcePixelMap(z, x, y, levelIndex, header) {
  const key = `${z}/${x}/${y}|${levelIndex}`;
  const cached = pixelMaps.get(key);
  if (cached) return cached;
  const level = header.levels[levelIndex];
  const scale = header.pixelSize * (header.levels[0].width / level.width);
  const map = new Int32Array(TILE_SIZE * TILE_SIZE);
  const worldPixels = TILE_SIZE * 2 ** z;
  for (let py = 0; py < TILE_SIZE; py++) {
    const mercY = 0.5 - (y * TILE_SIZE + py + 0.5) / worldPixels;
    const lat = (Math.atan(Math.sinh(mercY * 2 * Math.PI)) * 180) / Math.PI;
    for (let px = 0; px < TILE_SIZE; px++) {
      const lon = ((x * TILE_SIZE + px + 0.5) / worldPixels) * 360 - 180;
      const [easting, northing] = projectToOpera(lon, lat);
      const col = Math.floor((easting - header.originX) / scale);
      const row = Math.floor((header.originY - northing) / scale);
      map[py * TILE_SIZE + px] = col >= 0 && row >= 0 && col < level.width && row < level.height ? row * level.width + col : -1;
    }
  }
  pixelMaps.set(key, map);
  return map;
}

/** Intensité de pluie (mm/h) d'une réflectivité (dBZ), Marshall-Palmer : Z = 200 R^1,6. */
export function rainRateFromDbz(dbz) {
  return (10 ** (dbz / 10) / 200) ** (1 / 1.6);
}

function encodeRgbaPng(width, height, rgba) {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    rgba.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Niveau 3 : 2,6× plus rapide que le niveau 6 pour des tuiles ~20 % plus
    // lourdes (mesuré sur une vraie image : 3,1 ms / 41 Ko contre 8,2 ms / 34 Ko) ;
    // l'encodage tourne sur le fil principal à chaque palette inédite.
    chunk('IDAT', deflateSync(scanlines, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const renderedTiles = createByteLru({ maxBytes: 24 * 1024 * 1024, sizeOf: (value) => value.length, ttlMs: 3 * 3600_000 });

/**
 * Tuile radar Web Mercator (PNG 512 px) de l'image `frame`, colorée avec la
 * palette `palette` (format de radar-recolor.mjs ; vide = palette par défaut).
 * Transparente là où il ne pleut pas ou hors de la couverture OPERA.
 *
 * @returns {Promise<Buffer>}
 */
export async function renderOperaTile(frame, z, x, y, palette = '') {
  const cacheKey = `${frame}|${z}/${x}/${y}|${palette}`;
  const cached = renderedTiles.get(cacheKey);
  if (cached) return cached;

  const header = await frameHeader(frame);
  const centerLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z))) * 180) / Math.PI;
  const levelIndex = levelForZoom(z, centerLat, header);
  const level = header.levels[levelIndex];
  const map = sourcePixelMap(z, x, y, levelIndex, header);
  const tilesAcross = Math.ceil(level.width / level.tileWidth);

  // Tuiles du COG nécessaires, lues en parallèle.
  const needed = new Set();
  for (const index of map) {
    if (index < 0) continue;
    const row = Math.floor(index / level.width);
    const col = index - row * level.width;
    needed.add(Math.floor(row / level.tileHeight) * tilesAcross + Math.floor(col / level.tileWidth));
  }
  const tiles = new Map();
  await Promise.all([...needed].map(async (tileIndex) => {
    tiles.set(tileIndex, await cogTile(frame, header, levelIndex, tileIndex));
  }));

  const rgba = Buffer.alloc(TILE_SIZE * TILE_SIZE * 4);
  const colors = radarPaletteLookup(palette);
  const indexByCode = paletteIndexForCode();
  for (let i = 0; i < map.length; i++) {
    const index = map[i];
    if (index < 0) continue;
    const row = Math.floor(index / level.width);
    const col = index - row * level.width;
    const tile = tiles.get(Math.floor(row / level.tileHeight) * tilesAcross + Math.floor(col / level.tileWidth));
    const code = tile[(row % level.tileHeight) * level.tileWidth + (col % level.tileWidth)];
    if (code === 0) continue;
    const color = colors[indexByCode[code]];
    if (!color.visible) continue;
    rgba[i * 4] = color.r;
    rgba[i * 4 + 1] = color.g;
    rgba[i * 4 + 2] = color.b;
    rgba[i * 4 + 3] = 255;
  }
  const png = encodeRgbaPng(TILE_SIZE, TILE_SIZE, rgba);
  renderedTiles.set(cacheKey, png);
  return png;
}
