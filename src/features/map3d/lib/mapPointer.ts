import type { LngLat, Map as MapboxMap, PointLike } from 'mapbox-gl';

/**
 * Conversion écran → géo **identique à celle de Mapbox**.
 *
 * `map.unproject(clientXY)` tout seul ne suffit pas : en interne, Mapbox ne
 * l'appelle jamais directement. Tous ses événements carte (`click`,
 * `mousemove`, `contextmenu`, `mouseup`…) construisent leur `lngLat` via :
 *
 * ```js
 * // mapbox-gl : ui/events.ts
 * const point = mousePos(map.getCanvasContainer(), originalEvent);
 * const lngLat = map.unproject(point);
 *
 * function mousePos(el, e) {
 *   const rect = el.getBoundingClientRect();
 *   return getScaledPoint(el, rect, e);
 * }
 * function getScaledPoint(el, rect, e) {
 *   const scaling = el.offsetWidth === rect.width ? 1 : el.offsetWidth / rect.width;
 *   return new Point((e.clientX - rect.left) * scaling, (e.clientY - rect.top) * scaling);
 * }
 * ```
 *
 * Deux termes sont donc indispensables et faciles à oublier :
 *
 * 1. la référence est le **conteneur du canvas** (`getCanvasContainer()`), pas le
 *    canvas lui-même — les deux peuvent ne pas partager la même origine ;
 * 2. le **facteur d'échelle CSS** du conteneur (`offsetWidth / rect.width`), qui
 *    vaut 1 seulement quand le conteneur n'est pas mis à l'échelle visuellement.
 *
 * Les ignorer décale le point calculé de celui affiché sous le curseur — de
 * quelques mètres à plusieurs centaines selon le zoom. Reproduire la formule
 * garantit que le résultat est rigoureusement celui de `event.lngLat`.
 */
export function unprojectClientPoint(
  map: MapboxMap,
  clientX: number,
  clientY: number,
): LngLat {
  const container = map.getCanvasContainer();
  const rect = container.getBoundingClientRect();
  const scaling =
    container.offsetWidth === rect.width ? 1 : container.offsetWidth / rect.width;

  return map.unproject([
    (clientX - rect.left) * scaling,
    (clientY - rect.top) * scaling,
  ] as PointLike);
}

/** Même conversion, à partir d'un événement souris DOM. */
export function unprojectMouseEvent(map: MapboxMap, event: MouseEvent): LngLat {
  return unprojectClientPoint(map, event.clientX, event.clientY);
}
