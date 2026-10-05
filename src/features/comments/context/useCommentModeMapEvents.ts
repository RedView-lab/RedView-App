import { useEffect, useRef } from 'react';
import type { LngLat, Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import type { ProjectCommentAnchor, ProjectCommentZone } from '@/features/itineraryPanel/types';
import { getCameraOwner } from '@/features/map3d/lib/cameraOwnership';
import { MAP_CURSOR_PRIORITY, setMapCursor } from '@/features/map3d/lib/mapCursor';
import { queryPoiAtPoint } from '@/features/poi/lib/poi-markers';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';

import { isZoneDrag, zoneFromScreenRect, type LngLatPair, type ScreenPoint } from '../lib/zoneGeometry';

/**
 * Gestes de la carte en mode commentaire (comme l'outil de Figma) :
 *  - clic = bulle à ce point du relief ;
 *  - Maj + glisser (ou glisser, sous-outil « zone ») = commentaire de zone :
 *    l'empreinte au sol du rectangle, dessinée pendant le geste ; le
 *    déplacement de la carte est coupé le temps du geste seulement (Espace +
 *    glisser déplace la carte dans le sous-outil zone) ;
 *  - les bulles, cartes, popups, marqueurs et POI gardent leur propre clic.
 */

/** Curseur bulle avec « + » (pointe en bas à gauche, comme la bulle posée). */
export const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
  + '<path d="M2.5 21.5V9a6.5 6.5 0 0 1 6.5-6.5h6A6.5 6.5 0 0 1 21.5 9v0a6.5 6.5 0 0 1-6.5 6.5H8.5z" fill="#fff" stroke="#111114" stroke-width="1.5" stroke-linejoin="round"/>'
  + '<path d="M12 6v6M9 9h6" stroke="#111114" stroke-width="1.6" stroke-linecap="round"/></svg>',
)}") 2 22, crosshair`;

const CURSOR_OWNER = 'comment-tool';
const GESTURE_CURSOR_OWNER = 'comment-zone-gesture';

/** Cibles qui gardent leur propre clic. */
const OWN_CLICK_SELECTOR = [
  '[data-rv-comment-pin]',
  '[data-rv-comment-card]',
  '.mapboxgl-popup',
  '.mapboxgl-marker',
  '.rv-poi-draft-card',
  '[data-rv-poi-draft-card]',
  'button',
  'a',
  'input',
  'textarea',
  '[role="button"]',
].join(', ');

/** Au-delà de cette distance du centre, un point « au sol » est au-dessus de l'horizon. */
const MAX_GROUND_DISTANCE_DEG = 3;
/** Un clic juste après un geste de zone ne pose pas en plus une bulle. */
const CLICK_AFTER_ZONE_MS = 350;

const roundCoordinate = (value: number) => Math.round(value * 1e7) / 1e7;

/** Ancre sur le relief : altitude réelle du terrain (sans exagération). */
export function commentAnchorAt(map: MapboxMap, lngLat: Pick<LngLat, 'lng' | 'lat'>): ProjectCommentAnchor {
  let elevation: number | null | undefined = null;
  try {
    elevation = map.queryTerrainElevation?.([lngLat.lng, lngLat.lat], { exaggerated: false });
  } catch {
    elevation = null;
  }
  return {
    lng: roundCoordinate(lngLat.lng),
    lat: roundCoordinate(lngLat.lat),
    elevationM: typeof elevation === 'number' && Number.isFinite(elevation) ? Math.round(elevation * 10) / 10 : null,
  };
}

function isOwnClickTarget(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && Boolean(target.closest(OWN_CLICK_SELECTOR));
}

/** Point d'un événement souris en px de mise en page du conteneur (zoom CSS de l'interface compris). */
function layoutPoint(map: MapboxMap, event: MouseEvent): ScreenPoint {
  const container = map.getContainer();
  const rect = container.getBoundingClientRect();
  const scale = rect.width > 0 ? container.clientWidth / rect.width : 1;
  return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
}

function groundAt(map: MapboxMap, point: ScreenPoint): LngLatPair | null {
  try {
    const lngLat = map.unproject([point.x, point.y]);
    const center = map.getCenter();
    if (!Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return null;
    if (Math.abs(lngLat.lng - center.lng) > MAX_GROUND_DISTANCE_DEG || Math.abs(lngLat.lat - center.lat) > MAX_GROUND_DISTANCE_DEG) return null;
    return [lngLat.lng, lngLat.lat];
  } catch {
    return null;
  }
}

interface UseCommentModeMapEventsArgs {
  map: MapboxMap | null;
  armed: boolean;
  subTool: 'point' | 'zone';
  onPoint(anchor: ProjectCommentAnchor): void;
  onZonePreview(zone: ProjectCommentZone | null): void;
  onZone(anchor: ProjectCommentAnchor, zone: ProjectCommentZone): void;
}

export function useCommentModeMapEvents({ map, armed, subTool, onPoint, onZonePreview, onZone }: UseCommentModeMapEventsArgs): void {
  // Lus par les écouteurs : l'effet ne dépend que de `armed` / `map`.
  const latest = useRef({ subTool, onPoint, onZonePreview, onZone });
  useEffect(() => {
    latest.current = { subTool, onPoint, onZonePreview, onZone };
  });

  useEffect(() => {
    if (!armed || !map) return;
    const container = map.getContainer();
    setMapCursor(map, CURSOR_OWNER, COMMENT_CURSOR, MAP_CURSOR_PRIORITY.tool);
    // Deux clics rapprochés posent deux bulles ; Maj + glisser dessine une zone, pas un zoom de boîte.
    const restoreDoubleClickZoom = map.doubleClickZoom.isEnabled();
    if (restoreDoubleClickZoom) map.doubleClickZoom.disable();
    const restoreBoxZoom = map.boxZoom.isEnabled();
    if (restoreBoxZoom) map.boxZoom.disable();

    let spaceHeld = false;
    let suppressClickUntil = 0;
    let gesture: { start: ScreenPoint; current: ScreenPoint; restorePan: boolean } | null = null;
    let frame: number | null = null;

    const preview = () => {
      frame = null;
      if (!gesture) return;
      latest.current.onZonePreview(zoneFromScreenRect(gesture.start, gesture.current, (point) => groundAt(map, point)));
    };

    const endGesture = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      if (gesture?.restorePan) map.dragPan.enable();
      setMapCursor(map, GESTURE_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.gesture);
      gesture = null;
    };

    function handleMouseMove(event: MouseEvent) {
      if (!gesture) return;
      gesture.current = layoutPoint(map!, event);
      if (frame === null) frame = window.requestAnimationFrame(preview);
    }

    function handleMouseUp(event: MouseEvent) {
      if (!gesture) return;
      const { start } = gesture;
      const end = layoutPoint(map!, event);
      endGesture();
      if (!isZoneDrag(start, end)) {
        // Simple clic : le `click` de la carte pose une bulle.
        latest.current.onZonePreview(null);
        return;
      }
      suppressClickUntil = performance.now() + CLICK_AFTER_ZONE_MS;
      const zone = zoneFromScreenRect(start, end, (point) => groundAt(map!, point));
      const ground = groundAt(map!, end);
      if (!zone || !ground) {
        latest.current.onZonePreview(null);
        return;
      }
      latest.current.onZone(commentAnchorAt(map!, { lng: ground[0], lat: ground[1] }), zone);
    }

    // Capture sur le conteneur de la carte : avant les gestionnaires de Mapbox (glisser = déplacer).
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || gesture || getCameraOwner()) return;
      if (isOwnClickTarget(event.target)) return;
      const zoneGesture = latest.current.subTool === 'zone' ? !spaceHeld : event.shiftKey;
      if (!zoneGesture) return;
      event.preventDefault();
      const restorePan = map.dragPan.isEnabled();
      if (restorePan) map.dragPan.disable();
      const start = layoutPoint(map, event);
      gesture = { start, current: start, restorePan };
      setMapCursor(map, GESTURE_CURSOR_OWNER, 'crosshair', MAP_CURSOR_PRIORITY.gesture);
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    };

    const handleClick = (event: MapMouseEvent) => {
      if (performance.now() < suppressClickUntil || getCameraOwner()) return;
      if (isOwnClickTarget(event.originalEvent?.target) || queryPoiAtPoint(map, event.point)) return;
      latest.current.onPoint(commentAnchorAt(map, event.lngLat));
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      spaceHeld = event.type === 'keydown';
    };
    const handleBlur = () => {
      spaceHeld = false;
    };

    container.addEventListener('mousedown', handleMouseDown, true);
    map.on('click', handleClick);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('keyup', handleKey);
    window.addEventListener('blur', handleBlur);

    return () => {
      endGesture();
      latest.current.onZonePreview(null);
      container.removeEventListener('mousedown', handleMouseDown, true);
      map.off('click', handleClick);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('keyup', handleKey);
      window.removeEventListener('blur', handleBlur);
      if (restoreDoubleClickZoom) map.doubleClickZoom.enable();
      if (restoreBoxZoom) map.boxZoom.enable();
      setMapCursor(map, CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.tool);
    };
  }, [armed, map]);
}
