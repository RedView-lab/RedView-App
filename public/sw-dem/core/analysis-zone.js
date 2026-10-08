// ---------------------------------------------------------------------------
// Registre de la zone d'analyse — l'unique polygone tracé par l'utilisateur qui
// concentre les pipelines de tuiles pente / altitude sur une zone bornée.
//
// La page envoie SET_ANALYSIS_ZONE { hash, ring } à chaque (re)tracé de la zone
// (src/features/analysisZone/lib/swZoneBridge.ts) et les handlers de tuiles
// reçoivent le MÊME hash en `?zone=<hash>` dans l'URL de la tuile. Deux usages :
//
//   1. REJET PRÉCOCE — `tileIntersectsAnalysisZone()` est un pur test de bbox
//      (bbox de la tuile contre bbox de la zone) exécuté AVANT toute lecture de
//      DEM dans CacheStorage ou tout fetch IGN. Une tuile entièrement hors du
//      polygone renvoie une réponse transparente en < 0,1 ms : le coût de
//      l'overlay suit la taille de la zone, pas celle de la vue.
//
//   2. MASQUE PAR PIXEL — les tuiles partiellement couvertes sont construites
//      normalement, puis leur alpha est masqué au polygone par
//      rasterizeRingMask()/applyRingMaskToRgba() dans workers/slope-math.js
//      (partagé par le scope du SW ET le pool de workers).
//
// Le registre est volontairement minuscule (LRU 8) : un hash d'URL que le SW
// ne connaît pas (SW redémarré, course avec un changement de source) retombe
// sur une construction NON MASQUÉE — une tuile correcte, jamais une erreur.
//
// Vit dans core/ (état pur + calcul sur mercatorTileBounds de geo.js), sans
// accès aux événements du SW, chargé par importScripts depuis sw-dem.js avant
// les handlers.
// ---------------------------------------------------------------------------

const ANALYSIS_ZONE_REGISTRY_MAX = 8;

// hash → { ring: [[lng, lat], ...], bbox: [w, s, e, n] }
const analysisZoneRegistry = new Map();

function analysisZoneBBoxFromRing(ring) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/**
 * ring : tableau plat [lng, lat, lng, lat, …] envoyé par la page (même forme
 * qu'analysisZoneRingPayload). Au moins 3 points distincts.
 */
function registerAnalysisZone(hash, flatRing) {
  if (!hash || typeof hash !== 'string' || !Array.isArray(flatRing)) return null;
  const ring = [];
  for (let i = 0; i + 1 < flatRing.length; i += 2) {
    const lng = Number(flatRing[i]);
    const lat = Number(flatRing[i + 1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    ring.push([lng, lat]);
  }
  if (ring.length < 3) return null;

  const entry = { ring, bbox: analysisZoneBBoxFromRing(ring) };
  if (analysisZoneRegistry.has(hash)) analysisZoneRegistry.delete(hash);
  analysisZoneRegistry.set(hash, entry);
  while (analysisZoneRegistry.size > ANALYSIS_ZONE_REGISTRY_MAX) {
    const oldest = analysisZoneRegistry.keys().next().value;
    if (oldest === undefined) break;
    analysisZoneRegistry.delete(oldest);
  }
  return entry;
}

function clearAnalysisZones() {
  analysisZoneRegistry.clear();
}

function getAnalysisZone(hash) {
  if (!hash) return null;
  const entry = analysisZoneRegistry.get(hash);
  // Rafraîchissement LRU : une zone active n'est jamais celle qu'on évince.
  if (entry) {
    analysisZoneRegistry.delete(hash);
    analysisZoneRegistry.set(hash, entry);
  }
  return entry ?? null;
}

/**
 * Test pur de recouvrement de bbox entre la tuile (z, x, y) et la zone
 * enregistrée. Renvoie true quand la tuile PEUT contenir des pixels du
 * polygone (recouper la bbox est nécessaire, pas suffisant — le masque exact
 * est appliqué pixel par pixel ensuite). Un échec est définitif : la tuile est
 * forcément hors du polygone.
 */
function tileIntersectsAnalysisZone(entry, z, x, y) {
  if (!entry) return false;
  const b = mercatorTileBounds(z, x, y);
  const [w, s, e, n] = entry.bbox;
  return !(b.east < w || b.west > e || b.south > n || b.north < s);
}

/**
 * Résout un hash `?zone=` en { entry, ring } pour la construction d'une tuile.
 * Hash inconnu ou absent → { entry: null, ring: null } → construction non masquée.
 */
function resolveAnalysisZoneForTile(zoneHash) {
  if (!zoneHash) return { entry: null, ring: null };
  const entry = getAnalysisZone(zoneHash);
  if (!entry) return { entry: null, ring: null };
  return { entry, ring: entry.ring };
}
