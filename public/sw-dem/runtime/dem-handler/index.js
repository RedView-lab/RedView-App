// ---------------------------------------------------------------------------
// Point d'entrée du handler des tuiles DEM — dispatcher de premier niveau pour
// /dem-tiles/{z}/{x}/{y}.
//
// Extrait de runtime/dem-handler.js vers runtime/dem-handler/ (15 mai).
// `computeDemRequest()` vit désormais dans ./compute-request.js ; ce fichier garde
// la surface globale stable `handleDemRequest()` utilisée par router.js,
// slope-handler.js, altitude-handler.js et dem-helpers.js.
// ---------------------------------------------------------------------------

async function handleDemRequest(_request, z, x, y, _depth, demProfile) {
  if (_depth === undefined) _depth = 0;
  if (!demProfile) demProfile = resolveDemProfileFromRequest(_request);

  // Court-circuit à l'échelle du monde : aucun relief de terrain visible sous
  // z4, et à ce zoom les tuiles Mapbox sont de minuscules fractions du globe.
  // Renvoyer 204 tout de suite laisse Mapbox GL réutiliser les maillages
  // parents / vides et empêche le SW de bloquer les fetchs du fond
  // Standard-Satellite par contention sur l'origine pendant un dézoom rapide au
  // pincement (cause du symptôme « Terre blanche »).
  if (z < 4) return noTileResponse('world-zoom');

  // ── Délestage du préchargement spéculatif sous charge ────────────────
  //
  // Les requêtes de préchargement portent `?pf=1` (posé par
  // viewportPrefetch.ts). Elles sont SPÉCULATIVES — les faire échouer en
  // silence est sans conséquence : la prochaine vraie requête Mapbox pour la
  // même tuile exécutera normalement tout le pipeline.
  //
  // Quand le dispatcher est déjà saturé (DEM_INFLIGHT.size au-dessus du plafond
  // souple), on abandonne tout de suite les pf=1 entrants au lieu de les mettre
  // en file derrière ~50 fetchs de sous-tuiles IGN. C'est la défense côté SW
  // qui répond à l'annulation du préchauffage côté navigateur sur geste : même
  // si un lot de préchauffage échappe à l'annulation sur geste, il ne peut pas
  // affamer la rafale de premier plan une fois le pipeline occupé.
  //
  // Justification du seuil : un préchauffage typique de la barre de recherche
  // lance ≤ 14 tuiles + enfants / parents (~20 au plus). La vue visible de
  // Mapbox à z14 inclinée à 60° culmine vers 24 tuiles. Avec un plafond à 24 :
  // si un vrai trafic de premier plan circule, le préchargement s'efface. En
  // dessous de 24 (cache froid, carte au repos), il tourne normalement.
  if (_depth === 0 && _request) {
    let isPrefetch = false;
    try {
      isPrefetch = new URL(_request.url).searchParams.get('pf') === '1';
    } catch { /* ignore */ }
    if (isPrefetch && DEM_INFLIGHT.size >= 24) {
      return noTileResponse('prefetch-shed');
    }
  }

  // ── Fusion des requêtes en cours — au premier niveau seulement. On saute
  // volontairement la déduplication pour les appels récursifs d'overzoom
  // (depth > 0), qui portent leurs propres requêtes d'enfants internes : on ne
  // veut pas d'interblocage en s'attendant soi-même à travers une chaîne de Promise.
  if (_depth === 0) {
    if (isVideoDemTileRequest(_request)) return handleVideoDemRequest(_request, z, x, y, demProfile);
    return coalesceDemRequest(_request, z, x, y, demProfile);
  }

  return computeDemRequest(_request, z, x, y, _depth, demProfile);
}

async function coalesceDemRequest(request, z, x, y, demProfile, options) {
  const inflightKey = `${demProfile}:${z}/${x}/${y}`;
  // Une construction annulée pour son demandeur d'origine (la carte a abandonné
  // la tuile, puis l'a redemandée) n'est pas une réponse pour celui-ci : on
  // rejoint la reconstruction qu'un autre demandeur a peut-être lancée, sinon on
  // la lance.
  const awaited = new Set();
  let existing = DEM_INFLIGHT.get(inflightKey);
  while (existing && !awaited.has(existing)) {
    awaited.add(existing);
    try {
      const shared = await existing;
      const cancelled = shared.status === 204
        && shared.headers.get('X-DEM-Reason') === DEM_CANCELLED_REASON;
      if (!cancelled) return shared.clone();
    } catch { /* on continue et on recalcule */ }
    existing = DEM_INFLIGHT.get(inflightKey);
  }

  const work = computeDemRequest(request, z, x, y, 0, demProfile, options);
  DEM_INFLIGHT.set(inflightKey, work);
  try {
    const response = await work;
    return response.clone();
  } finally {
    // Une construction plus récente peut posséder la clé (DEM_WANTED_TILES a abandonné celle-ci).
    if (DEM_INFLIGHT.get(inflightKey) === work) DEM_INFLIGHT.delete(inflightKey);
  }
}

// ── Export vidéo du survol (`rv-src=video`) ───────────────────────────
// L'export filme une image dès que toutes ses tuiles sont chargées et ne
// recharge jamais une tuile de terrain sur place (flyover/video/videoMap.ts) : un
// remplaçant servi maintenant — overzoom du parent, sol nu ou AWS à 30 m après
// un échec LiDAR passager, une construction partielle dont la mise à niveau est
// encore en cours — resterait dans la vidéo tant que la tuile est à l'écran. Une
// requête vidéo saute donc les remplaçants mis en cache pour la carte en
// direct et, quand la construction sort encore provisoire, la réessaie en
// oubliant les échecs passagers. Borné : une nouvelle tentative ne démarre que
// pendant les VIDEO_DEM_RETRY_START_LIMIT_MS premières millisecondes, pour que
// la réponse (au pire le remplaçant) arrive bien avant l'attente par image de
// l'export (FRAME_SETTLE_TIMEOUT_MS, flyover/video/config.ts) et les limites des
// événements fetch des navigateurs.
const VIDEO_DEM_RETRY_DELAYS_MS = [1_000, 2_500, 5_000, 8_000];
const VIDEO_DEM_RETRY_START_LIMIT_MS = 30_000;
// Les 204 qui sont la réponse de la tuile (pas de relief ici), et non un échec à
// réessayer. Une construction vidéo saute les entrées négatives courtes : son
// `neg-cache` est donc une tuile vide confirmée.
const VIDEO_DEM_FINAL_EMPTY_REASONS = new Set(['world-zoom', 'no-coverage', 'global-parent-mesh', 'neg-cache']);

function isProvisionalVideoDemAnswer(response, z, x, y, demProfile) {
  if (!response) return true;
  if (response.status === 204) {
    return !VIDEO_DEM_FINAL_EMPTY_REASONS.has(response.headers.get('X-DEM-Reason') || '');
  }
  if (response.status !== 200) return true;
  // Remplaçant brièvement en cache (finalize) ou tuile remplacée par le garde-fou de santé.
  if (response.headers.get('x-cache-ttl-ms')) return true;
  if ((response.headers.get('X-DEM-Health') || 'ok').toLowerCase() !== 'ok') return true;
  // Construction IGN partielle : sa mise à niveau en arrière-plan
  // (scheduleBackgroundUpgrade) récupère encore les sous-tuiles manquantes.
  const source = response.headers.get('X-DEM-Source') || '';
  const fullQuality = source.endsWith('+upgrade') || source === 'ign'
    || source.startsWith('ign-fallback-z') || source.startsWith('ign-highres');
  return !fullQuality && pendingUpgrades.has(`${demProfile}:${z}/${x}/${y}`);
}

async function handleVideoDemRequest(request, z, x, y, demProfile) {
  const startedAt = Date.now();
  let response = await coalesceDemRequest(request, z, x, y, demProfile, { finalOnly: true });
  for (const delayMs of VIDEO_DEM_RETRY_DELAYS_MS) {
    if (!isProvisionalVideoDemAnswer(response, z, x, y, demProfile)) return response;
    if (Date.now() - startedAt + delayMs > VIDEO_DEM_RETRY_START_LIMIT_MS) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    forgetTransientWmsFailures(z, x, y);
    response = await coalesceDemRequest(request, z, x, y, demProfile, { finalOnly: true });
  }
  if (isProvisionalVideoDemAnswer(response, z, x, y, demProfile) && typeof swLog !== 'undefined') {
    swLog.warn(
      'dispatch',
      `video ${z}/${x}/${y}: still provisional after ${((Date.now() - startedAt) / 1000).toFixed(1)} s (${response?.headers.get('X-DEM-Source') || response?.headers.get('X-DEM-Reason') || response?.status})`,
    );
  }
  return response;
}
