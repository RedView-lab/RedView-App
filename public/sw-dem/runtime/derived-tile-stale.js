// ---------------------------------------------------------------------------
// Tuiles dérivées provisoires (pente, altitude) → rechargement de la source côté page
//
// Mapbox traite toute image en 200 comme définitive : une tuile d'overlay
// servie quand son DEM n'était pas encore là (remplaçant, repli sur le parent,
// remplaçant transparent) reste à l'écran jusqu'à ce que la tuile sorte de la
// vue. Le SW ne peut pas pousser une tuile : il prévient donc la page, qui
// recharge la source de cet overlay une fois la carte stabilisée
// (listeners.ts) ; les tuiles complètes reviennent directement du niveau chaud,
// les périmées sont reconstruites.
//
// Deux déclencheurs par suivi :
//   - waitOnDem() : la tuile est reconstruite quand les tuiles DEM qui lui
//     manquent deviennent définitives — le terrain qui les atteint, l'anneau de
//     préchargement, une mise à niveau en arrière-plan. finalize() /
//     l'ordonnanceur de mises à niveau appellent notifyDerivedDemTileReady().
//     Jamais plafonné : chaque tuile DEM n'arrive qu'une fois.
//   - noteStale() : une nouvelle tentative à l'aveugle (rien de précis à
//     attendre), plafonnée par tuile pour qu'une tuile qui ne peut pas
//     s'améliorer n'entretienne pas la boucle de rechargement.
// ---------------------------------------------------------------------------

const DERIVED_STALE_NOTIFY_DEBOUNCE_MS = 700;
const DERIVED_STALE_NOTIFY_MAX_WAIT_MS = 3000;
const DERIVED_STALE_MAX_RETRIES = 3;
const DERIVED_STALE_RETRY_MAX_KEYS = 4096;
const DERIVED_DEM_WAITERS_MAX = 4096;

const DERIVED_TILE_STALE_TRACKERS = [];

function derivedDemWaitKey(demProfile, z, x, y) {
  return `${demProfile || 'default'}:${z}/${x}/${y}`;
}

// `messageType` est le type de postMessage que la page écoute
// (SLOPE_TILES_STALE, ALTITUDE_TILES_STALE).
function createDerivedTileStaleTracker(messageType) {
  const retries = new Map(); // tile key → reloads already asked
  const demWaiters = new Map(); // DEM wait key → Set<tile key>
  let timer = null;
  let firstAt = 0;
  let count = 0;

  function flush() {
    timer = null;
    firstAt = 0;
    const n = count;
    count = 0;
    if (n === 0) return;
    try {
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: messageType, count: n }));
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  function noteStale(tileKey, { capped = true } = {}) {
    if (capped) {
      const n = retries.get(tileKey) || 0;
      if (n >= DERIVED_STALE_MAX_RETRIES) return;
      retries.delete(tileKey);
      retries.set(tileKey, n + 1);
      if (retries.size > DERIVED_STALE_RETRY_MAX_KEYS) {
        retries.delete(retries.keys().next().value);
      }
    }
    count++;
    const now = Date.now();
    if (!firstAt) firstAt = now;
    if (timer) clearTimeout(timer);
    const wait = Math.min(
      DERIVED_STALE_NOTIFY_DEBOUNCE_MS,
      Math.max(0, firstAt + DERIVED_STALE_NOTIFY_MAX_WAIT_MS - now),
    );
    timer = setTimeout(flush, wait);
  }

  function noteFinal(tileKey) {
    retries.delete(tileKey);
  }

  function waitOnDem(tileKey, demProfile, z, tiles) {
    for (const [tx, ty] of tiles) {
      const key = derivedDemWaitKey(demProfile, z, tx, ty);
      let waiting = demWaiters.get(key);
      if (!waiting) {
        if (demWaiters.size >= DERIVED_DEM_WAITERS_MAX) {
          demWaiters.delete(demWaiters.keys().next().value);
        }
        waiting = new Set();
        demWaiters.set(key, waiting);
      }
      waiting.add(tileKey);
    }
  }

  function demTileReady(z, x, y, demProfile) {
    if (demWaiters.size === 0) return;
    const key = derivedDemWaitKey(demProfile, z, x, y);
    const waiting = demWaiters.get(key);
    if (!waiting) return;
    demWaiters.delete(key);
    for (const tileKey of waiting) noteStale(tileKey, { capped: false });
  }

  const tracker = { noteStale, noteFinal, waitOnDem, demTileReady };
  DERIVED_TILE_STALE_TRACKERS.push(tracker);
  return tracker;
}

// Appelé pour chaque tuile DEM enregistrée comme définitive (finalize, mise à niveau en arrière-plan).
function notifyDerivedDemTileReady(z, x, y, demProfile) {
  for (const tracker of DERIVED_TILE_STALE_TRACKERS) {
    tracker.demTileReady(z, x, y, demProfile);
  }
}
