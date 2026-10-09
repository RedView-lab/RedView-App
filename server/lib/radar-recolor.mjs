/**
 * Palette du radar de précipitations : la chaîne `p` des tuiles radar
 * (`gradient|fill:hex_min_max:…`, construite par le client dans
 * radarClient.ts) devient une table de 256 couleurs sur l'échelle 0–20 mm/h.
 * Utilisée par opera-radar.mjs pour colorer chaque pixel de pluie.
 */
import { createOldestKeyTaker } from './oldest-key.mjs';

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

// LRU borné : la clé `p` vient de la query string, un cache non borné
// permettait de saturer la mémoire avec des palettes toutes différentes.
const LOOKUP_CACHE_MAX = 64;
const lookupCache = new Map();
const takeOldestLookup = createOldestKeyTaker(lookupCache);

// `mode:hex_min_max:hex_min_max…` — tout autre format est refusé.
const PALETTE_NUM = String.raw`-?[\d.]+(?:e[+-]?\d+)?`;
const PALETTE_PARAM_RE = new RegExp(`^[a-z]{1,16}(?::(?:#?[0-9a-fA-F]{3,8}_${PALETTE_NUM}_${PALETTE_NUM})?){0,32}$`, 'i');

export function isValidRadarPaletteParam(pStr) {
  return typeof pStr === 'string' && pStr.length <= 512 && PALETTE_PARAM_RE.test(pStr);
}

function getOrCreateLookup(pStr) {
  const cached = lookupCache.get(pStr);
  if (cached) {
    lookupCache.delete(pStr);
    lookupCache.set(pStr, cached);
    return cached;
  }
  const { mode, bands } = parseRadarPaletteParam(pStr);
  const lookup = buildRadarLookup(bands, mode, 0, 20);
  lookupCache.set(pStr, lookup);
  while (lookupCache.size > LOOKUP_CACHE_MAX) {
    lookupCache.delete(takeOldestLookup());
  }
  return lookup;
}

/**
 * Table de 256 couleurs de la palette `pStr` (vide ou invalide : palette par
 * défaut) sur l'échelle 0–20 mm/h de toutes les tuiles radar :
 * `radarPaletteIndex(mm)` y donne la case d'une intensité. Une case
 * `visible: false` ne se dessine pas (pluie trop faible, bande masquée).
 * À lire une fois par tuile, jamais par pixel (validation et cache LRU).
 *
 * @param {string} pStr
 * @returns {ReadonlyArray<{ r: number, g: number, b: number, visible: boolean }>}
 */
export function radarPaletteLookup(pStr) {
  return getOrCreateLookup(pStr && isValidRadarPaletteParam(pStr) ? pStr : '');
}

/** Case de la table de palette d'une intensité de pluie (mm/h). */
export function radarPaletteIndex(mm) {
  return Math.round(Math.max(0, Math.min(1, mm / 20.0)) * 255.0);
}
