import { useEffect, useRef } from 'react';
import type { LngLat, Map as MapboxMap, MapMouseEvent } from 'mapbox-gl';

import type { ProjectCommentAnchor, ProjectCommentZone } from '@/features/itineraryPanel/types';
import { getCameraOwner } from '@/features/map3d/lib/cameraOwnership';
import { MAP_CURSOR_PRIORITY, setMapCursor } from '@/features/map3d/lib/mapCursor';
import { queryPoiAtPoint } from '@/features/poi/lib/poi-markers';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';
import { closePolygonAt, polygonCloseIndex, polygonVertexHit } from '@/shared/lib/polygonClosing';

import { MIN_COMMENT_ZONE_VERTICES } from '../lib/limits';
import type { CommentZoneDrawing } from '../lib/zoneDrawing';
import { isZoneDrag, zoneFromPolygon, zoneFromScreenRect, type LngLatPair, type ScreenPoint } from '../lib/zoneGeometry';

/**
 * Gestes de la carte en mode commentaire (comme l'outil de Figma) :
 *  - clic = bulle à ce point du relief ;
 *  - sous-outil « zone » : zone polygonale, un clic par sommet (glisser
 *    déplace toujours la carte) ; un clic sur un sommet déjà posé ferme la
 *    zone sur ce sommet (`shared/lib/polygonClosing`, comme la surface du
 *    viewer LiDAR), Entrée ou double clic la termine, Retour arrière retire
 *    le dernier sommet, Échap abandonne le tracé ;
 *  - Maj + glisser (les deux sous-outils) = zone rectangulaire : l'empreinte
 *    au sol du rectangle, dessinée pendant le geste ; le déplacement de la
 *    carte est coupé le temps du geste seulement ;
 *  - les bulles, cartes, popups, marqueurs et POI gardent leur propre clic.
 */

/**
 * Curseur de Figma : bulle blanche cerclée (rond au coin bas-gauche carré,
 * même forme que l'icône et les bulles posées) ; le point chaud est ce coin,
 * là où la bulle sera posée.
 */
export const COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
  + '<path d="M3 11.5a8.5 8.5 0 1 1 8.5 8.5H4.25A1.25 1.25 0 0 1 3 18.75Z" fill="#fff" stroke="#111114" stroke-width="1.25" stroke-linejoin="round"/></svg>',
)}") 3 20, crosshair`;

const CURSOR_OWNER = 'comment-tool';
const GESTURE_CURSOR_OWNER = 'comment-zone-gesture';
const CLOSE_CURSOR_OWNER = 'comment-zone-close';

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
  /** Premier sommet d'une zone polygonale : false si ce clic a fermé autre chose (fil ouvert, saisie). */
  onZoneStart(): boolean;
  /** Zone polygonale en cours de pose (null : aucune). */
  onZoneDrawing(drawing: CommentZoneDrawing | null): void;
}

export function useCommentModeMapEvents({
  map, armed, subTool, onPoint, onZonePreview, onZone, onZoneStart, onZoneDrawing,
}: UseCommentModeMapEventsArgs): void {
  // Lus par les écouteurs : l'effet ne dépend que de `armed` / `map` / `subTool`.
  const latest = useRef({ onPoint, onZonePreview, onZone, onZoneStart, onZoneDrawing });
  useEffect(() => {
    latest.current = { onPoint, onZonePreview, onZone, onZoneStart, onZoneDrawing };
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

    const polygonMode = subTool === 'zone';
    let suppressClickUntil = 0;
    let gesture: { start: ScreenPoint; current: ScreenPoint; restorePan: boolean } | null = null;
    let frame: number | null = null;

    // ── Zone polygonale (sous-outil « zone ») ──
    let vertices: LngLatPair[] = [];
    let cursor: { point: ScreenPoint; ground: LngLatPair | null } | null = null;
    let hoverFrame: number | null = null;

    const vertexScreenPoints = (): Array<ScreenPoint | null> => vertices.map((vertex) => {
      try {
        const point = map.project(vertex);
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null;
      } catch {
        return null;
      }
    });

    const publishDrawing = () => {
      // Le dernier sommet n'est pas proposé au survol : le curseur y est juste
      // après la pose (un second clic termine quand même, comme un double clic).
      const hoverClose = cursor ? polygonCloseIndex(vertexScreenPoints(), cursor.point, MIN_COMMENT_ZONE_VERTICES) : -1;
      const closeIndex = hoverClose === vertices.length - 1 ? -1 : hoverClose;
      setMapCursor(map, CLOSE_CURSOR_OWNER, closeIndex >= 0 ? 'pointer' : null, MAP_CURSOR_PRIORITY.gesture);
      latest.current.onZoneDrawing({ vertices: [...vertices], cursor: cursor?.ground ?? null, closeIndex });
    };

    const resetPolygon = () => {
      if (hoverFrame !== null) window.cancelAnimationFrame(hoverFrame);
      hoverFrame = null;
      cursor = null;
      if (vertices.length === 0) return;
      vertices = [];
      setMapCursor(map, CLOSE_CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.gesture);
      latest.current.onZoneDrawing(null);
    };

    /** Termine la zone sur `ring` ; la bulle se pose sur `anchor`. */
    const finishPolygon = (ring: LngLatPair[], anchor: LngLatPair) => {
      const zone = zoneFromPolygon(ring);
      resetPolygon();
      if (zone) latest.current.onZone(commentAnchorAt(map, { lng: anchor[0], lat: anchor[1] }), zone);
    };

    const handlePolygonClick = (event: MapMouseEvent) => {
      const point = { x: event.point.x, y: event.point.y };
      const screen = vertexScreenPoints();
      const index = polygonCloseIndex(screen, point, MIN_COMMENT_ZONE_VERTICES);
      if (index >= 0) {
        finishPolygon(closePolygonAt(vertices, index), vertices[index]);
        return;
      }
      // Sur un sommet sans boucle possible (double clic trop tôt) : pas de doublon.
      if (polygonVertexHit(screen, point) >= 0) return;
      if (vertices.length === 0 && !latest.current.onZoneStart()) return;
      const vertex: LngLatPair = [event.lngLat.lng, event.lngLat.lat];
      vertices.push(vertex);
      cursor = { point, ground: vertex };
      publishDrawing();
    };

    const handlePolygonHover = (event: MouseEvent) => {
      if (vertices.length === 0 || gesture) return;
      const point = layoutPoint(map, event);
      cursor = { point, ground: groundAt(map, point) };
      if (hoverFrame === null) {
        hoverFrame = window.requestAnimationFrame(() => {
          hoverFrame = null;
          if (vertices.length > 0) publishDrawing();
        });
      }
    };

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
        // Simple clic : le `click` de la carte pose une bulle (ou un sommet).
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
      if (event.button !== 0 || !event.shiftKey || gesture || getCameraOwner()) return;
      if (isOwnClickTarget(event.target)) return;
      event.preventDefault();
      resetPolygon();
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
      if (isOwnClickTarget(event.originalEvent?.target)) return;
      if (polygonMode) {
        handlePolygonClick(event);
        return;
      }
      if (queryPoiAtPoint(map, event.point)) return;
      latest.current.onPoint(commentAnchorAt(map, event.lngLat));
    };

    // Capture : passe avant Échap des commentaires (CommentShortcuts) tant qu'un tracé est en cours.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (vertices.length === 0 || isTypingTarget(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') {
        resetPolygon();
      } else if (event.key === 'Enter') {
        if (vertices.length >= MIN_COMMENT_ZONE_VERTICES) finishPolygon(vertices, vertices[vertices.length - 1]);
      } else if (event.key === 'Backspace') {
        if (vertices.length === 1) {
          resetPolygon();
        } else {
          vertices.pop();
          publishDrawing();
        }
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    container.addEventListener('mousedown', handleMouseDown, true);
    if (polygonMode) container.addEventListener('mousemove', handlePolygonHover);
    map.on('click', handleClick);
    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      endGesture();
      resetPolygon();
      latest.current.onZonePreview(null);
      container.removeEventListener('mousedown', handleMouseDown, true);
      container.removeEventListener('mousemove', handlePolygonHover);
      map.off('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown, true);
      if (restoreDoubleClickZoom) map.doubleClickZoom.enable();
      if (restoreBoxZoom) map.boxZoom.enable();
      setMapCursor(map, CURSOR_OWNER, null, MAP_CURSOR_PRIORITY.tool);
    };
  }, [armed, map, subTool]);
}
