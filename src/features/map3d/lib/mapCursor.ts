import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Arbitre unique du curseur de la carte.
 *
 * Plusieurs outils pilotent le curseur en même temps (crayon du mode Tracer,
 * main au survol de la trace, « grabbing » pendant un drag ou un pan…). Quand
 * chacun écrivait `canvas.style.cursor` lui-même, le dernier écrivain gagnait :
 * deux écrivains en désaccord suffisaient à faire clignoter crayon ↔ main.
 *
 * Ici chaque outil *déclare* son curseur sous un nom de propriétaire, avec une
 * priorité ; l'arbitre applique la déclaration gagnante et ne touche au DOM que
 * lorsque le résultat change.
 *
 * Le curseur est posé sur le canvas ET sur son conteneur : les marqueurs DOM
 * (enfants du conteneur) sans curseur propre en héritent, au lieu de la main
 * `grab` de mapbox-gl.css.
 */
export const MAP_CURSOR_PRIORITY = {
  /** Curseur de fond d'un outil armé (crayon du mode Tracer). */
  tool: 10,
  /** Survol d'une cible (trace saisissable, POI). */
  hover: 20,
  /** Geste en cours (drag d'un point ou de la trace, pan de la carte). */
  gesture: 30,
} as const;

interface CursorClaim {
  cursor: string;
  priority: number;
  /** Ordre de déclaration : à priorité égale, la plus récente gagne. */
  order: number;
}

interface MapCursorState {
  claims: Map<string, CursorClaim>;
  /** Dernier curseur écrit par l'arbitre (null : il n'en impose aucun). */
  applied: string | null;
  order: number;
}

const stateByMap = new WeakMap<MapboxMap, MapCursorState>();

function resolveCursor(state: MapCursorState): string | null {
  let best: CursorClaim | null = null;
  for (const claim of state.claims.values()) {
    if (
      !best
      || claim.priority > best.priority
      || (claim.priority === best.priority && claim.order > best.order)
    ) {
      best = claim;
    }
  }
  return best?.cursor ?? null;
}

function applyCursor(map: MapboxMap, state: MapCursorState): void {
  const next = resolveCursor(state);
  if (next === state.applied) return;

  let elements: HTMLElement[];
  try {
    elements = [map.getCanvas(), map.getCanvasContainer()];
  } catch {
    // Carte détruite : plus rien à piloter.
    state.applied = next;
    return;
  }

  for (const element of elements) {
    if (next !== null) {
      if (element.style.cursor !== next) element.style.cursor = next;
    } else if (element.style.cursor === state.applied) {
      // On ne retire que ce que l'arbitre a posé lui-même.
      element.style.cursor = '';
    }
  }
  state.applied = next;
}

/**
 * Déclare (ou retire, avec `null`) le curseur voulu par `owner`.
 * Idempotent : redéclarer la même valeur ne touche pas au DOM.
 */
export function setMapCursor(
  map: MapboxMap,
  owner: string,
  cursor: string | null,
  priority: number,
): void {
  let state = stateByMap.get(map);
  if (!state) {
    if (cursor === null) return;
    state = { claims: new Map(), applied: null, order: 0 };
    stateByMap.set(map, state);
  }

  if (cursor === null) {
    if (!state.claims.delete(owner)) return;
  } else {
    const current = state.claims.get(owner);
    if (current && current.cursor === cursor && current.priority === priority) return;
    state.order += 1;
    state.claims.set(owner, { cursor, priority, order: state.order });
  }

  applyCursor(map, state);
}

/** Vrai tant qu'au moins un outil impose le curseur de cette carte. */
export function isMapCursorManaged(map: MapboxMap): boolean {
  return (stateByMap.get(map)?.claims.size ?? 0) > 0;
}
