// ---------------------------------------------------------------------------
// Fonctions partagées des constructions de tuiles DEM IGN (build-tile.js,
// build-fallback-tile.js, build-terrain-tile.js) : cache négatif des zones MNS,
// post-traitement du MNS France, fetchs de raster tenant compte des annulations,
// et résultats de construction provisoires / annulés.
// ---------------------------------------------------------------------------

// Cache négatif des zones MNS — retient les régions de tuiles Mercator où le
// MNS n'a renvoyé aucune couverture, uniquement des 404 définitives. Des tuiles
// voisines partagent les mêmes sous-tuiles IGN : sauter le MNS sur les zones
// connues vides économise 4 à 8 s par tuile. TTL : 30 min. Clé : « z/x/y » au
// niveau demZ (zoom plafonné), ce qui regroupe les tuiles Mercator proches qui
// tombent sur la même grille de sous-tuiles IGN.
const mnsAreaNegCache = new Map();
const MNS_AREA_NEG_TTL = 30 * 60_000; // 30 min

function mnsAreaNegKey(z, x, y) {
  // Regroupement à la granularité z14 (plafond IGN_DEM_MAXZOOM), pour que les
  // tuiles Mercator z15-17 voisines qui tombent sur les mêmes sous-tuiles IGN z14
  // partagent une seule entrée de cache négatif.
  const groupZ = Math.min(z, IGN_DEM_MAXZOOM);
  const shift = z - groupZ;
  return `${groupZ}/${x >> shift}/${y >> shift}`;
}

function mnsAreaNegGet(z, x, y) {
  const key = mnsAreaNegKey(z, x, y);
  const entry = mnsAreaNegCache.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts < MNS_AREA_NEG_TTL) return true;
  mnsAreaNegCache.delete(key);
  return false;
}

function mnsAreaNegSet(z, x, y) {
  const key = mnsAreaNegKey(z, x, y);
  mnsAreaNegCache.set(key, { ts: Date.now() });
  // Éviction si trop gros
  if (mnsAreaNegCache.size > 500) {
    const iter = mnsAreaNegCache.keys();
    for (let i = 0; i < 200; i++) {
      const k = iter.next().value;
      if (k !== undefined) mnsAreaNegCache.delete(k);
    }
  }
}

function postProcessFranceMnsTile(elevations, coverage, mercZ) {
  despikeElevations(elevations, coverage, DEM_TILE_SIZE);
  if (mercZ <= IGN_MNS_MIDZOOM_SMOOTH_MAXZOOM) {
    smoothSurfaceMicroUndulations(
      elevations,
      coverage,
      DEM_TILE_SIZE,
      IGN_MNS_MIDZOOM_SMOOTH_VARIANCE_M,
    );
  }
}

// Un fetch de raster IGN annulé (IGN_FETCH_CANCELLED) ne dit rien de la tuile :
// soit elle est redemandée — elle est encore voulue —, soit la construction
// abandonne avec un résultat `cancelled` que les appelants n'enregistrent
// jamais. Passer plutôt à la source suivante (MNS de corrélation, RGE ALTI, AWS
// à 30 m) mettait en cache une tuile dégradée pour de bon chaque fois qu'un
// geste ou un vidage de file touchait une tuile encore à l'écran.
const IGN_CANCEL_RETRY_MAX_MAP = 6;
const IGN_CANCEL_RETRY_MAX_OTHER = 2;

async function fetchIgnRasterThroughCancels(fetchOnce, purpose, mapTile) {
  let result = await fetchOnce();
  for (let attempt = 0; result === IGN_FETCH_CANCELLED; attempt++) {
    // Le travail spéculatif (préchargement, préchauffages) ne vaut pas une seconde requête.
    if (isIGNBackgroundPurpose(purpose)) break;
    if (mapTile) {
      if (attempt >= IGN_CANCEL_RETRY_MAX_MAP || !isMapDemTileWanted(mapTile)) break;
    } else if (attempt >= IGN_CANCEL_RETRY_MAX_OTHER) {
      break;
    }
    result = await fetchOnce();
  }
  return result;
}

// Une surface de buildIGNTile() qui n'est pas la réponse du WMS LiDAR HD alors
// que le WMS n'a jamais confirmé de trou de couverture : l'ancien chemin MNS de
// corrélation a tourné parce que le WMS a échoué passagèrement. Provisoire,
// jamais une tuile définitive.
function isProvisionalMnsBuild(result, mercZ, mercX, mercY) {
  return Boolean(result?.elevations)
    && result.source !== 'ign-lidar-hd-wms'
    && typeof isMnsWmsConfirmedEmpty === 'function'
    && !isMnsWmsConfirmedEmpty(mercZ, mercX, mercY);
}

function cancelledIgnBuild() {
  return {
    blob: null, elevations: null, coverage: null,
    source: 'ign-cancelled', cancelled: true, allPermanent404: false, pendingFetches: null,
  };
}

// `mapTile` ({ key, requestedAt }) : renseigné quand la carte elle-même a demandé cette
