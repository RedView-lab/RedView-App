import { useEffect, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';
import {
  buildRouteDistanceLabels,
  placeLabelBoxes,
  type LabelOffset,
  type ScreenLabelBox,
  type ScreenObstacleBox,
} from '../lib/route-layer/distanceLabels';
import type { ItineraryProject } from '../types';
import '@/features/poi/styles/floating-markers.css';

const LABEL_CLASS = 'rv-route-distance-label';
const HIDDEN_CLASS = 'is-hidden';
const DISPLACED_CLASS = 'is-displaced';
/** Marge minimale entre deux pastilles à l'écran (px de layout de la carte). */
const LABEL_GAP_PX = 8;
/** Marqueurs de la trace prioritaires sur une borne (pas le point de survol, qui bouge). */
const OBSTACLE_SELECTOR = [
  '.rv-checkpoint-marker',
  '.rv-poi-marker--pause',
  '.rv-poi-marker--waypoint',
  '.rvi-analysis-alert-marker',
].join(',');

interface UseRouteDistanceLabelsArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  /** Itinéraire tracé en pente (filtre « Pente » du graphe central) ; `null` = aucune borne. */
  itinerary: ItineraryProject['itineraries'][number] | null;
  routesEnabled: boolean;
}

/**
 * L'élément du marqueur est une ancre de taille nulle sur le point exact :
 * Mapbox y écrit `opacity` (relief qui masque le point) et `transform`. La
 * pastille dedans porte le masquage et le décalage du placement, animés.
 */
function createLabelElement(km: number): { root: HTMLElement; pill: HTMLElement } {
  const root = document.createElement('div');
  root.className = `${LABEL_CLASS}-anchor`;
  root.setAttribute('aria-hidden', 'true');
  const pill = document.createElement('div');
  pill.className = `${LABEL_CLASS} ${HIDDEN_CLASS}`;
  pill.textContent = `${km} km`;
  root.appendChild(pill);
  return { root, pill };
}

function applyPlacement(root: HTMLElement, pill: HTMLElement, offset: LabelOffset | undefined): void {
  pill.classList.toggle(HIDDEN_CLASS, offset == null);
  root.classList.toggle(DISPLACED_CLASS, offset != null && (offset[0] !== 0 || offset[1] !== 0));
  if (offset == null) return;
  const dx = `${offset[0]}px`;
  const dy = `${offset[1]}px`;
  if (root.style.getPropertyValue('--rv-label-dx') !== dx) root.style.setProperty('--rv-label-dx', dx);
  if (root.style.getPropertyValue('--rv-label-dy') !== dy) root.style.setProperty('--rv-label-dy', dy);
}

/**
 * Boîtes des marqueurs de la trace affichés, en px de layout de la carte (le
 * canevas peut être zoomé en CSS : `getBoundingClientRect` est ramené au layout).
 */
function readObstacleBoxes(container: HTMLElement): ScreenObstacleBox[] {
  const elements = container.querySelectorAll<HTMLElement>(OBSTACLE_SELECTOR);
  if (elements.length === 0) return [];
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width <= 0) return [];
  const toLayout = container.offsetWidth / containerRect.width;
  const boxes: ScreenObstacleBox[] = [];
  elements.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    boxes.push({
      x: (rect.left + rect.width / 2 - containerRect.left) * toLayout,
      y: (rect.top + rect.height / 2 - containerRect.top) * toLayout,
      width: rect.width * toLayout,
      height: rect.height * toLayout,
    });
  });
  return boxes;
}

/**
 * Bornes kilométriques (tous les 25 ou 50 km) sur la trace en pente. Marqueurs
 * DOM : la pastille suit le relief, reste en Rethink Sans et disparaît d'elle-même
 * pendant le flyover (`[data-rv-flyover-session]`). À chaque mouvement de caméra
 * chaque pastille qui toucherait une autre borne, un départ, une arrivée, une
 * pause ou une alerte est décalée à côté de la trace, ou masquée faute de place ;
 * les multiples de 100 / 200 km passent en premier.
 */
export function useRouteDistanceLabels({ map, isMapLoaded, itinerary, routesEnabled }: UseRouteDistanceLabelsArgs): void {
  const points = itinerary?.gpxRoute?.points;
  const shown = Boolean(routesEnabled && itinerary && itinerary.visible !== false && points && points.length >= 2);
  const labels = useMemo(() => (shown && points ? buildRouteDistanceLabels(points) : []), [points, shown]);

  useEffect(() => {
    if (!map || !isMapLoaded || labels.length === 0) return;

    const entries = labels.map((label) => {
      const { root, pill } = createLabelElement(label.km);
      const marker = new mapboxgl.Marker({
        element: root,
        anchor: 'center',
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport',
      }).setLngLat(label.lngLat).addTo(map);
      return { label, marker, root, pill };
    });

    const container = map.getContainer();
    let frame: number | null = null;
    const declutter = () => {
      frame = null;
      const boxes: ScreenLabelBox[] = entries.map(({ label, marker, pill }) => {
        const point = map.project(marker.getLngLat());
        return {
          x: point.x,
          y: point.y,
          width: pill.offsetWidth,
          height: pill.offsetHeight,
          rank: label.rank,
          km: label.km,
        };
      });
      const placed = placeLabelBoxes(boxes, LABEL_GAP_PX, readObstacleBoxes(container));
      entries.forEach(({ root, pill }, index) => applyPlacement(root, pill, placed.get(index)));
    };
    const scheduleDeclutter = () => {
      // Flyover : bornes masquées par le CSS, aucun travail par image.
      if (frame != null || container.dataset.rvFlyoverSession != null) return;
      frame = requestAnimationFrame(declutter);
    };

    declutter();
    map.on('move', scheduleDeclutter);
    map.on('resize', scheduleDeclutter);
    // Départ, pauses, alertes… montés après les bornes : réarbitrer sans
    // attendre un mouvement de caméra.
    const markersObserver = new MutationObserver(scheduleDeclutter);
    markersObserver.observe(map.getCanvasContainer(), { childList: true });
    // Fin du flyover : replacer pour la vue où il s'arrête.
    const sessionObserver = new MutationObserver(scheduleDeclutter);
    sessionObserver.observe(container, { attributes: true, attributeFilter: ['data-rv-flyover-session'] });
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      markersObserver.disconnect();
      sessionObserver.disconnect();
      map.off('move', scheduleDeclutter);
      map.off('resize', scheduleDeclutter);
      for (const { marker } of entries) marker.remove();
    };
  }, [isMapLoaded, labels, map]);
}
