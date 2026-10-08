// ---------------------------------------------------------------------------
// Tuiles de l'overlay d'altitude dérivées des altitudes du DEM.
//
// Sortie : PNG compatible Terrain-RGB avec pixels NoData transparents.
//   - RGB encode l'altitude en mètres selon la formule Terrain-RGB standard
//   - A   = 0 sur NoData, 255 sinon
//
// La colorisation, les bandes masquées et le mode dégradé/paliers sont
// appliqués côté GPU par `raster-color` + `raster-color-mix` de Mapbox,
// exactement comme l'overlay des pentes. Le cache du SW n'est ainsi indexé que
// par (z, x, y, resFactor).
// ---------------------------------------------------------------------------

// Le décodage du PNG DEM est le principal coût CPU de l'overlay d'altitude. Une
// vue visible, son anneau de préchargement spéculatif et un rechargement après
// mise à niveau peuvent tous demander la même tuile coup sur coup. Un petit LRU
// de DEM décodés permet aux constructions d'altitude répétées de réutiliser les
// altitudes Float32 au lieu de relancer `createImageBitmap` + `getImageData`
// pour la même tuile.
const ALTITUDE_DECODED_DEM_CACHE_MAX = 96;
const altitudeDecodedDemCache = new Map();
const altitudeDecodedDemInflight = new Map();
let altitudeDecodeCacheGeneration = 0;

function altitudeDemDecodeKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function rememberAltitudeDecodedDem(key, elevations, generation) {
  if (!elevations) return elevations;
  if (generation !== altitudeDecodeCacheGeneration) return elevations;
  if (altitudeDecodedDemCache.has(key)) altitudeDecodedDemCache.delete(key);
  altitudeDecodedDemCache.set(key, elevations);
  while (altitudeDecodedDemCache.size > ALTITUDE_DECODED_DEM_CACHE_MAX) {
    const oldest = altitudeDecodedDemCache.keys().next().value;
    if (oldest === undefined) break;
    altitudeDecodedDemCache.delete(oldest);
  }
  return elevations;
}

async function decodeAltitudeDemBlob(demBlob, z, x, y) {
  const key = altitudeDemDecodeKey(z, x, y);
  if (altitudeDecodedDemCache.has(key)) {
    const cached = altitudeDecodedDemCache.get(key);
    altitudeDecodedDemCache.delete(key);
    altitudeDecodedDemCache.set(key, cached);
    return cached;
  }
  if (altitudeDecodedDemInflight.has(key)) return altitudeDecodedDemInflight.get(key);

  const generation = altitudeDecodeCacheGeneration;
  const work = decodeTerrainRGBBlob(demBlob)
    .then((elevations) => rememberAltitudeDecodedDem(key, elevations, generation))
    .finally(() => altitudeDecodedDemInflight.delete(key));
  altitudeDecodedDemInflight.set(key, work);
  return work;
}

function clearAltitudeProcessingCaches() {
  altitudeDecodeCacheGeneration++;
  altitudeDecodedDemCache.clear();
  altitudeDecodedDemInflight.clear();
}

function invalidateAltitudeProcessingTile(z, x, y) {
  altitudeDecodeCacheGeneration++;
  const key = altitudeDemDecodeKey(z, x, y);
  altitudeDecodedDemCache.delete(key);
  altitudeDecodedDemInflight.delete(key);
}

// ── PNG RGBA d'altitude seule ─────────────────────────────────────────────
// On réutilise l'encodage Terrain-RGB pour les canaux RGB, pour que le GPU
// reconstitue les mètres avec un seul raster-color-mix. Contrairement aux tuiles
// du maillage de terrain DEM, les pixels NoData restent transparents, pour que
// l'orthophoto reste visible là où le pipeline DEM n'a pas d'échantillon
// d'altitude.
//
// `buildAltitudeRgba` est la boucle pure d'encodage RGBA (sans E/S). Elle est
// séparée pour que le pool de workers d'altitude
// (workers/slope-pool.worker.js > kind:'altitude') puisse l'exécuter hors du fil
// principal sans dépendre de l'état Blob/CompressionStream — le worker appelle
// ensuite lui-même buildRawPng. Le chemin dans le processus courant ci-dessous
// enveloppe le même tampon RGBA dans buildRawPng : les sorties du pool et du
// processus courant sont identiques à l'octet près.
function buildAltitudeRgba(elevations) {
  const size = DEM_TILE_SIZE;
  const rgba = new Uint8Array(size * size * 4);

  for (let i = 0; i < elevations.length; i++) {
    const elev = elevations[i];
    const idx = i * 4;

    if (!Number.isFinite(elev) || elev <= DEM_NODATA_THRESHOLD) {
      rgba[idx + 3] = 0;
      continue;
    }

    const height = sanitizeElevation(elev);
    const val = Math.max(0, Math.min(16777215, Math.round((height + 10000) / 0.1)));
    rgba[idx] = (val >> 16) & 0xff;
    rgba[idx + 1] = (val >> 8) & 0xff;
    rgba[idx + 2] = val & 0xff;
    rgba[idx + 3] = 255;
  }

  return rgba;
}

async function encodeAltitudePng(elevations, zoneMask) {
  const size = DEM_TILE_SIZE;
  const rgba = buildAltitudeRgba(elevations);
  // Masque de zone d'analyse (core/analysis-zone.js) — l'alpha tombe à 0 hors
  // du polygone ; les canaux RGB Terrain-RGB restent intacts, pour que le
  // décodage raster-color côté GPU reste valide sur les pixels conservés.
  if (zoneMask) applyRingMaskToRgba(rgba, zoneMask);
  return (typeof buildRawPngSlope === 'function')
    ? buildRawPngSlope(size, size, rgba)
    : buildRawPng(size, size, rgba);
}

// ── Full pipeline — DEM blob → altitude overlay PNG ────────────────────────
async function buildAltitudeTile(demBlob, z, x, y, shouldCancel, zoneRing) {
  const t0 = performance.now();
  const elevations = await decodeAltitudeDemBlob(demBlob, z, x, y);
  const t1 = performance.now();
  if (typeof shouldCancel === 'function' && shouldCancel()) return null;
  const zoneMask = zoneRing ? rasterizeRingMask(zoneRing, z, x, y, DEM_TILE_SIZE) : null;
  const blob = await encodeAltitudePng(elevations, zoneMask);
  const t3 = performance.now();

  if (DEBUG) {
    console.log(
      `[altitude] ${z}/${x}/${y} dec=${(t1 - t0).toFixed(0)} enc=${(t3 - t1).toFixed(0)} total=${(t3 - t0).toFixed(0)}ms${zoneMask ? ' zone=1' : ''}`,
    );
  }

  return blob;
}