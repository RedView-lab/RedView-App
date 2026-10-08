// ---------------------------------------------------------------------------
// Cycle de vie du SW
//
// Extrait de sw-dem.js (3 mai) pour garder le point d'entrée comme simple
// chargeur et donner à chaque partie du pipeline son propre fichier
// débogable. Ce fichier gère :
//   - les noms des caches de carte gérés (purge à l'activation / messages PURGE)
//   - le routage statique (événement fetch seulement pour les familles de tuiles)
//   - install / activate / message (skipWaiting, claim, invalidation manuelle des caches)
// Les caches chauds sont dans hot-caches.js ; le limiteur de composition, les
// files de construction et SLOPE_INFLIGHT / ALTITUDE_INFLIGHT / DEM_INFLIGHT dans
// build-queues.js.
// ---------------------------------------------------------------------------

const MAP_CACHE_PREFIXES = [
  'dem-tiles-',
  'dem-negative-',
  'ortho-tiles-',
  'vhr-tiles-',
  'slope-tiles-',
  'altitude-tiles-',
  'shadow-tiles-',
  'dem-static-',
];

const CURRENT_MAP_CACHE_NAMES = new Set([
  CACHE_NAME,
  NEGATIVE_CACHE_NAME,
  ORTHO_CACHE_NAME,
  VHR_CACHE_NAME,
  SLOPE_CACHE_NAME,
  ALTITUDE_CACHE_NAME,
  STATIC_CACHE_NAME,
]);

function isManagedMapCacheName(cacheName) {
  return MAP_CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
}

function purgeManagedMapCaches({ includeCurrent = false } = {}) {
  return caches.keys().then((keys) => Promise.all(
    keys
      .filter((cacheName) => isManagedMapCacheName(cacheName))
      .filter((cacheName) => includeCurrent || !CURRENT_MAP_CACHE_NAMES.has(cacheName))
      .map((cacheName) => caches.delete(cacheName))
  ));
}

// ── Routage statique (Static Routing API du Service Worker, Chrome/Edge 123+) ──
// router.js ne répond qu'aux six familles de tuiles ci-dessous ; toute autre
// requête (tuiles satellite / vectorielles Mapbox, sprites, glyphes, appels
// d'API, ressources de l'app) part au réseau. Sans routes, le navigateur
// envoie quand même chacune d'elles d'abord au fil du SW — si bien que, pendant
// que le SW construit une tuile DEM à 0,40 m ou redémarre après un arrêt pour
// inactivité (~45 importScripts), l'imagerie satellite attend derrière. Déclarer
// le même partage en routes statiques laisse le navigateur les envoyer
// directement au réseau. Même comportement qu'aujourd'hui ; les navigateurs
// sans cette API (Safari, Firefox) l'ignorent. Ne doit jamais faire échouer
// l'installation (voir le commentaire plus bas).
const SW_FETCH_EVENT_PATHS = [
  '/dem-tiles/*',
  '/ortho-tiles/*',
  '/vhr-tiles/*',
  '/slope-tiles/*',
  '/altitude-tiles/*',
  '/radar-tiles/*',
];

function registerStaticRoutes(e) {
  if (typeof e.addRoutes !== 'function' || typeof URLPattern !== 'function') {
    return Promise.resolve();
  }
  try {
    const routes = SW_FETCH_EVENT_PATHS.map((pathname) => ({
      condition: { urlPattern: new URLPattern({ pathname }) },
      source: 'fetch-event',
    }));
    routes.push({ condition: { urlPattern: new URLPattern({}) }, source: 'network' });
    return Promise.resolve(e.addRoutes(routes)).catch((err) => {
      console.warn('[sw-dem] install: static routes rejected (non-fatal):', err);
    });
  } catch (err) {
    console.warn('[sw-dem] install: static routes unavailable (non-fatal):', err);
    return Promise.resolve();
  }
}

self.addEventListener('install', (e) => {
  const staticRoutes = registerStaticRoutes(e);
  // CRITIQUE : l'installation ne doit JAMAIS dépendre d'un fetch réseau.
  // `cache.add()` rejette au moindre hoquet passager (hors ligne, 5xx, proxy
  // lent) ou sur une réponse non ok pour /france-border.json. Si l'installation
  // échoue, le SW devient redondant → activate / clients.claim() ne s'exécutent
  // jamais → aucun contrôleur de toute la session → les overlays DEM, pente ET
  // altitude se bloquent en silence (ils dépendent tous du SW pour servir leurs
  // tuiles). Le polygone de la France ne sert qu'au découpage de l'ortho et est
  // de toute façon chargé à la demande par ensureFrancePoly() : un échec du
  // préchargement n'est pas fatal.
  e.waitUntil(
    staticRoutes
      .then(() => caches.open(STATIC_CACHE_NAME))
      .then((cache) => cache.add('/france-border.json'))
      .then(() => ensureFrancePoly())
      .catch((err) => {
        console.warn('[sw-dem] install: france-border.json prefetch failed (non-fatal, loaded lazily later):', err);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // clients.claim() est ce qui déclenche `controllerchange` sur la page et
  // réveille le pipeline DEM / pente / altitude. Il doit s'exécuter même si la
  // purge des caches échoue, sinon une erreur de CacheStorage laisserait la page
  // sans contrôleur (même mécanisme d'échec qu'une installation rejetée).
  e.waitUntil(
    purgeManagedMapCaches()
      .catch((err) => {
        console.warn('[sw-dem] activate: managed cache purge failed (non-fatal):', err);
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  // Une page rechargée de force (Ctrl+Maj+R) n'est jamais contrôlée, même si ce
  // worker est déjà actif — activate (et son clients.claim()) ne se relancent
  // pas. La page le demande explicitement au lieu de rester sur le repli à 30 m
  // (et d'interroger le serveur pour chaque tuile) jusqu'à une réinstallation.
  if (e.data?.type === 'CLAIM_CLIENTS') {
    e.waitUntil(self.clients.claim());
    return;
  }
  if (e.data?.type === 'SET_VIEWPORT_CENTER') {
    try {
      if (typeof setIGNViewportCenter === 'function') {
        setIGNViewportCenter(e.data.center);
      }
    } catch { /* ignore */ }
    return;
  }
  // Bascule d'appariement DEM ↔ Ortho. Positionnée par listeners.ts quand le
  // fond satellite est monté / retiré. Voir router.js > maybeKickOrtho pour la
  // justification. Idempotente.
  if (e.data?.type === 'SET_PAIR_ORTHO_WITH_DEM') {
    try {
      if (typeof setPairOrthoWithDem === 'function') {
        setPairOrthoWithDem(Boolean(e.data.enabled));
      }
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'PURGE_MAP_CACHES') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { demHotClear(); } catch { /* ignore */ }
    try { slopeHotClear(); } catch { /* ignore */ }
    try { altitudeHotClear(); } catch { /* ignore */ }
    try { orthoHotClear(); } catch { /* ignore */ }
    try { vhrHotClear(); } catch { /* ignore */ }
    purgeManagedMapCaches({ includeCurrent: true });
    return;
  }
  if (e.data?.type === 'CLEAR_DEM_CACHE') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { demHotClear(); } catch { /* ignore */ }
    try { slopeHotClear(); } catch { /* ignore */ }
    try { altitudeHotClear(); } catch { /* ignore */ }
    try { orthoHotClear(); } catch { /* ignore */ }
    caches.delete(CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SLOPE_CACHE') {
    try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
    try { slopeHotClear(); } catch { /* ignore */ }
    caches.delete(SLOPE_CACHE_NAME);
    return;
  }
  // Changement d'état actif pente / altitude — agrandit / réduit le niveau chaud
  // des DEM, pour qu'un déplacement avec pente ou altitude actives (qui lit plus
  // de tuiles DEM que le fond de carte) n'évince pas des tuiles DEM du fond de
  // carte que l'utilisateur redemandera à l'image suivante. Envoyé par useSlope /
  // useAltitude à l'activation / la désactivation. Idempotent.
  if (e.data?.type === 'SLOPE_ACTIVE_STATE') {
    try {
      _slopeActive = Boolean(e.data.active);
      syncDemHotCacheCapacity();
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'ALTITUDE_ACTIVE_STATE') {
    try {
      _altitudeActive = Boolean(e.data.active);
      syncDemHotCacheCapacity();
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'SET_SW_LOG_LEVEL') {
    if (typeof swLog !== 'undefined' && e.data.level) {
      swLog.setLevel(e.data.level);
      if (typeof DEBUG !== 'undefined') {
        DEBUG = swLog.isDebug();
      }
      swLog.info('lifecycle', `log level set to ${e.data.level} (numeric=${swLog.getLevel()})`);
    }
    return;
  }
  if (e.data?.type === 'CANCEL_SLOPE_WORK') {
    if (typeof activeZonePipeline !== 'undefined' && activeZonePipeline) {
      activeZonePipeline.cancelled = true;
    }
    const cancelled = cancelSlopeWork();
    if (DEBUG && cancelled.slopeCount > 0) {
      console.warn(`[sw-dem][cancel-slope] slopeCount=${cancelled.slopeCount}`);
    }
    return;
  }
  if (e.data?.type === 'START_ZONE_SLOPE_PIPELINE') {
    const tiles = Array.isArray(e.data.tiles) ? e.data.tiles : [];
    const profile = e.data.profile === 'terrain' ? 'terrain' : 'default';
    const zone = typeof e.data.zone === 'string' ? e.data.zone : '';
    if (zone && e.data.ring && typeof registerAnalysisZone === 'function') {
      try { registerAnalysisZone(zone, e.data.ring); } catch { /* ignore */ }
    }
    if (tiles.length === 0) return;
    try {
      if (typeof startZoneSlopeMultiFetch === 'function') {
        startZoneSlopeMultiFetch(tiles, profile, zone);
      }
    } catch { /* au mieux */ }
    return;
  }
  if (e.data?.type === 'PURGE_SLOPE_CACHE') {
    const zone = typeof e.data.zone === 'string' ? e.data.zone : '';
    if (typeof purgeSlopeCache === 'function') {
      purgeSlopeCache(zone).catch(() => {});
    }
    return;
  }
  if (e.data?.type === 'CANCEL_ALTITUDE_WORK') {
    const cancelled = cancelAltitudeWork();
    if (DEBUG && (cancelled.altitudeCount > 0 || cancelled.poolCancelled > 0)) {
      console.warn(`[sw-dem][cancel-altitude] altitude=${cancelled.altitudeCount} pool=${cancelled.poolCancelled}`);
    }
    return;
  }
  if (e.data?.type === 'CLEAR_ALTITUDE_CACHE') {
    try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
    try { altitudeHotClear(); } catch { /* ignore */ }
    caches.delete(ALTITUDE_CACHE_NAME);
    return;
  }
  if (e.data?.type === 'CLEAR_SHADOW_CACHE') {
    // Point d'accès retiré — gardé pour la compatibilité avec un build client
    // encore en circulation qui enverrait le message.
    caches.delete('shadow-tiles-v1');
    return;
  }
  if (e.data?.type === 'CLEAR_NEGATIVE_CACHE') {
    caches.delete(NEGATIVE_CACHE_NAME);
    return;
  }
  // Vide les fetchs IGN spéculatifs et les fetchs ortho en file ET annule leurs
  // requêtes HTTP en cours à chaque geste de l'utilisateur (zoomstart /
  // movestart), pour que la rafale de la nouvelle vue n'attende pas que le
  // travail spéculatif de la vue précédente libère les créneaux IGN. Les
  // contrôleurs annulables portent USER_CANCEL_REASON, pour que les
  // gestionnaires d'erreur de chaque fetch sautent le cache négatif des tuiles
  // que NOUS venons de tuer.
  //
  // Le travail DEM du fond de carte n'est pas touché (voir flushIGNQueue) : le
  // début d'un geste ne dit pas de quelles tuiles de terrain la carte a encore
  // besoin, et les tuer transformait les tuiles à l'écran en replis à 30 m / MNS
  // de corrélation. Les périmées sont abandonnées par DEM_WANTED_TILES plus bas.
  // DEM_INFLIGHT est gardé aussi : les constructions en cours sont désormais les
  // vraies tuiles, et valent la peine qu'on s'y greffe.
  if (e.data?.type === 'CANCEL_STALE_DEM') {
    let ignQ = 0, ignF = 0, orthoQ = 0, orthoF = 0;
    try { ignQ = typeof flushIGNQueue === 'function' ? flushIGNQueue() : 0; } catch { /* ignore */ }
    try { ignF = typeof cancelInFlightIGN === 'function' ? cancelInFlightIGN() : 0; } catch { /* ignore */ }
    try { orthoQ = typeof flushOrthoQueue === 'function' ? flushOrthoQueue() : 0; } catch { /* ignore */ }
    try { orthoF = typeof cancelInFlightOrtho === 'function' ? cancelInFlightOrtho() : 0; } catch { /* ignore */ }
    if (DEBUG && (ignQ + ignF + orthoQ + orthoF) > 0) {
      console.warn(
        `[sw-dem][cancel-stale] ign queued=${ignQ} inflight=${ignF}, ortho queued=${orthoQ} inflight=${orthoF}`,
      );
    }
    return;
  }
  // Tuiles DEM que la source de terrain de la carte attend encore, envoyées
  // pendant que la caméra bouge
  // (features/map3d/hooks/useMap/controller/demWantedTiles.ts). Le travail pour
  // les autres tuiles de la carte est périmé : on l'abandonne, et on oublie ses
  // constructions pour qu'une demande ultérieure d'une de ces tuiles reparte de zéro.
  if (e.data?.type === 'DEM_WANTED_TILES') {
    const keys = Array.isArray(e.data.keys)
      ? e.data.keys.filter((key) => typeof key === 'string')
      : null;
    const sentAt = Number(e.data.sentAt);
    if (!keys || !Number.isFinite(sentAt) || typeof pruneUnwantedMapDemWork !== 'function') return;
    try {
      const dropped = pruneUnwantedMapDemWork(new Set(keys), sentAt);
      for (const key of dropped) {
        DEM_INFLIGHT.delete(`default:${key}`);
        DEM_INFLIGHT.delete(`terrain:${key}`);
      }
    } catch { /* ignore */ }
    return;
  }
  // Invalidation par tuile des caches dérivés pente + altitude. Envoyé par le
  // contrôleur de carte après que le service worker DEM a mis à niveau une tuile
  // DEM vers une meilleure qualité (p. ex. HIGHRES France qui arrive en cours de
  // session). Sans cela, les PNG de pente / altitude en cache dans le SW encodent
  // encore l'ancien DEM de faible qualité, et l'utilisateur voit des pentes /
  // altitudes périmées même après la mise à niveau de la tuile DEM — les
  // « délais » qu'il signale.
  if (e.data?.type === 'INVALIDATE_DERIVED_TILE') {
    const z = e.data.z | 0;
    const x = e.data.x | 0;
    const y = e.data.y | 0;
    if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    try { if (typeof invalidateSlopeProcessingTile === 'function') invalidateSlopeProcessingTile(z, x, y); } catch { /* ignore */ }
    try { if (typeof invalidateAltitudeProcessingTile === 'function') invalidateAltitudeProcessingTile(z, x, y); } catch { /* ignore */ }
    const max = (1 << z) - 1;
    const slopeTiles = [
      [x, y],
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ].filter(([tx, ty]) => tx >= 0 && ty >= 0 && tx <= max && ty <= max);
    // Le niveau chaud est devant CacheStorage : sans cela, le rechargement qui
    // suit (listeners.ts) récupérait la tuile de pente d'avant la mise à niveau.
    for (const [tx, ty] of slopeTiles) slopeHotDeleteTile(z, tx, ty);
    const altitudeTilePath = `/altitude-tiles/${z}/${x}/${y}`;
    Promise.all([
      caches.open(SLOPE_CACHE_NAME).then((cache) => cache.keys().then((keys) => {
        return Promise.all(keys
          .filter((req) => {
            try {
              const path = new URL(req.url).pathname;
              return slopeTiles.some(([tx, ty]) => path === `/slope-tiles/${z}/${tx}/${ty}`);
            }
            catch { return false; }
          })
          .map((req) => cache.delete(req)));
      })),
      caches.open(ALTITUDE_CACHE_NAME).then((cache) => cache.keys().then((keys) => {
        return Promise.all(keys
          .filter((req) => {
            try { return new URL(req.url).pathname === altitudeTilePath; }
            catch { return false; }
          })
          .map((req) => cache.delete(req)));
      })),
    ]).catch(() => { /* au mieux */ });
    return;
  }
  // ── Préchauffage des pentes entre profils / sur la vue (multicœur 2026-06-20) ──
  // La page envoie ce message (a) quand l'utilisateur change de résolution
  // (0,40 m ↔ 1 m), pour que les tuiles de pente de l'AUTRE profil soient
  // construites en arrière-plan pendant qu'il regarde encore l'actuel, et (b) en
  // période d'inactivité, pour préchauffer au passage l'anneau de pente visible.
  // Le travail tourne en priorité slope-warm (déjà isolée du trafic IGN du fond
  // de carte) et est annulé par le CANCEL_SLOPE_WORK suivant si la vue bouge.
  //
  // `profile` : 'default' | 'terrain' — le demProfile sur lequel construire.
  // `tiles` : [{z,x,y}, ...] — tuiles de la vue à préchauffer.
  if (e.data?.type === 'PREWARM_SLOPE') {
    const tiles = Array.isArray(e.data.tiles) ? e.data.tiles : [];
    const profile = e.data.profile === 'terrain' ? 'terrain' : 'default';
    const zone = typeof e.data.zone === 'string' ? e.data.zone : '';
    if (tiles.length === 0) return;
    try {
      if (typeof prewarmSlopeTiles === 'function') prewarmSlopeTiles(tiles, profile, zone);
    } catch { /* au mieux */ }
    return;
  }
  // ── Zone d'analyse (overlays de terrain limités à une zone) ─────────
  // La page enregistre le polygone derrière les requêtes de tuiles `?zone=<hash>`.
  // Renvoyé à chaque controllerchange (le registre meurt avec l'instance du SW).
  // Un hash inconnu dans une URL de tuile retombe sur une construction non
  // masquée — jamais une erreur —, donc une course au redémarrage ne coûte que
  // la précision du découpage, pas des tuiles.
  if (e.data?.type === 'SET_ANALYSIS_ZONE') {
    try {
      const registered = registerAnalysisZone(e.data.hash, e.data.ring);
      if (!registered && e.data.hash) {
        console.warn('[sw-dem] SET_ANALYSIS_ZONE: invalid ring ignored', e.data.hash);
      }
    } catch { /* ignore */ }
    return;
  }
  if (e.data?.type === 'CLEAR_ANALYSIS_ZONE') {
    try { clearAnalysisZones(); } catch { /* ignore */ }
    return;
  }
});
