import type { Itinerary, ItineraryProject } from '../../types';
import { deepEqual } from '../../lib/project/deepEqual';
import { ITINERARY_VIEW_KEYS } from '../../lib/project/layers';

/**
 * Périmètre de l'historique undo/redo.
 *
 * L'historique porte sur le « document » : le contenu des itinéraires (tracé,
 * timeline, réglages de routage, rythme, POI, zones interdites, couleur…).
 * La vue de l'utilisateur (cf. `lib/project/layers.ts`) n'est jamais remontée
 * par un undo : fond de carte / environnement (`controlPanel`), graphe
 * (`analysis`), vue carte et panneaux (`dashboard`), mode du panneau,
 * sélection de l'itinéraire actif, affichage des itinéraires (œil, rendu,
 * opacité) ; ni le nom et l'horodatage de sauvegarde.
 */
const UNTRACKED_ITINERARY_KEYS: ReadonlySet<string> = new Set(ITINERARY_VIEW_KEYS);

/** `restored` avec l'affichage (champs de vue) de `live`. */
export function withLiveItineraryView(restored: Itinerary, live: Itinerary): Itinerary {
  let copy: Itinerary | null = null;
  for (const key of ITINERARY_VIEW_KEYS) {
    if (restored[key] === live[key]) continue;
    copy ??= { ...restored };
    (copy as unknown as Record<string, unknown>)[key] = live[key];
  }
  return copy ?? restored;
}

export { deepEqual };

export interface HistoryDocumentChange {
  /** Itinéraire concerné quand un seul a changé (sinon ''). */
  itineraryId: string;
  /** Signature des champs modifiés : sert au regroupement des rafales. */
  signature: string;
}

/**
 * Compare le document de deux états du projet. `null` = aucun changement
 * suivi (changement d'affichage uniquement), rien à enregistrer.
 */
export function diffHistoryDocument(
  prev: ItineraryProject,
  next: ItineraryProject,
): HistoryDocumentChange | null {
  if (prev.itineraries === next.itineraries) return null;

  const prevIds = prev.itineraries.map((it) => it.id);
  const nextIds = next.itineraries.map((it) => it.id);
  if (prevIds.length !== nextIds.length || prevIds.some((id, index) => id !== nextIds[index])) {
    const added = nextIds.find((id) => !prevIds.includes(id));
    return { itineraryId: added ?? '', signature: `structure:${nextIds.join('|')}` };
  }

  const changedKeys: string[] = [];
  const changedIds = new Set<string>();
  next.itineraries.forEach((nextItinerary, index) => {
    const prevItinerary = prev.itineraries[index];
    if (nextItinerary === prevItinerary) return;
    const left = prevItinerary as unknown as Record<string, unknown>;
    const right = nextItinerary as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (UNTRACKED_ITINERARY_KEYS.has(key)) continue;
      if (!deepEqual(left[key], right[key])) {
        changedKeys.push(`${nextItinerary.id}.${key}`);
        changedIds.add(nextItinerary.id);
      }
    }
  });

  if (changedKeys.length === 0) return null;
  return {
    itineraryId: changedIds.size === 1 ? [...changedIds][0] : '',
    signature: changedKeys.sort().join(','),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

function elementId(value: unknown): string | number | null {
  if (!isPlainObject(value)) return null;
  const id = value.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Réutilise dans `next` toute sous-partie égale (en contenu) à celle de
 * `prev`, jusqu'à `depth` niveaux ; au-delà, égalité profonde. Les éléments de
 * tableaux portant un `id` (itinéraires, lignes de timeline, POI…) sont
 * appariés par id, les autres (points) par position.
 */
function shareValue(prev: unknown, next: unknown, depth: number): unknown {
  if (prev === next) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (depth <= 0) return deepEqual(prev, next) ? prev : next;
    const prevById = elementId(next[0]) !== null
      ? new Map(prev.map((item) => [elementId(item), item]))
      : null;
    let sameAsPrev = prev.length === next.length;
    let sameAsNext = true;
    const out = next.map((item, index) => {
      const id = prevById ? elementId(item) : null;
      const counterpart = prevById && id !== null && prevById.has(id) ? prevById.get(id) : prev[index];
      const shared = shareValue(counterpart, item, depth - 1);
      if (shared !== prev[index]) sameAsPrev = false;
      if (shared !== item) sameAsNext = false;
      return shared;
    });
    // Garde l'identité de `prev` (rien n'a changé) ou de `next` (ex. objet
    // restauré depuis l'historique, déjà affiché auparavant) quand c'est possible.
    if (sameAsPrev) return prev;
    return sameAsNext ? next : out;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    if (depth <= 0) return deepEqual(prev, next) ? prev : next;
    let sameAsPrev = definedKeys(next).length === definedKeys(prev).length;
    let sameAsNext = true;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      const shared = shareValue(prev[key], next[key], depth - 1);
      out[key] = shared;
      if (shared !== prev[key] && next[key] !== undefined) sameAsPrev = false;
      if (shared !== next[key]) sameAsNext = false;
    }
    if (sameAsPrev) return prev;
    return sameAsNext ? next : out;
  }
  return Number.isNaN(prev) && Number.isNaN(next) ? prev : next;
}

/**
 * Partage structurel entre deux états successifs du projet : tout ce qui n'a
 * pas changé garde sa référence (itinéraire, trace, points, lignes de
 * timeline…), et le résultat est `prev` lui-même s'il n'y a aucun changement.
 *
 * Les calculs dérivés (profil et séries du graphe, hachage et couche carte des
 * tracés, POI…) sont mis en cache par référence : sans ce partage, chaque
 * modification (un renommage, un curseur…) recopiait la trace entière et
 * relançait tous ces calculs. C'est aussi ce qui rend undo/redo instantanés :
 * l'historique conserve les objets déjà affichés, dont les rendus sont
 * encore en cache.
 */
export function shareProjectStructure(
  prev: ItineraryProject,
  next: ItineraryProject,
): ItineraryProject {
  // projet → itinéraires → itinéraire → trace → points → point (égalité profonde)
  return shareValue(prev, next, 5) as ItineraryProject;
}

/**
 * Applique le document d'un instantané sur l'état vivant : seuls les
 * itinéraires sont restaurés, l'état d'affichage courant est conservé. Les
 * objets de l'instantané sont réutilisés tels quels (l'état n'est jamais muté
 * en place) : ce sont ceux qui étaient affichés, leurs rendus sont en cache.
 * L'itinéraire concerné par l'étape devient actif (on voit ce qui a été
 * annulé / rétabli).
 */
export function restoreHistoryDocument(
  live: ItineraryProject,
  snapshot: ItineraryProject,
  focusItineraryId: string,
): ItineraryProject {
  const liveById = new Map(live.itineraries.map((it) => [it.id, it]));

  // Un itinéraire qui réapparaît (ajout / import / duplication rétablis,
  // suppression annulée) est ce que l'utilisateur doit voir en premier.
  const focusedId =
    snapshot.itineraries.find((it) => !liveById.has(it.id))?.id ??
    (focusItineraryId && snapshot.itineraries.some((it) => it.id === focusItineraryId)
      ? focusItineraryId
      : null);

  const itineraries = snapshot.itineraries.map((itinerary) => {
    const liveItinerary = liveById.get(itinerary.id);
    const restored = liveItinerary ? withLiveItineraryView(itinerary, liveItinerary) : itinerary;
    if (itinerary.id !== focusedId || (restored.visible !== false && restored.analysisVisible !== false)) {
      return restored;
    }
    return { ...restored, visible: true, analysisVisible: true };
  });

  let activeItineraryId = focusedId ?? live.activeItineraryId;
  if (!itineraries.some((it) => it.id === activeItineraryId)) {
    activeItineraryId = snapshot.activeItineraryId;
  }

  return { ...live, itineraries, activeItineraryId };
}
