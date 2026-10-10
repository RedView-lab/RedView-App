// ---------------------------------------------------------------------------
// Interception des fetchs — aiguille /dem-tiles, /ortho-tiles, /vhr-tiles,
// /slope-tiles, /altitude-tiles, /contour-tiles vers le module de handler correspondant.
// L'ancien /shadow-tiles répond 410 d'office (handler retiré le 29 avril).
//
// Extrait de sw-dem.js (3 mai).
// ---------------------------------------------------------------------------

// Délestage du préchargement spéculatif. Les requêtes portant `?pf=1` sont
// émises par `viewportPrefetch.ts` pour des tuiles que l'utilisateur n'a pas
// encore regardées. Elles sont sacrifiables : la prochaine vraie requête Mapbox
// pour la même tuile exécutera le pipeline normalement. Quand le dispatcher DEM
// est déjà saturé (une vraie rafale de premier plan est en cours), on abandonne
// au routeur les requêtes pf=1 ortho / pente / altitude entrantes, pour
// qu'elles n'atteignent jamais la file de chaque handler. C'est le pendant côté
// SW de l'annulation du préchauffage côté navigateur sur geste : si un
// préchauffage périmé échappe à l'annulation sur geste, il ne peut pas affamer
// la rafale de premier plan une fois le pipeline occupé.
//
// Le seuil utilise DEM_INFLIGHT.size comme indicateur de « système en charge ».
// Les quatre familles (DEM / ortho / pente / altitude) finissent toutes par
// peser sur le pipeline DEM (pente / altitude préchauffent 4 DEM voisins,
// l'ortho partage le même pool de connexions HTTP/2 vers geopf).
const PREFETCH_SHED_THRESHOLD = 24;

function isPrefetchRequest(url) {
  return url.searchParams.get('pf') === '1';
}

// ── Appariement DEM ↔ Ortho ──────────────────────────────────────────
// Le pipeline des sources de Mapbox émet les requêtes de tuiles DEM (terrain)
// AVANT les requêtes ortho raster de la même emprise à l'écran : la source de
// terrain est nécessaire aux positions des sommets, elle passe donc en premier.
// À froid, l'utilisateur voit le maillage se préciser avec une texture grise /
// basse résolution, puis l'ortho arrive 200 à 800 ms plus tard — la perception
// classique « DEM d'abord puis ortho ». Avec cet appariement actif (positionné
// par listeners.ts quand le fond satellite est actif), dès que le SW voit une
// vraie requête /dem-tiles (hors préchargement), il lance tout de suite en
// arrière-plan la requête /ortho-tiles correspondante, en priorité haute. Les
// deux pipelines démarrent en même temps ; le multiplexeur H2 de data.geopf.fr
// les sert en parallèle. Quand le fetch ortho de Mapbox arrive quelques
// centaines de ms plus tard, le SW a soit déjà la réponse dans CacheStorage
// (instantané), soit la map de déduplication en cours (`orthoInflight`)
// renvoie la même Promise.
// Coût quand c'est désactivé : nul (l'indicateur court-circuite la branche).
let pairOrthoWithDem = false;

function setPairOrthoWithDem(enabled) {
  pairOrthoWithDem = Boolean(enabled);
}

function maybeKickOrtho(url, z, x, y) {
  if (!pairOrthoWithDem) return;
  if (isPrefetchRequest(url)) return; // pf=1 est déjà spéculatif — pas de doublon
  if (typeof handleOrthoRequest !== 'function') return;
  // Lancé sans attendre. Le résultat arrive dans ORTHO_CACHE_NAME, si bien que
  // le fetch naturel suivant de Mapbox est un succès de cache direct. Erreurs
  // ignorées : le cache négatif est déjà câblé dans handleOrthoRequest.
  try { handleOrthoRequest(z, x, y).catch(() => {}); } catch { /* ignore */ }
}

function noTileResponseRouter(reason) {
  return new Response(null, {
    status: 204,
    headers: { 'X-DEM-Reason': reason },
  });
}

// Même règle que parseTileCoords() dans server/lib/http-security.mjs
// (validation radar) : z entier dans [0, 22], x/y entiers dans [0, 2^z). Tout le
// reste reçoit une 204 avant d'atteindre un handler : des coordonnées
// impossibles ne déclenchent jamais de fetch amont ni n'entrent dans les caches
// (négatifs).
const ROUTER_MAX_TILE_ZOOM = 22;

function parseRouterTileCoords(match) {
  const z = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);
  if (!Number.isInteger(z) || z < 0 || z > ROUTER_MAX_TILE_ZOOM) return null;
  const n = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) return null;
  return { z, x, y };
}

// Les hash de zone sont des chaînes hexadécimales de 8 caractères générées par
// la page (FNV-1a sur l'anneau quantifié — voir analysisZone/lib/geometry.ts).
// Tout le reste est traité comme « pas de zone », pour qu'un paramètre mal
// formé ne puisse jamais empoisonner la clé de cache.
function sanitizeZoneHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{1,16}$/i.test(value) ? value : '';
}

function shedPrefetchIfBusy(url) {
  if (!isPrefetchRequest(url)) return null;
  if (DEM_INFLIGHT.size < PREFETCH_SHED_THRESHOLD) return null;
  return noTileResponseRouter('prefetch-shed');
}

self.addEventListener('fetch', (event) => {
  // Les navigations (barre d'adresse, liens) ne sont jamais servies par le SW :
  // seules les requêtes de tuiles émises par la carte le sont.
  if (event.request.mode === 'navigate') return;

  const url = new URL(event.request.url);
  // Uniquement les routes de tuiles de NOTRE origine.
  if (url.origin !== self.location.origin) return;

  const tileMatch = url.pathname.match(/^\/(?:dem|ortho|vhr|slope|altitude|contour|radar)-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (tileMatch && !parseRouterTileCoords(tileMatch)) {
    event.respondWith(noTileResponseRouter('invalid-coords'));
    return;
  }
  // Passe d'éviction des caches de tuiles au repos (cache-budget.js).
  if (tileMatch) noteMapTileRequest();

  const demMatch = url.pathname.match(/^\/dem-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (demMatch) {
    const dz = parseInt(demMatch[1], 10);
    const dx = parseInt(demMatch[2], 10);
    const dy = parseInt(demMatch[3], 10);
    maybeKickOrtho(url, dz, dx, dy);
    event.respondWith(handleDemRequest(
      event.request,
      dz,
      dx,
      dy,
      undefined,
      resolveDemProfile(url),
    ));
    return;
  }

  const orthoMatch = url.pathname.match(/^\/ortho-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (orthoMatch) {
    const shed = shedPrefetchIfBusy(url);
    if (shed) { event.respondWith(shed); return; }
    event.respondWith(handleOrthoRequest(
      parseInt(orthoMatch[1], 10),
      parseInt(orthoMatch[2], 10),
      parseInt(orthoMatch[3], 10),
    ));
    return;
  }

  // Overlay d'ortho à très haute résolution (fond satellite). `r=2` demande des
  // tuiles de 512 px sur les écrans à haute densité.
  const vhrMatch = url.pathname.match(/^\/vhr-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (vhrMatch) {
    event.respondWith(handleVhrRequest(
      parseInt(vhrMatch[1], 10),
      parseInt(vhrMatch[2], 10),
      parseInt(vhrMatch[3], 10),
      url.searchParams.get('r') === '2',
    ));
    return;
  }

  const slopeMatch = url.pathname.match(/^\/slope-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (slopeMatch) {
    const shed = shedPrefetchIfBusy(url);
    if (shed) { event.respondWith(shed); return; }
    const slopeRes = url.searchParams.get('res') || '';
    const slopeDemProfile = resolveDemProfile(url);
    const rawSourceDem = url.searchParams.get('source-dem') || url.searchParams.get('quality') || '';
    const slopeSourceDem = (rawSourceDem === '30m' || rawSourceDem === 'fast-30m') ? 'fast-30m' : rawSourceDem;
    // Pente limitée à une zone : `?zone=<hash>` désigne le polygone enregistré par
    // SET_ANALYSIS_ZONE — les tuiles hors de celui-ci sont rejetées avant tout fetch DEM.
    const slopeZone = sanitizeZoneHash(url.searchParams.get('zone'));
    event.respondWith(handleSlopeRequest(
      parseInt(slopeMatch[1], 10),
      parseInt(slopeMatch[2], 10),
      parseInt(slopeMatch[3], 10),
      slopeRes,
      slopeDemProfile,
      slopeZone,
      { sourceDem: slopeSourceDem },
    ));
    return;
  }

  const altitudeMatch = url.pathname.match(/^\/altitude-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (altitudeMatch) {
    const shed = shedPrefetchIfBusy(url);
    if (shed) { event.respondWith(shed); return; }
    const altitudeZone = sanitizeZoneHash(url.searchParams.get('zone'));
    event.respondWith(handleAltitudeRequest(
      parseInt(altitudeMatch[1], 10),
      parseInt(altitudeMatch[2], 10),
      parseInt(altitudeMatch[3], 10),
      altitudeZone,
      resolveDemProfile(url),
    ));
    return;
  }

  // Courbes de niveau vectorielles tirées du MNT (contour-handler.js).
  const contourMatch = url.pathname.match(/^\/contour-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (contourMatch) {
    event.respondWith(handleContourRequest(
      parseInt(contourMatch[1], 10),
      parseInt(contourMatch[2], 10),
      parseInt(contourMatch[3], 10),
      resolveDemProfile(url),
    ));
    return;
  }

  const radarMatch = url.pathname.match(/^\/radar-tiles\/(\d+)\/(\d+)\/(\d+)$/);
  if (radarMatch) {
    event.respondWith(handleRadarTileRequest(
      url,
      parseInt(radarMatch[1], 10),
      parseInt(radarMatch[2], 10),
      parseInt(radarMatch[3], 10),
    ));
    return;
  }
});
