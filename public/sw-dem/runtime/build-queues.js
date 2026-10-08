// ---------------------------------------------------------------------------
// Concurrence des constructions : limiteur de composition (pic mémoire des
// fondus IGN/Mapbox), files adaptatives de construction pente / altitude avec
// générations d'annulation, et maps par tuile des requêtes en cours qui
// fusionnent les demandes DEM / pente / altitude en double.
// ---------------------------------------------------------------------------

// Limiteur de concurrence de composition — plafonne le pic mémoire des fondus
// simultanés. Passé de 2 à 6 : compositeIGNMapbox utilise ≤ 2 Mo par appel
// (2× Float32(256²) + un tableau d'altitudes Mapbox de 512²), donc 6 en
// parallèle ≈ 12 Mo — négligeable. À 2, chaque zoom avant était étranglé : une
// vue de 20 tuiles mettait en file 10 cycles de composition de 300 à 500 ms
// chacun = 5 s de pression sur le pipeline, d'où des dépassements du délai
// souple en aval.
//
// Passe de performance du 19 mai : adaptée au CPU — sur les machines avec
// hardwareConcurrency ≥ 8, l'étape de composition est le goulot suivant une
// fois que les fetchs de sous-tuiles IGN arrivent en rafale. Chaque composition
// culmine à ~12 Mo ; ~10 en parallèle sur 8 cœurs gardent le pic ≤ 120 Mo tout en
// laissant un zoom avant de 20 tuiles passer en une vague de composition au
// lieu de deux. Le plancher reste à 6 sur les petites machines pour préserver
// l'enveloppe mémoire d'origine.
const COMPOSITE_MAX_CONCURRENT = (() => {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 4) return 6;
  if (hc >= 12) return 10;
  if (hc >= 8) return 8;
  return 6;
})();

let _compositeActive = 0;
const _compositeQueue = [];
const SLOPE_BUILD_BUSY_CONCURRENT = 2;
const SLOPE_BUILD_WARM_CONCURRENT = 4;
let _slopeBuildActive = 0;
const _slopeBuildQueue = [];
// La concurrence des constructions d'altitude est adaptative (sur le modèle de
// currentSlopeBuildConcurrency des pentes). Elle ne plafonne que le chemin de
// repli dans le processus courant ; le pool de workers est le chemin de
// construction principal et il est borné par sa taille. Une valeur fixe de `2`
// affamait le repli sur les machines multicœur quand le pool est brièvement
// indisponible.
const ALTITUDE_BUILD_BUSY_CONCURRENT = 2;
const ALTITUDE_BUILD_WARM_CONCURRENT = 4;
let _altitudeBuildActive = 0;
const _altitudeBuildQueue = [];

// Déduplication des tuiles de pente en cours : clé = `${profile}:${z}/${x}/${y}?${resFactor}` →
// Promise<Response>. Les requêtes simultanées d'une même tuile partagent le
// seul calcul en cours au lieu de dupliquer le pipeline de Horn.
const SLOPE_INFLIGHT = new Map();
const ALTITUDE_INFLIGHT = new Map();
let slopeCancelGeneration = 0;
let altitudeCancelGeneration = 0;

// Déduplication des tuiles DEM en cours. Même idée que SLOPE_INFLIGHT, mais
// pour le point d'accès brut `/dem-tiles/...`. Sans elle, chaque tuile de pente
// déclenche 4 reconstructions de DEM voisins (voir slope-handler.js) — pour une
// vue de 90 tuiles, ~450 appels handleDemRequest simultanés, dont beaucoup pour
// la MÊME tuile. Chacun de ces doublons exécute tout le dispatcher IGN /
// Suisse / Mapbox (fetchs HTTP, composition, garde-fou de santé) puis écrit le
// même blob dans le cache. Ce travail en double expliquait en grande partie le
// blocage de la pastille Pentes vers 85 % sur une vue à froid — le pipeline du
// SW saturait au point que certaines réponses de pente manquaient l'échéance de
// chargement de tuile de Mapbox et ne déclenchaient jamais `sourcedata`. La
// fusion ramène l'éventail de 5× à 1 par tuile.
const DEM_INFLIGHT = new Map();

function detectSlopeBuildIdleConcurrency() {
  const hc = Number(globalThis.navigator?.hardwareConcurrency || 0);
  if (!Number.isFinite(hc) || hc <= 0) return 6;
  return Math.max(4, Math.min(12, Math.round(hc * 0.75)));
}

const SLOPE_BUILD_IDLE_CONCURRENT = detectSlopeBuildIdleConcurrency();

function currentSlopeBuildConcurrency() {
  const demPressure = DEM_INFLIGHT.size;
  if (demPressure >= 24) return SLOPE_BUILD_BUSY_CONCURRENT;
  if (demPressure >= 8) return Math.min(SLOPE_BUILD_IDLE_CONCURRENT, SLOPE_BUILD_WARM_CONCURRENT);
  return SLOPE_BUILD_IDLE_CONCURRENT;
}

// Concurrence du repli d'altitude dans le processus courant. Même heuristique
// de pression DEM que pour la pente : on ralentit quand le pipeline DEM est
// saturé, on va librement quand il est inactif. Calquée sur
// currentSlopeBuildConcurrency, pour que le repli n'affame jamais le fond de carte.
function currentAltitudeBuildConcurrency() {
  const demPressure = DEM_INFLIGHT.size;
  if (demPressure >= 24) return ALTITUDE_BUILD_BUSY_CONCURRENT;
  if (demPressure >= 8) return Math.min(SLOPE_BUILD_IDLE_CONCURRENT, ALTITUDE_BUILD_WARM_CONCURRENT);
  return SLOPE_BUILD_IDLE_CONCURRENT;
}

function cancelSlopeWork() {
  slopeCancelGeneration += 1;
  const slopeCount = SLOPE_INFLIGHT.size;
  SLOPE_INFLIGHT.clear();
  const remainingSlope = [];
  while (_slopeBuildQueue.length > 0) {
    const queued = _slopeBuildQueue.shift();
    if (queued?.generation === null) {
      remainingSlope.push(queued);
    } else {
      try { queued?.resolve(null); } catch { /* ignore */ }
    }
  }
  _slopeBuildQueue.push(...remainingSlope);
  // Abandonne aussi toutes les tâches en attente du pool de workers (sauf les non annulables).
  let poolCancelled = 0;
  try {
    if (typeof cancelAllSlopePoolJobs === 'function') poolCancelled = cancelAllSlopePoolJobs();
  } catch { /* ignore */ }
  try { if (typeof clearSlopeProcessingCaches === 'function') clearSlopeProcessingCaches(); } catch { /* ignore */ }
  return { slopeCount, poolCancelled };
}

function cancelAltitudeWork() {
  altitudeCancelGeneration += 1;
  const altitudeCount = ALTITUDE_INFLIGHT.size;
  ALTITUDE_INFLIGHT.clear();
  while (_altitudeBuildQueue.length > 0) {
    const queued = _altitudeBuildQueue.shift();
    try { queued?.resolve(null); } catch { /* ignore */ }
  }
  // Abandonne aussi toutes les tâches en attente du pool marquées kind:'altitude'
  // (voir CANCEL_SLOPE_WORK côté pente pour la justification). L'annulation par
  // type garantit qu'on ne touche jamais aux tâches de pente en cours.
  let poolCancelled = 0;
  try {
    if (typeof cancelAllAltitudePoolJobs === 'function') poolCancelled = cancelAllAltitudePoolJobs();
  } catch { /* ignore */ }
  try { if (typeof clearAltitudeProcessingCaches === 'function') clearAltitudeProcessingCaches(); } catch { /* ignore */ }
  return { altitudeCount, poolCancelled };
}

function pumpAltitudeBuildQueue() {
  while (_altitudeBuildActive < currentAltitudeBuildConcurrency() && _altitudeBuildQueue.length > 0) {
    const entry = _altitudeBuildQueue.shift();
    if (!entry) break;
    if (entry.generation !== altitudeCancelGeneration) {
      entry.resolve(null);
      continue;
    }
    _altitudeBuildActive += 1;
    Promise.resolve()
      .then(() => entry.run())
      .then((result) => entry.resolve(result))
      .catch((error) => entry.reject(error))
      .finally(() => {
        _altitudeBuildActive = Math.max(0, _altitudeBuildActive - 1);
        pumpAltitudeBuildQueue();
      });
  }
}

function pumpSlopeBuildQueue() {
  while (_slopeBuildActive < currentSlopeBuildConcurrency() && _slopeBuildQueue.length > 0) {
    const entry = _slopeBuildQueue.shift();
    if (!entry) break;
    if (entry.generation !== null && entry.generation !== undefined && entry.generation !== slopeCancelGeneration) {
      entry.resolve(null);
      continue;
    }
    _slopeBuildActive += 1;
    Promise.resolve()
      .then(() => entry.run())
      .then((result) => entry.resolve(result))
      .catch((error) => entry.reject(error))
      .finally(() => {
        _slopeBuildActive = Math.max(0, _slopeBuildActive - 1);
        pumpSlopeBuildQueue();
      });
  }
}

function scheduleSlopeBuild(run, generation) {
  if (generation !== null && generation !== undefined && generation !== slopeCancelGeneration) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    _slopeBuildQueue.push({ run, generation, resolve, reject });
    pumpSlopeBuildQueue();
  });
}

function scheduleAltitudeBuild(run, generation) {
  if (generation !== altitudeCancelGeneration) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    _altitudeBuildQueue.push({ run, generation, resolve, reject });
    pumpAltitudeBuildQueue();
  });
}

function acquireComposite() {
  if (_compositeActive < COMPOSITE_MAX_CONCURRENT) {
    _compositeActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => _compositeQueue.push(resolve));
}
function releaseComposite() {
  _compositeActive--;
  if (_compositeQueue.length > 0) {
    _compositeActive++;
    _compositeQueue.shift()();
  }
}
