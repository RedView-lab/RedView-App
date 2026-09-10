/**
 * Server-side Doppler Radar Tile Recolorer
 * Decompresses RainViewer Scheme 2 (512x512 RGBA) PNG tiles and recolors
 * precipitation intensity in ~3 ms using node:zlib without external dependencies.
 */
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

function rainviewerRgbToMm(r, g, b) {
  if (r >= 200 && b < 40) {
    return 5.0 + ((255 - g) / 255.0) * 20.0;
  }
  if (r >= 180 && b >= 150 && g < 100) {
    return 25.0 + (r / 255.0) * 15.0;
  }
  if (r > 140 && g > 130 && b > 80 && Math.abs(r - g) < 45 && r > b) {
    return 0.1 + (1.0 - Math.min(r, g) / 255.0) * 0.7;
  }
  if (b >= 70) {
    if (r < 30 && g < 150) {
      return 3.5 + (1.0 - g / 150.0) * 1.5;
    }
    if (g < 190) {
      return 2.0 + (1.0 - (g - 140) / 50.0) * 1.5;
    }
    return 0.8 + ((255 - r) / 255.0) * 1.2;
  }
  return 0.5;
}

function hexToRgb(hex) {
  const safe = hex.replace('#', '').trim();
  const expanded = safe.length === 3
    ? safe.split('').map((c) => c + c).join('')
    : safe.padEnd(6, '0').slice(0, 6);
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16),
  ];
}

function parseRadarPaletteParam(pStr) {
  if (!pStr) return { mode: 'gradient', bands: [] };
  const parts = pStr.split(':');
  const mode = parts[0] === 'fill' ? 'fill' : 'gradient';
  const bands = [];
  for (let i = 1; i < parts.length; i++) {
    const bandParts = parts[i].split('_');
    if (bandParts.length >= 3) {
      bands.push({
        color: '#' + bandParts[0].replace('#', ''),
        minValue: parseFloat(bandParts[1]) || 0,
        maxValue: parseFloat(bandParts[2]) || 20,
        visible: true,
      });
    }
  }
  return { mode, bands };
}

function buildRadarLookup(bands, mode, valMin = 0, valMax = 20) {
  const lookup = new Array(256);
  const span = Math.max(1e-5, valMax - valMin);

  if (!bands || bands.length === 0) {
    for (let b = 0; b < 256; b++) {
      if (b === 0) { lookup[b] = { r: 0, g: 0, b: 0, visible: false }; continue; }
      const t = b / 255.0;
      lookup[b] = {
        r: Math.round(223 + (18 - 223) * t),
        g: Math.round(246 + (71 - 246) * t),
        b: Math.round(255 + (185 - 255) * t),
        visible: true,
      };
    }
    return lookup;
  }

  for (let b = 0; b < 256; b++) {
    const realVal = valMin + (b / 255.0) * span;
    let matchedIndex = bands.length - 1;
    for (let i = 0; i < bands.length; i++) {
      const maxV = Number.isFinite(bands[i].maxValue) ? bands[i].maxValue : Infinity;
      if (realVal < maxV || i === bands.length - 1) {
        matchedIndex = i;
        break;
      }
    }
    const matchedBand = bands[matchedIndex];
    if (matchedBand.visible === false) {
      lookup[b] = { r: 0, g: 0, b: 0, visible: false };
      continue;
    }
    if (mode === 'fill') {
      const [r, g, bl] = hexToRgb(matchedBand.color);
      lookup[b] = { r, g, b: bl, visible: true };
    } else {
      const bMin = Number.isFinite(matchedBand.minValue) ? matchedBand.minValue : valMin;
      const bMax = Number.isFinite(matchedBand.maxValue) ? matchedBand.maxValue : valMax;
      const bSpan = Math.max(1e-5, bMax - bMin);
      const t = Math.max(0, Math.min(1, (realVal - bMin) / bSpan));
      const curRgb = hexToRgb(matchedBand.color);
      const nextBand = bands[Math.min(bands.length - 1, matchedIndex + 1)];
      const nextRgb = hexToRgb(nextBand.color);
      lookup[b] = {
        r: Math.round(curRgb[0] + (nextRgb[0] - curRgb[0]) * t),
        g: Math.round(curRgb[1] + (nextRgb[1] - curRgb[1]) * t),
        b: Math.round(curRgb[2] + (nextRgb[2] - curRgb[2]) * t),
        visible: true,
      };
    }
  }
  return lookup;
}

const lookupCache = new Map();

function getOrCreateLookup(pStr) {
  if (lookupCache.has(pStr)) return lookupCache.get(pStr);
  const { mode, bands } = parseRadarPaletteParam(pStr);
  const lookup = buildRadarLookup(bands, mode, 0, 20);
  lookupCache.set(pStr, lookup);
  return lookup;
}

function makeChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const toCrc = Buffer.concat([typeBuf, dataBuf]);
  const crc = crc32(toCrc);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, toCrc, crcBuf]);
}

/**
 * Recolors a RainViewer Doppler radar PNG Buffer according to palette parameter string `pStr`.
 * Returns the recolored PNG Buffer in ~3 milliseconds.
 */
export function recolorRadarPng(rawPngBuffer, pStr) {
  if (!pStr) return rawPngBuffer;

  try {
    let offset = 8;
    const idatParts = [];
    while (offset < rawPngBuffer.length) {
      const len = rawPngBuffer.readUInt32BE(offset);
      const type = rawPngBuffer.slice(offset + 4, offset + 8).toString('ascii');
      if (type === 'IDAT') {
        idatParts.push(rawPngBuffer.slice(offset + 8, offset + 8 + len));
      }
      offset += 12 + len;
    }

    if (idatParts.length === 0) return rawPngBuffer;

    const raw = inflateSync(Buffer.concat(idatParts));
    // Verify 512x512 RGBA scanline size: 512 * 2049 = 1,049,088 bytes
    if (raw.length !== 1049088) return rawPngBuffer;

    const lookup = getOrCreateLookup(pStr);

    for (let y = 0; y < 512; y++) {
      const row = y * 2049 + 1;
      for (let x = 0; x < 512; x++) {
        const idx = row + x * 4;
        const a = raw[idx + 3];
        if (a < 15) {
          raw[idx] = 0;
          raw[idx + 1] = 0;
          raw[idx + 2] = 0;
          raw[idx + 3] = 0;
          continue;
        }
        const r = raw[idx];
        const g = raw[idx + 1];
        const b = raw[idx + 2];
        const mm = rainviewerRgbToMm(r, g, b);
        const lIdx = Math.round(Math.max(0, Math.min(1, mm / 20.0)) * 255.0);
        const c = lookup[lIdx];
        if (!c.visible) {
          raw[idx] = 0;
          raw[idx + 1] = 0;
          raw[idx + 2] = 0;
          raw[idx + 3] = 0;
        } else {
          raw[idx] = c.r;
          raw[idx + 1] = c.g;
          raw[idx + 2] = c.b;
          // preserve alpha
        }
      }
    }

    const deflated = deflateSync(raw, { level: 1 });

    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(512, 0);
    ihdrData.writeUInt32BE(512, 4);
    ihdrData[8] = 8; // depth 8
    ihdrData[9] = 6; // RGBA
    ihdrData[10] = 0;
    ihdrData[11] = 0;
    ihdrData[12] = 0;

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makeChunk('IHDR', ihdrData),
      makeChunk('IDAT', deflated),
      makeChunk('IEND', Buffer.alloc(0)),
    ]);
  } catch (err) {
    console.warn('[radar-recolor] server recoloring fallback to raw:', err);
    return rawPngBuffer;
  }
}
