// ---------------------------------------------------------------------------
// Tuile de pente — repli dans le processus courant (pool de workers indisponible).
//
// Le calcul (Horn sur un tampon élargi, encodage en gamma racine, Catmull-Rom 2×,
// PNG gris + alpha) vit dans workers/slope-math.js et est partagé avec le pool
// de workers : les deux chemins produisent des tuiles identiques à l'octet près.
// Ce fichier ne fait que décoder les blobs DEM sur le fil du SW, avec un petit
// LRU pour qu'une tuile DEM lue comme tuile propre d'une tuile de pente et comme
// voisine de quatre autres ne soit décodée qu'une fois.
//
// Encodage (voir slope-math.js / slope-source.ts) :
//   gris  = round(sqrt(deg / 90) · 255)   — décodé côté GPU par raster-color-mix
//   alpha = 0 sur NoData / hors de la zone d'analyse, 255 sinon
// Les couleurs, les bandes masquées et le mode dégradé/paliers sont des
// propriétés de peinture GPU : elles n'invalident jamais une tuile.
// ---------------------------------------------------------------------------

const SLOPE_DECODED_DEM_CACHE_MAX = 384;
const slopeDecodedDemCache = new Map();
const slopeDecodedDemInflight = new Map();
let slopeDecodeCacheGeneration = 0;

function slopeDemDecodeKey(z, x, y, demProfile) {
  return `${demProfile || 'default'}:${z}/${x}/${y}`;
}

function rememberSlopeDecodedDem(key, elevations, generation) {
  if (!elevations) return elevations;
  if (generation !== slopeDecodeCacheGeneration) return elevations;
  if (slopeDecodedDemCache.has(key)) slopeDecodedDemCache.delete(key);
  slopeDecodedDemCache.set(key, elevations);
  while (slopeDecodedDemCache.size > SLOPE_DECODED_DEM_CACHE_MAX) {
    const oldest = slopeDecodedDemCache.keys().next().value;
    if (oldest === undefined) break;
    slopeDecodedDemCache.delete(oldest);
  }
  return elevations;
}

async function decodeSlopeDemBlob(demBlob, z, x, y, demProfile) {
  // La taille du blob distingue deux versions DEM des mêmes coordonnées
  // (remplaçant ou construction finale, 30 m ou LiDAR — toutes deux sous la clé
  // de profil 'default').
  const key = `${slopeDemDecodeKey(z, x, y, demProfile)}:${demBlob?.size || 0}`;
  if (slopeDecodedDemCache.has(key)) {
    const cached = slopeDecodedDemCache.get(key);
    slopeDecodedDemCache.delete(key);
    slopeDecodedDemCache.set(key, cached);
    return cached;
  }
  if (slopeDecodedDemInflight.has(key)) return slopeDecodedDemInflight.get(key);

  const generation = slopeDecodeCacheGeneration;
  const work = decodeTerrainRGBBlob(demBlob)
    .then((elevations) => rememberSlopeDecodedDem(key, elevations, generation))
    .finally(() => slopeDecodedDemInflight.delete(key));
  slopeDecodedDemInflight.set(key, work);
  return work;
}

function clearSlopeProcessingCaches() {
  slopeDecodeCacheGeneration++;
  slopeDecodedDemCache.clear();
  slopeDecodedDemInflight.clear();
}

function invalidateSlopeProcessingTile(z, x, y) {
  slopeDecodeCacheGeneration++;
  const prefixes = [
    `${slopeDemDecodeKey(z, x, y, 'default')}:`,
    `${slopeDemDecodeKey(z, x, y, 'terrain')}:`,
  ];
  for (const map of [slopeDecodedDemCache, slopeDecodedDemInflight]) {
    for (const key of Array.from(map.keys())) {
      if (prefixes.some((p) => key.startsWith(p))) map.delete(key);
    }
  }
}

// `neighbourBlobs` : blobs DEM { north, east, south, west } déjà résolus par
// resolveSlopeNeighbourDems() (null quand absents).
// Renvoie { blob, missingDirections } comme le pool de workers.
async function buildSlopeTile(demBlob, neighbourBlobs, z, x, y, resFactor, demProfile, zoneRing, outputScale) {
  const n = 2 ** z;
  const coords = {
    north: [x, y - 1],
    east: [(x + 1) % n, y],
    south: [x, y + 1],
    west: [(x - 1 + n) % n, y],
  };
  const ownElev = await decodeSlopeDemBlob(demBlob, z, x, y, demProfile);
  const neighbourElevations = {};
  await Promise.all(Object.keys(coords).map(async (dir) => {
    const blob = neighbourBlobs?.[dir];
    if (!blob) return;
    const [nx, ny] = coords[dir];
    try {
      neighbourElevations[dir] = await decodeSlopeDemBlob(blob, z, nx, ny, demProfile);
    } catch { /* traité comme manquant */ }
  }));
  return buildSlopePngFromElevations(ownElev, neighbourElevations, z, x, y, {
    resFactor,
    outputScale,
    zoneRing,
  });
}
