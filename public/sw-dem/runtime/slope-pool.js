// ---------------------------------------------------------------------------
// POOL de workers pente + altitude — gestionnaire côté SW des workers de
// construction dédiés (un seul pool partagé sert LES DEUX overlays).
//
// Crée `min(hardwareConcurrency-1, SLOPE_POOL_MAX_WORKERS)` Workers dédiés
// (chacun exécute slope-pool.worker.js). Un pool PARTAGÉ (plutôt qu'un pool par
// overlay) plafonne le nombre total de workers au budget matériel — deux pools
// indépendants de 8 chacun surchargeraient une machine à 8 cœurs et
// s'emmêleraient quand les deux overlays sont actifs. Chaque tâche est marquée
// `kind: 'slope' | 'altitude'`, pour qu'une annulation sur un overlay ne tue
// jamais les tâches en cours de l'autre.
//
// Expose deux points d'entrée asynchrones :
//   * computeSlopeViaPool(...)    — DEM propre + jusqu'à 4 DEM voisins → PNG de pente
//   * computeAltitudeViaPool(...) — DEM propre seulement → PNG d'altitude
// Les deux :
//   1. prennent les blobs DEM déjà résolus par l'appelant (les voisins de pente
//      viennent de resolveSlopeNeighbourDems() dans slope-lidar-dem.js),
//   2. TRANSFÈRENT les octets PNG bruts à un worker libre — le worker les décode
//      lui-même, donc la lourde boucle createImageBitmap + getImageData +
//      Float32 tourne HORS du fil du SW,
//   3. attendent l'ArrayBuffer PNG transférable,
//   4. annulent les tâches en attente (par type) quand la cancelGeneration
//      correspondante change.
//
// Renvoie `null` si le pool est indisponible ou si la tâche a été annulée — les
// appelants (slope-handler.js / altitude-handler.js) retombent alors sur le
// chemin du processus courant.
//
// Le pool est créé à la première utilisation et recréé à la demande si un
// worker plante (les workers coûtent peu, ~5 ms à créer). Si le navigateur ne
// permet pas de créer un `Worker` depuis un ServiceWorker (rare, Firefox < 105),
// chaque appel renvoie `null` de façon transparente et le chemin du processus
// courant s'exécute.
//
// SLOPE_POOL_MAX_WORKERS / SLOPE_POOL_MIN_WORKERS sont définis dans
// /sw-dem/core/config.js (chargé plus tôt dans la chaîne d'importScripts de
// sw-dem.js). On les référence ici par leur nom global au lieu de les redéclarer.
// ---------------------------------------------------------------------------

// État interne du pool. Vit au niveau du module pour que le SW réutilise un seul
// pool pour toutes les requêtes de pente / d'altitude.
let _slopeWorkers = null;            // Worker[]
let _slopeWorkerReady = null;        // boolean[] — le worker a accepté au moins une tâche
let _slopeWorkerMonotonic = 0;       // compteur à tour de rôle
let _slopePoolDisabled = false;      // passe à true après une défaillance structurelle
// id → { resolve, reject, kind, workerIdx } — `kind` permet de n'annuler qu'un seul overlay.
const _slopeJobCallbacks = new Map();
const _workerActiveJobs = new Map(); // indice du worker → nombre de tâches actives
let _slopeJobMonotonic = 0;

// ── Porte de concurrence du travail préalable ─────────────────────────
// Avant d'atteindre un worker, une tâche demande du travail sur le fil du SW :
// décoder le DEM propre + lire / décoder jusqu'à 4 DEM voisins dans
// CacheStorage. Sans porte, une vue de 90 tuiles déclenche 90 événements
// handleSlopeRequest() d'un coup, chacun avec sa rafale de décodage en
// parallèle — la boucle d'événements du SW sature et le pipeline de fetch DEM /
// ortho du fond de carte se bloque pendant la première seconde et plus de chaque
// zoom (« la carte gèle quand les pentes sont actives »). Comme le pool de
// workers n'a de toute façon que `poolSize` cœurs, tout ce qui dépasse
// `poolSize + 2` travaux préalables en cours ne fait que s'empiler dans le cache
// de décodage sans atteindre un worker plus tôt. Ce sémaphore plafonne les
// rafales de décodage simultanées côté SW, pour que le fil du SW reste réactif
// pour les fetchs du fond de carte dans l'intervalle.
let _slopePreWorkActive = 0;
const _slopePreWorkQueue = [];

function slopePreWorkConcurrency() {
  // Le travail sur le fil du SW par créneau se réduit désormais à des lectures
  // CacheStorage + un postMessage (pas de décodage de DEM — il est passé dans le
  // worker). C'est surtout lié aux E/S : on peut donc ouvrir plus de créneaux en
  // parallèle qu'il n'y a de workers sans saturer la boucle d'événements du SW.
  // 2× le nombre de workers garde les workers alimentés pendant que le SW
  // enchaîne la série suivante de lectures de cache. Repli sur 6 quand le pool
  // n'est pas encore dimensionné.
  if (_slopeWorkers && _slopeWorkers.length > 0) return _slopeWorkers.length * 2;
  return 6;
}

function acquireSlopePreWork() {
  if (_slopePreWorkActive < slopePreWorkConcurrency()) {
    _slopePreWorkActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _slopePreWorkQueue.push(resolve));
}

function releaseSlopePreWork() {
  _slopePreWorkActive = Math.max(0, _slopePreWorkActive - 1);
  if (_slopePreWorkQueue.length > 0 && _slopePreWorkActive < slopePreWorkConcurrency()) {
    _slopePreWorkActive++;
    _slopePreWorkQueue.shift()();
  }
}

function detectSlopePoolSize() {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 0) return SLOPE_POOL_MIN_WORKERS;
  // Réserve un cœur au fil du SW (réseau + cache + ordonnanceur IGN).
  const target = Math.max(SLOPE_POOL_MIN_WORKERS, Math.min(SLOPE_POOL_MAX_WORKERS, hc - 1));
  return target;
}

function slopePoolWorkerURL() {
  const epoch = (typeof swModuleEpoch !== 'undefined' && swModuleEpoch)
    ? swModuleEpoch
    : (new URL(self.location.href).searchParams.get('rv-map-cache-epoch') || 'base');
  return `/sw-dem/workers/slope-pool.worker.js?rv-map-cache-epoch=${encodeURIComponent(epoch)}`;
}

function spawnSlopeWorker() {
  try {
    const worker = new Worker(slopePoolWorkerURL());
    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      const cb = _slopeJobCallbacks.get(msg.id);
      if (!cb) return;
      _slopeJobCallbacks.delete(msg.id);
      if (typeof cb.workerIdx === 'number') {
        const c = _workerActiveJobs.get(cb.workerIdx) || 0;
        _workerActiveJobs.set(cb.workerIdx, Math.max(0, c - 1));
      }
      if (msg.ok) {
        if (cb.kind === 'altitude') {
          // Les tâches d'altitude renvoient un seul ArrayBuffer PNG, sans voisins.
          cb.resolve({ png: msg.png });
        } else {
          cb.resolve({ png: msg.png, missingDirections: msg.missingDirections || [] });
        }
      } else {
        cb.reject(new Error(`slope-worker: ${msg.error || 'unknown'}`));
      }
    };
    worker.onerror = (err) => {
      if (typeof DEBUG !== 'undefined' && DEBUG) console.warn('[slope-pool] worker error', err?.message || err);
      // Fait échouer toutes les tâches en cours sur ce worker — elles ne peuvent pas aboutir.
      for (const [id, cb] of _slopeJobCallbacks) {
        _slopeJobCallbacks.delete(id);
        cb.reject(new Error('slope-worker-died'));
      }
      _workerActiveJobs.clear();
    };
    return worker;
  } catch (err) {
    if (typeof DEBUG !== 'undefined' && DEBUG) console.warn('[slope-pool] spawn failed, pool disabled', err?.message || err);
    return null;
  }
}

function ensureSlopePool() {
  if (_slopePoolDisabled) return null;
  if (_slopeWorkers && _slopeWorkers.length > 0) return _slopeWorkers;

  if (typeof Worker === 'undefined') {
    _slopePoolDisabled = true;
    return null;
  }

  const size = detectSlopePoolSize();
  const workers = [];
  for (let i = 0; i < size; i++) {
    const w = spawnSlopeWorker();
    if (!w) {
      _slopePoolDisabled = true;
      // Démonte les workers lancés à moitié.
      for (const partial of workers) {
        try { partial.terminate(); } catch { /* ignore */ }
      }
      return null;
    }
    workers.push(w);
  }
  _slopeWorkers = workers;
  _slopeWorkerReady = workers.map(() => false);
  _slopeWorkerMonotonic = 0;
  return workers;
}

function pickSlopeWorker() {
  if (!_slopeWorkers || _slopeWorkers.length === 0) return -1;
  // Envoi au moins chargé : on choisit le worker qui a le moins de tâches actives
  let minIdx = 0;
  let minCount = _workerActiveJobs.get(0) || 0;
  for (let i = 1; i < _slopeWorkers.length; i++) {
    const c = _workerActiveJobs.get(i) || 0;
    if (c < minCount) {
      minCount = c;
      minIdx = i;
    }
  }
  _workerActiveJobs.set(minIdx, minCount + 1);
  return minIdx;
}

function terminateSlopePool() {
  if (!_slopeWorkers) return;
  for (const w of _slopeWorkers) {
    try { w.terminate(); } catch { /* ignore */ }
  }
  _slopeWorkers = null;
  _slopeWorkerReady = null;
  _workerActiveJobs.clear();
  for (const [, cb] of _slopeJobCallbacks) cb.reject(new Error('slope-pool-terminated'));
  _slopeJobCallbacks.clear();
}

// ── Gestion des annulations (par type) ────────────────────────────────
// Appelée depuis build-queues.js quand slopeCancelGeneration /
// altitudeCancelGeneration change. On ne peut pas interrompre un worker en
// pleine tâche, mais on PEUT abandonner tous les callbacks en attente de ce
// type, pour que l'appelant côté SW voie l'annulation et renvoie une tuile
// transparente. Le worker termine sa tâche en cours en arrière-plan ; le
// résultat est simplement ignoré (son callback n'existe plus). Les tâches de
// l'AUTRE overlay ne sont pas touchées — une annulation ne doit jamais passer
// d'un overlay à l'autre (désactiver la pente ne doit pas tuer des
// constructions d'altitude que l'utilisateur veut encore).
function cancelPoolJobsByKind(kind) {
  let n = 0;
  for (const [id, cb] of _slopeJobCallbacks) {
    if (cb.kind !== kind) continue;
    if (cb.uncancellable) continue;
    _slopeJobCallbacks.delete(id);
    if (typeof cb.workerIdx === 'number') {
      const c = _workerActiveJobs.get(cb.workerIdx) || 0;
      _workerActiveJobs.set(cb.workerIdx, Math.max(0, c - 1));
    }
    cb.resolve(null); // null == « annulé » — l'appelant le traite comme transparent
    n++;
  }
  return n;
}

function cancelAllSlopePoolJobs() {
  return cancelPoolJobsByKind('slope');
}

function cancelAllAltitudePoolJobs() {
  return cancelPoolJobsByKind('altitude');
}

// ── Entrée publique : calculer une tuile de pente via le pool ─────────
//
//   demBlob         blob de la tuile DEM propre
//   neighbourBlobs  blobs DEM { north, east, south, west } déjà résolus par
//                   resolveSlopeNeighbourDems() (null quand absents)
//   z, x, y         coordonnées de la tuile
//   resFactor       1 = normal, > 1 = ancienne moyenne par blocs
//   generation      instantané de slopeCancelGeneration, ou null (non annulable)
//   zoneRing        anneau optionnel [[lng, lat], …] de la zone d'analyse
//   outputScale     1 = résolution native du DEM, 2 = Catmull-Rom 2×
//
// Renvoie { blob, missingDirections } — ou null quand le pool est indisponible
// ou la tâche annulée ; l'appelant exécute alors le chemin du processus courant.
//
// Travail sur le fil du SW : un arrayBuffer() par blob + un postMessage. Le
// décodage, Horn, le suréchantillonnage et l'encodage PNG tournent dans le worker.
async function computeSlopeViaPool(demBlob, neighbourBlobs, z, x, y, resFactor, generation, zoneRing, outputScale = 1) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  const isCancelled = () => generation !== null && generation !== undefined && typeof slopeCancelGeneration !== 'undefined' && generation !== slopeCancelGeneration;
  if (isCancelled()) return null;

  await acquireSlopePreWork();
  // Libéré une seule fois, juste après le transfert ou sur une sortie anticipée
  // (une seconde libération distribuait un créneau de trop par tuile).
  let preWorkHeld = true;
  const releasePreWork = () => {
    if (!preWorkHeld) return;
    preWorkHeld = false;
    releaseSlopePreWork();
  };
  try {
    if (isCancelled()) return null;

    // Octets propres + voisins, tous TRANSFÉRÉS (sans copie) au worker.
    const directions = ['north', 'east', 'south', 'west'];
    let ownDemBuf;
    let neighbourBufs;
    try {
      [ownDemBuf, ...neighbourBufs] = await Promise.all([
        demBlob.arrayBuffer(),
        ...directions.map((dir) => (neighbourBlobs?.[dir] ? neighbourBlobs[dir].arrayBuffer() : null)),
      ]);
    } catch {
      return null;
    }
    if (isCancelled()) return null;

    const transferList = [ownDemBuf];
    const neighbourMsg = {};
    directions.forEach((dir, i) => {
      if (!neighbourBufs[i]) return;
      neighbourMsg[dir] = neighbourBufs[i];
      transferList.push(neighbourBufs[i]);
    });

    const workerIdx = pickSlopeWorker();
    if (workerIdx < 0) return null;
    const worker = workers[workerIdx];

    const id = ++_slopeJobMonotonic;
    const jobPromise = new Promise((resolve, reject) => {
      _slopeJobCallbacks.set(id, {
        resolve,
        reject,
        kind: 'slope',
        workerIdx,
        uncancellable: generation === null || generation === undefined,
      });
    });

    worker.postMessage(
      {
        id, kind: 'slope', z, x, y,
        resFactor: Number(resFactor) > 1 ? Number(resFactor) : 1,
        outputScale: outputScale >= 2 ? 2 : 1,
        ownDem: ownDemBuf,
        neighbours: neighbourMsg,
        zoneRing: zoneRing || null,
      },
      transferList,
    );

    // Les tampons sont partis : on libère le créneau de travail préalable pendant que le worker calcule.
    releasePreWork();

    let result;
    try {
      result = await jobPromise;
    } catch {
      return null;
    }
    if (!result || isCancelled()) return null;

    return {
      blob: new Blob([result.png], { type: 'image/png' }),
      missingDirections: result.missingDirections || [],
    };
  } finally {
    releasePreWork();
  }
}

// Points d'accroche exposés à build-queues.js pour l'annulation / l'arrêt.
// (Simples déclarations de fonctions — ces fichiers sont chargés par
// importScripts dans la portée globale du SW, ils sont donc déjà globaux ; les
// références ci-dessous rendent juste l'intention explicite pour le lecteur.)

// ── Entrée altitude : calculer une tuile d'altitude via le pool ──────────
//
//   demBlob        blob de la tuile DEM propre (déjà récupéré et en cache)
//   z, x, y        coordonnées de la tuile
//   generation     instantané d'altitudeCancelGeneration — la tâche s'annule
//                  d'elle-même s'il ne correspond plus quand le worker répond.
//   zoneRing       anneau optionnel [[lng, lat], …] de la zone d'analyse (masque alpha)
//
// Renvoie :
//   { blob: Blob } — PNG d'altitude prêt à envelopper dans une Response
//   null — annulée (génération différente) ou pool indisponible ; l'appelant
//          DOIT retomber sur le chemin buildAltitudeTile() du processus courant.
//
// L'altitude n'a besoin que de son PROPRE DEM (pas de voisins pour les
// jointures) : le travail sur le fil du SW par tâche est minimal, un
// arrayBuffer() + un postMessage. On passe quand même par une porte, pour
// qu'une vue de 90 tuiles ne lance pas 90 arrayBuffer() dans le même tick et
// n'affame pas le pipeline du fond de carte — mais la porte est plus large que
// celle de la pente (3× la taille du pool), car chaque créneau fait ~1/5 des E/S
// d'un créneau de pente (1 lecture de DEM contre 5).
//
// Concurrence du travail préalable pour l'altitude. Repli sur 9 quand le pool
// n'est pas encore dimensionné (3× le repli de 6 de la pente ≈ même rapport).
function altitudePreWorkConcurrency() {
  if (_slopeWorkers && _slopeWorkers.length > 0) return _slopeWorkers.length * 3;
  return 9;
}

let _altitudePreWorkActive = 0;
const _altitudePreWorkQueue = [];

function acquireAltitudePreWork() {
  if (_altitudePreWorkActive < altitudePreWorkConcurrency()) {
    _altitudePreWorkActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _altitudePreWorkQueue.push(resolve));
}

function releaseAltitudePreWork() {
  _altitudePreWorkActive = Math.max(0, _altitudePreWorkActive - 1);
  if (_altitudePreWorkQueue.length > 0 && _altitudePreWorkActive < altitudePreWorkConcurrency()) {
    _altitudePreWorkActive++;
    _altitudePreWorkQueue.shift()();
  }
}

async function computeAltitudeViaPool(demBlob, z, x, y, generation, zoneRing) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  // Vérification d'annulation AVANT le travail coûteux.
  if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
    return null;
  }

  await acquireAltitudePreWork();
  try {
    if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
      return null;
    }

    // Récupère les octets du DEM propre (transférables). On ne décode PAS ici.
    let ownDemBuf;
    try {
      ownDemBuf = await demBlob.arrayBuffer();
    } catch {
      return null;
    }
    if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
      return null;
    }

    const workerIdx = pickSlopeWorker();
    if (workerIdx < 0) return null;
    const worker = workers[workerIdx];

    const id = ++_slopeJobMonotonic;
    const jobPromise = new Promise((resolve, reject) => {
      _slopeJobCallbacks.set(id, { resolve, reject, kind: 'altitude', workerIdx });
    });

    worker.postMessage(
      { id, kind: 'altitude', z, x, y, ownDem: ownDemBuf, zoneRing: zoneRing || null },
      [ownDemBuf],
    );

    releaseAltitudePreWork();

    let result;
    try {
      result = await jobPromise;
    } catch {
      return null;
    }
    if (!result) return null; // cancelled

    if (typeof altitudeCancelGeneration !== 'undefined' && generation !== altitudeCancelGeneration) {
      return null;
    }

    // Enveloppe l'ArrayBuffer renvoyé dans un Blob PNG.
    const blob = new Blob([result.png], { type: 'image/png' });
    return { blob };
  } finally {
    releaseAltitudePreWork();
  }
}

// ── Convertisseur AWS Terrarium multicœur (2026-08-29) ────────────────
// Envoie l'ArrayBuffer PNG Terrarium brut au pool de workers pour un décodage
// parallèle, la conversion Terrarium → Terrain-RGB et l'encodage PNG filtré en Sub.
async function computeAwsTerrariumViaPool(arrayBuffer, z, x, y, fetchZ, fetchX, fetchY, clamped) {
  const workers = ensureSlopePool();
  if (!workers) return null;

  const workerIdx = pickSlopeWorker();
  if (workerIdx < 0) return null;
  const worker = workers[workerIdx];

  const id = ++_slopeJobMonotonic;
  const jobPromise = new Promise((resolve, reject) => {
    _slopeJobCallbacks.set(id, { resolve, reject, kind: 'aws-terrarium', workerIdx });
  });

  try {
    worker.postMessage(
      { id, kind: 'aws-terrarium', z, x, y, fetchZ, fetchX, fetchY, clamped, terrariumBuf: arrayBuffer },
      [arrayBuffer],
    );

    const result = await jobPromise;
    if (!result || !result.png) return null;

    return new Blob([result.png], { type: 'image/png' });
  } catch {
    return null;
  }
}
