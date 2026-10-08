// ---------------------------------------------------------------------------
// Annulations IGN — abandons des fetchs spéculatifs au début d'un geste, vidage
// et abandon par usage, et tuiles DEM que la carte attend encore (DEM_WANTED_TILES).
// ---------------------------------------------------------------------------

// Abandonne les fetchs IGN spéculatifs en cours au début d'un geste. Les fetchs
// du fond de carte (sans usage) continuent, pour la même raison que
// flushIGNQueue() garde leurs entrées en file ; les requêtes de zone d'analyse
// viennent de l'utilisateur.
function cancelInFlightIGN() {
  if (ignActiveControllers.size === 0) return 0;
  let n = 0;
  for (const c of Array.from(ignActiveControllers)) {
    if (!c._purpose || c._purpose === PURPOSE_SLOPE_ZONE) continue;
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
    ignActiveControllers.delete(c);
  }
  if (DEBUG) console.warn(`[sw-dem][queue] aborted ${n} in-flight IGN fetches on viewport change`);
  return n;
}

// ── Tuiles DEM que la carte attend encore ─────────────────────────────
// Chromium ne propage pas au service worker l'abandon d'un fetch côté page
// (FetchEvent.request.signal ne se déclenche jamais — vérifié sur Edge 154) :
// le SW ne voit donc pas Mapbox abandonner une tuile DEM sortie de la vue. La
// page envoie à la place les tuiles encore en cours pour sa source DEM
// (DEM_WANTED_TILES, `features/map3d/hooks/useMap/controller/demWantedTiles.ts`) :
// un travail associé à une tuile de carte absente de cette liste est périmé et
// abandonné, tout le reste va jusqu'au bout quoi que fasse la caméra.
//
// `sentAt` (Date.now() côté page, même horloge que le SW) protège de la course
// avec les requêtes émises après l'instantané : seul un travail demandé avant
// lui peut être jugé par lui.
let mapWantedDemTiles = null; // { keys: Set<'z/x/y'>, sentAt }

function isMapDemTileWanted(mapTile) {
  if (!mapTile || !mapWantedDemTiles) return true;
  if (mapTile.requestedAt >= mapWantedDemTiles.sentAt) return true;
  return mapWantedDemTiles.keys.has(mapTile.key);
}

// Enregistre l'instantané et abandonne le travail de fond de carte périmé qu'il
// révèle : les entrées en file se résolvent en PRUNED_SENTINEL, les fetchs en
// cours sont annulés avec USER_CANCEL_REASON (sans cache négatif). Renvoie les
// clés des tuiles abandonnées.
function pruneUnwantedMapDemWork(keys, sentAt) {
  if (mapWantedDemTiles && sentAt <= mapWantedDemTiles.sentAt) return [];
  mapWantedDemTiles = { keys, sentAt };
  const dropped = new Set();
  const queues = [ignForegroundQueue, ignSlopeVisibleQueue, ignBackgroundQueue];
  for (const queue of queues) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const entry = queue[i];
      if (!entry.mapTile || isMapDemTileWanted(entry.mapTile)) continue;
      queue.splice(i, 1);
      entry.resolve(PRUNED_SENTINEL);
      dropped.add(entry.mapTile.key);
    }
  }
  for (const c of Array.from(ignActiveControllers)) {
    if (!c._mapTile || isMapDemTileWanted(c._mapTile)) continue;
    try { c.abort(USER_CANCEL_REASON); } catch { /* ignore */ }
    ignActiveControllers.delete(c);
    dropped.add(c._mapTile.key);
  }
  if (dropped.size > 0) {
    ignPrunedTotal += dropped.size;
    drainIGN();
    if (DEBUG) console.warn(`[sw-dem][queue] dropped work of ${dropped.size} DEM tiles the map no longer waits on`);
  }
  return Array.from(dropped);
}

// Vide les entrées IGN en file (pas encore lancées) qui portent un usage donné.
// Renvoie le nombre d'entrées élaguées. Peut s'exécuter en même temps que
// drainIGN — les éléments élagués se résolvent en PRUNED_SENTINEL et leurs
// appelants voient un `null` normal.
function flushIGNQueueByPurpose(purpose) {
  if (!purpose || totalIGNQueueLength() === 0) return 0;
  // Cible la file qui possède cet usage, maintenant que slope-visible a sa
  // propre file, séparée du fond de carte (réécriture à trois niveaux du 20 mai).
  let targetQueue;
  if (isIGNBackgroundPurpose(purpose)) targetQueue = ignBackgroundQueue;
  else if (isIGNSlopeVisiblePurpose(purpose)) targetQueue = ignSlopeVisibleQueue;
  else targetQueue = ignForegroundQueue;
  if (targetQueue.length === 0) return 0;
  let pruned = 0;
  for (let i = targetQueue.length - 1; i >= 0; i--) {
    if (targetQueue[i].purpose === purpose) {
      const stale = targetQueue.splice(i, 1)[0];
      stale.resolve(PRUNED_SENTINEL);
      pruned++;
    }
  }
  if (pruned > 0) ignPrunedTotal += pruned;
  return pruned;
}

// N'annule que les fetchs HTTP IGN marqués avec `purpose`. Utilisé par
// CANCEL_SLOPE_WORK pour libérer tout de suite les créneaux de concurrence du
// WMS terrain quand l'utilisateur désactive la pente à 1 m, au lieu d'attendre
// jusqu'à IGN_FETCH_TIMEOUT_MS que chaque créneau se libère seul (visible comme
// un blocage de plusieurs secondes sur les chargements suivants de tuiles
// satellite / DEM). Le pipeline du fond de carte n'est pas touché : il utilise
// le profil DEM par défaut, qui ne pose jamais d'usage.
function cancelInFlightIGNByPurpose(purpose) {
  const bucket = ignActiveControllersByPurpose.get(purpose);
  if (!bucket || bucket.size === 0) return 0;
  let n = 0;
  for (const c of bucket) {
    try { c.abort(USER_CANCEL_REASON); n++; } catch { /* ignore */ }
    ignActiveControllers.delete(c);
  }
  bucket.clear();
  if (DEBUG && n > 0) console.warn(`[sw-dem][cancel-slope] aborted ${n} in-flight IGN ${purpose} fetches`);
  return n;
}
