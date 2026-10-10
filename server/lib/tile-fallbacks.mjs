// ---------------------------------------------------------------------------
// Tuiles normalement servies par le Service Worker (public/sw-dem*). Une
// requête qui arrive au serveur vient d'une page qu'il ne contrôle pas
// (encore) : ce module y répond, pour server.mjs (prod) et le plugin de dev de
// vite.config.ts.
//  - /dem-tiles : le DEM n'existe que côté SW (la page non contrôlée utilise
//    AWS Terrarium en direct) → 204 ;
//  - /vhr-tiles : l'ortho très haute résolution n'existe que côté SW (Mapbox
//    Satellite reste visible dessous) → 204 ;
//  - /contour-tiles : les courbes de niveau HD sont calculées par le SW sur
//    son MNT (la page non contrôlée garde celles de Mapbox) → 204 ;
//  - `?pf=1` : préchargement spéculatif, inutile sans SW → 204 ;
//  - /radar-tiles : tuile du radar européen EUMETNET OPERA, fabriquée ici
//    (server/lib/opera-radar.mjs) et colorée avec la palette `p` ; aussi
//    demandée par le Service Worker, qui ne la calcule pas ;
//  - /slope-tiles, /altitude-tiles : calculées sur le serveur
//    (server/lib/terrain-tiles.mjs).
// Une tuile absente répond 204 jamais mis en cache : une panne passagère ne
// doit pas être mémorisée comme une vraie tuile.
// ---------------------------------------------------------------------------
import { parseTileCoords } from './http-security.mjs';
import { OPERA_RADAR_HOST, operaFrameFromPath, renderOperaTile } from './opera-radar.mjs';
import { isValidRadarPaletteParam } from './radar-recolor.mjs';
import { generateAltitudeTile, generateSlopeTile } from './terrain-tiles.mjs';

/** @typedef {'radar' | 'slope' | 'altitude' | 'dem' | 'vhr' | 'contour'} TileFamily */
/** @typedef {import('node:http').ServerResponse} ServerResponse */

const TILE_FAMILY_RE = /^\/(radar|slope|altitude|dem|vhr|contour)-tiles\//;
/** Au-delà, la carte agrandit le zoom 7 (source radar de la carte : maxzoom 7). */
const RADAR_MAX_ZOOM = 7;

/**
 * Famille de tuiles d'un chemin (`/slope-tiles/…` → `slope`), `null` sinon.
 *
 * @param {string} pathname
 * @returns {TileFamily | null}
 */
export function tileFallbackFamily(pathname) {
  return /** @type {TileFamily | undefined} */ (TILE_FAMILY_RE.exec(pathname)?.[1]) ?? null;
}

/**
 * La requête déclenche-t-elle un travail amont (lecture du radar OPERA,
 * calcul de tuile) ? Seules celles-là comptent dans le quota de l'IP.
 *
 * @param {TileFamily} family
 * @param {URLSearchParams} searchParams
 */
export function tileFallbackHitsUpstream(family, searchParams) {
  return family !== 'dem' && family !== 'vhr' && family !== 'contour' && searchParams.get('pf') !== '1';
}

/** @param {ServerResponse} res */
function sendNoTile(res) {
  res.statusCode = 204;
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/**
 * @param {ServerResponse} res
 * @param {Buffer} png
 * @param {Record<string, string>} headers
 */
function sendPng(res, png, headers) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Access-Control-Allow-Origin', '*');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(png);
}

/**
 * @param {string} pathname
 * @param {URLSearchParams} searchParams
 * @param {ServerResponse} res
 */
async function serveRadarTile(pathname, searchParams, res) {
  const coords = parseTileCoords(pathname, /^\/radar-tiles\/(\d+)\/(\d+)\/(\d+)/);
  // Image `/opera/AAAAMMJJTHHMM` seulement : rien d'autre n'atteint le bucket.
  const frame = searchParams.get('host') === OPERA_RADAR_HOST ? operaFrameFromPath(searchParams.get('path')) : null;
  if (!coords || !frame) {
    // Ancienne image RainViewer (onglet ouvert avant le passage à OPERA) : plus servie.
    if (coords) return sendNoTile(res);
    res.statusCode = 400;
    res.end('Invalid radar tile request');
    return;
  }
  if (coords.z > RADAR_MAX_ZOOM) return sendNoTile(res);
  const rawPalette = searchParams.get('p') || '';
  const palette = isValidRadarPaletteParam(rawPalette) ? rawPalette : '';
  try {
    const png = await renderOperaTile(frame, coords.z, coords.x, coords.y, palette);
    // Une image publiée ne change plus : sa tuile non plus.
    sendPng(res, png, { 'Cache-Control': 'public, max-age=86400, immutable', 'X-Weather-Source': 'eumetnet-opera' });
    return;
  } catch (error) {
    console.warn('[tile-fallbacks] radar tile failed:', error);
  }
  sendNoTile(res);
}

/**
 * @param {'slope' | 'altitude'} family
 * @param {string} pathname
 * @param {ServerResponse} res
 */
async function serveTerrainTile(family, pathname, res) {
  try {
    const coords = parseTileCoords(pathname, family === 'slope'
      ? /^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)/
      : /^\/altitude-tiles\/(\d+)\/(\d+)\/(\d+)/);
    if (coords) {
      const generate = family === 'slope' ? generateSlopeTile : generateAltitudeTile;
      const png = await generate(coords.z, coords.x, coords.y);
      if (png) {
        sendPng(res, png, {
          'Cache-Control': 'public, max-age=604800, immutable',
          'X-Tile-Type': family,
        });
        return;
      }
    }
  } catch (error) {
    console.warn(`[tile-fallbacks] ${family} tile failed:`, error);
  }
  sendNoTile(res);
}

/**
 * Répond à une requête de tuile de la famille `family` (voir l'en-tête).
 *
 * @param {TileFamily} family
 * @param {string} pathname
 * @param {URLSearchParams} searchParams
 * @param {ServerResponse} res
 * @returns {Promise<void>}
 */
export async function serveTileFallback(family, pathname, searchParams, res) {
  if (!tileFallbackHitsUpstream(family, searchParams)) return sendNoTile(res);
  if (family === 'radar') return serveRadarTile(pathname, searchParams, res);
  return serveTerrainTile(/** @type {'slope' | 'altitude'} */ (family), pathname, res);
}
