// ---------------------------------------------------------------------------
// Slope Tile Processing — Shared Helpers
// ---------------------------------------------------------------------------

const DEBUG_SLOPE = false;

// Zoom natif de la pente mondiale (AWS 30 m). Même plafond que le mode 30 m
// (resolveSlopeMaxZoom de slope-source.ts) : au-delà, les tuiles AWS Terrarium
// sont suréchantillonnées côté serveur et Horn transforme l'interpolation en
// hachures, donc les zooms supérieurs réutilisent la pente z13 (voir
// buildUpsampledGlobalSlopeResponse).
const GLOBAL_SLOPE_NATIVE_MAX_Z = 13;

// Zoom HD de pente le plus profond (comme dans slope-source.ts) : au-delà, les
// rasters nationaux sont suréchantillonnés et Mapbox suréchantillonne lui-même
// la pente z16.
const HD_SLOPE_MAX_Z = 16;

// Les tuiles alignées sur le terrain sont dessinées sur 1024 à 2048 px CSS pour
// 256 cellules de DEM : la pente est suréchantillonnée 2× ici avec une cubique
// lisse (slope-math.js), pour que l'agrandissement bilinéaire du GPU ait 4× moins
// à étirer. Les tuiles de zone (pipeline z14) restent en résolution native.
const SLOPE_OUTPUT_SCALE = 2;

function logDemPente(...args) {
  if (!DEBUG_SLOPE) return;
  console.log('[DEM PENTE]', ...args);
  try {
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'DEM_PENTE_LOG',
          message: args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
        });
      });
    }).catch(() => {});
  } catch { /* ignore */ }
}

async function invalidateParentDownsampledSlopeTiles(z, x, y, zoneHash) {
  if (!zoneHash) return;
  try {
    if (typeof slopeHotInvalidateZoneDownsampled === 'function') {
      slopeHotInvalidateZoneDownsampled(zoneHash);
    }
    const slopeCache = await caches.open(SLOPE_CACHE_NAME);
    const keys = await slopeCache.keys();
    const zoneSub = `zone=${zoneHash}`;
    const toDelete = [];
    for (const req of keys) {
      const url = req.url;
      if (url.includes(zoneSub)) {
        const match = url.match(/\/slope-tiles\/(\d+)\//);
        if (match && parseInt(match[1], 10) < 14) {
          toDelete.push(slopeCache.delete(req));
        }
      }
    }
    await Promise.all(toDelete);
  } catch { /* best-effort */ }
}

// ── Tuiles de pente périmées → rechargement de la source côté page ────
// Une tuile de pente provisoire (voisine manquante, DEM de remplacement, repli
// sur l'ancêtre, remplaçant transparent) est servie mais pas mise en cache ; la
// page recharge la source des pentes sur SLOPE_TILES_STALE
// (derived-tile-stale.js). Une tuile de pente construite alors qu'un DEM voisin
// cardinal n'est pas encore là (le terrain ne l'a jamais demandé : hors de la
// vue), ou alors que son propre DEM est un remplaçant, attend cette tuile DEM et
// revient avec des jointures complètes dès qu'elle arrive.
const SLOPE_STALE_TRACKER = createDerivedTileStaleTracker('SLOPE_TILES_STALE');

function noteSlopeTileStale(tileKey, options) {
  SLOPE_STALE_TRACKER.noteStale(tileKey, options);
}

function noteSlopeTileFinal(tileKey) {
  SLOPE_STALE_TRACKER.noteFinal(tileKey);
}

function waitSlopeTileOnDem(tileKey, demProfile, z, tiles) {
  SLOPE_STALE_TRACKER.waitOnDem(tileKey, demProfile, z, tiles);
}

function isSlopeWorkCancelled(generation) {
  if (generation === null || generation === undefined) return false;
  return generation !== slopeCancelGeneration;
}

// Blob DEM propre → PNG de pente. Les voisines sont résolues d'abord (tuiles du
// terrain, constructions en cours attendues), puis la tâche tourne dans le pool
// de workers — ou dans le processus courant quand le pool est indisponible.
//
// Renvoie { blob, missingNeighbours: [[x, y]], standInNeighbours: [[x, y]] }
// ou null (annulée / échouée).
async function buildSlopeBlobFromDem(demBlob, z, x, y, demCache, resFactor, demProfile, generation, zoneRing, sourceDem = '', ownSourceClass = '', outputScale = 1) {
  const neighbours = await resolveSlopeNeighbourDems(z, x, y, demProfile, demCache, sourceDem, ownSourceClass);
  if (generation !== null && isSlopeWorkCancelled(generation)) return null;

  let slopeResult = null;
  if (typeof computeSlopeViaPool === 'function') {
    try {
      slopeResult = await computeSlopeViaPool(
        demBlob, neighbours.blobs, z, x, y, resFactor, generation, zoneRing, outputScale,
      );
    } catch {
      /* on poursuit dans le processus courant */
    }
  }
  if (!slopeResult) {
    slopeResult = await scheduleSlopeBuild(
      () => buildSlopeTile(demBlob, neighbours.blobs, z, x, y, resFactor, demProfile, zoneRing, outputScale),
      generation,
    );
  }
  if (!slopeResult?.blob || (generation !== null && isSlopeWorkCancelled(generation))) return null;

  // Un blob voisin que le worker n'a pas pu décoder compte aussi comme manquant.
  const missingNeighbours = neighbours.missing.slice();
  const n = 2 ** z;
  const offsets = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  for (const dir of slopeResult.missingDirections || []) {
    if (!neighbours.blobs[dir] || !offsets[dir]) continue;
    missingNeighbours.push([(x + offsets[dir][0] + n) % n, y + offsets[dir][1]]);
  }
  return {
    blob: slopeResult.blob,
    missingNeighbours,
    standInNeighbours: neighbours.standIns,
  };
}

// ── HD coverage & DEM source classes ──────────────────────────────────

/**
 * Vrai quand un DEM national haute résolution (IGN France, outre-mer compris,
 * swissSURFACE3D, MNT norvégien, MDT espagnol) peut couvrir la tuile —
 * c'est-à-dire quand le pipeline de pente HD a mieux qu'AWS 30 m à exploiter.
 * Utilise les mêmes prédicats que le dispatcher DEM (compute-request.js).
 */
async function slopeTileHasHdCoverage(z, x, y) {
  if (tileOverlapsOverseasFrance(z, x, y)) return true;
  if (tileOverlapsSwitzerland(z, x, y) || tileOverlapsNorway(z, x, y) || tileOverlapsSpain(z, x, y)) return true;
  if (!tileOverlapsFrance(z, x, y)) return false;
  // Polygone indisponible : on garde le chemin HD (comportement précédent).
  if (!(await ensureFrancePoly())) return true;
  return classifyDemTile(z, x, y) !== 'outside';
}

/** 'aws' pour le DEM mondial à 30 m, 'hires' pour chaque DEM national haute résolution. */
function slopeDemSourceClass(source) {
  const s = (source || '').toLowerCase();
  return (s === 'aws-fast-30m' || s.startsWith('aws-terrarium')) ? 'aws' : 'hires';
}
