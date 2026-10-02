import type { Map as MapboxMap, Popup, PopupOptions } from 'mapbox-gl';
import { getMapOverlayInsets, subscribeMapOverlayInsets } from './mapOverlayInsets';
import './mapPopupSafeArea.css';

/**
 * Garde une popup Mapbox (fiche POI, alerte, étape…) entièrement dans la carte
 * visible, jamais sous les panneaux du dashboard (latéraux, barre + panneau
 * central du bas — `mapOverlayInsets`).
 *
 * L'ancrage automatique de Mapbox ne connaît que les bords du conteneur, qui
 * s'étend sous les panneaux : près du haut de l'écran, la fiche s'ouvrait vers
 * le bas, sous le panneau central. Ici, à chaque mouvement :
 *  1. l'ancrage est choisi parmi les 8 possibles pour que la fiche (plus ses
 *     menus déroulants ouverts) tienne dans la zone libre, l'ancrage courant
 *     gardé tant qu'il tient (pas de bascule pendant un déplacement) ;
 *  2. si aucun ne tient, la carte se décale une fois (ouverture, contenu qui
 *     grandit — jamais pendant que l'utilisateur la manipule) pour amener la
 *     fiche dans la zone libre ;
 *  3. en dernier recours (point sous un panneau, carte trop petite), la fiche
 *     est poussée dans la zone libre (`translate`, indépendant du `transform`
 *     posé par Mapbox), sa pointe masquée ; plus haute que la zone, elle défile.
 */

type PopupAnchor = NonNullable<PopupOptions['anchor']>;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface SafeArea extends Box {
  containerWidth: number;
  containerHeight: number;
}

interface PopupMetrics {
  width: number;
  /** Hauteur du contenu sans plafond. */
  naturalHeight: number;
  /** Profondeur de la pointe (0 si masquée). */
  tipDepth: number;
  /** Débordement des menus ouverts au-delà du contenu, par côté. */
  overflow: Box;
}

const EDGE_PADDING = 8;
/** En dessous, la zone libre n'a plus de sens : tout le conteneur sert. */
const MIN_SAFE_SPAN_PX = 120;
const PAN_DURATION_MS = 280;
/** Recadrages successifs autorisés (le relief décale un peu la première visée). */
const PAN_ATTEMPTS = 2;
const CAPPED_CLASS = 'rv-map-popup--capped';
const DETACHED_CLASS = 'rv-map-popup--detached';
const MAX_HEIGHT_VAR = '--rv-map-popup-max-height';
/** Éléments absolus qui dépassent du contenu (menus déroulants des fiches). */
const OVERFLOW_SELECTOR = '.rv-dropdown';

const ANCHORS: readonly PopupAnchor[] = [
  'bottom',
  'top',
  'right',
  'left',
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
];

const ZERO_BOX: Box = { left: 0, top: 0, right: 0, bottom: 0 };

function toXY(value: unknown): [number, number] {
  if (Array.isArray(value)) return [Number(value[0]) || 0, Number(value[1]) || 0];
  if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
    const point = value as { x: unknown; y: unknown };
    return [Number(point.x) || 0, Number(point.y) || 0];
  }
  return [0, 0];
}

/** Même normalisation que Mapbox (`normalizeOffset`). */
function offsetFor(offset: PopupOptions['offset'], anchor: PopupAnchor): [number, number] {
  if (offset == null) return [0, 0];
  if (typeof offset === 'number') {
    const corner = Math.round(Math.sqrt(0.5 * offset * offset));
    switch (anchor) {
      case 'top': return [0, offset];
      case 'top-left': return [corner, corner];
      case 'top-right': return [-corner, corner];
      case 'bottom': return [0, -offset];
      case 'bottom-left': return [corner, -corner];
      case 'bottom-right': return [-corner, -corner];
      case 'left': return [offset, 0];
      case 'right': return [-offset, 0];
      default: return [0, 0];
    }
  }
  if (Array.isArray(offset) || ('x' in offset && 'y' in offset)) return toXY(offset);
  return toXY((offset as Partial<Record<PopupAnchor, unknown>>)[anchor]);
}

/** Boîte de la popup pour un ancrage (mêmes translations que Mapbox). */
function popupBox(anchor: PopupAnchor, x: number, y: number, width: number, height: number): Box {
  const left = anchor.endsWith('left') ? x : anchor.endsWith('right') ? x - width : x - width / 2;
  const top = anchor.startsWith('top') ? y : anchor.startsWith('bottom') ? y - height : y - height / 2;
  return { left, top, right: left + width, bottom: top + height };
}

function overflowAmount(box: Box, area: Box): number {
  return Math.max(0, area.left - box.left)
    + Math.max(0, box.right - area.right)
    + Math.max(0, area.top - box.top)
    + Math.max(0, box.bottom - area.bottom);
}

/** Décalage qui ramène [start, end] dans [min, max] (début aligné si trop grand). */
function shiftInto(start: number, end: number, min: number, max: number): number {
  if (end - start > max - min) return min - start;
  if (start < min) return min - start;
  if (end > max) return max - end;
  return 0;
}

function measureMenuOverflow(content: HTMLElement): Box {
  const menus = content.querySelectorAll<HTMLElement>(OVERFLOW_SELECTOR);
  if (menus.length === 0) return ZERO_BOX;
  const base = content.getBoundingClientRect();
  // Rectangles écran → px de mise en page (zoom CSS de l'interface).
  const scale = content.offsetWidth > 0 ? base.width / content.offsetWidth : 1;
  if (!(scale > 0)) return ZERO_BOX;
  const overflow = { ...ZERO_BOX };
  menus.forEach((menu) => {
    const rect = menu.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return;
    overflow.left = Math.max(overflow.left, (base.left - rect.left) / scale);
    overflow.top = Math.max(overflow.top, (base.top - rect.top) / scale);
    overflow.right = Math.max(overflow.right, (rect.right - base.right) / scale);
    overflow.bottom = Math.max(overflow.bottom, (rect.bottom - base.bottom) / scale);
  });
  return overflow;
}

function resolveSafeArea(map: MapboxMap): SafeArea {
  const container = map.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  const insets = getMapOverlayInsets(map);

  let left = insets.left + EDGE_PADDING;
  let right = width - insets.right - EDGE_PADDING;
  if (right - left < MIN_SAFE_SPAN_PX) {
    left = EDGE_PADDING;
    right = width - EDGE_PADDING;
  }
  let top = insets.top + EDGE_PADDING;
  let bottom = height - insets.bottom - EDGE_PADDING;
  if (bottom - top < MIN_SAFE_SPAN_PX) {
    top = EDGE_PADDING;
    bottom = height - EDGE_PADDING;
  }
  return { left, top, right, bottom, containerWidth: width, containerHeight: height };
}

/**
 * Branche le placement sur une popup (ouverte maintenant ou plus tard, y compris
 * via `marker.setPopup`). Rien ne reste branché sur la carte quand elle est
 * fermée ; la fonction rendue détache la popup.
 */
export function keepPopupInVisibleMap(popup: Popup, map: MapboxMap): () => void {
  const preferredAnchor = popup.options.anchor;
  const candidates: readonly PopupAnchor[] = preferredAnchor
    ? [preferredAnchor, ...ANCHORS.filter((anchor) => anchor !== preferredAnchor)]
    : ANCHORS;
  let stopSession: (() => void) | null = null;

  const handleClose = () => {
    stopSession?.();
    stopSession = null;
  };
  const handleOpen = () => {
    handleClose();
    stopSession = startSession();
  };

  function startSession(): (() => void) | null {
    const element = popup.getElement();
    const content = element?.querySelector<HTMLElement>('.mapboxgl-popup-content') ?? null;
    if (!element || !content) return null;

    let metrics: PopupMetrics | null = null;
    let capped = false;
    let detached = false;
    let panBudget = PAN_ATTEMPTS;
    let frameId: number | null = null;

    const measure = () => {
      const tip = element.querySelector<HTMLElement>('.mapboxgl-popup-tip');
      const borders = content.offsetHeight - content.clientHeight;
      metrics = {
        width: content.offsetWidth,
        naturalHeight: capped ? content.scrollHeight + borders : content.offsetHeight,
        tipDepth: tip ? Math.min(tip.offsetWidth, tip.offsetHeight) : 0,
        overflow: measureMenuOverflow(content),
      };
    };

    const setDetached = (next: boolean) => {
      if (next === detached) return;
      detached = next;
      if (next) popup.addClassName(DETACHED_CLASS);
      else popup.removeClassName(DETACHED_CLASS);
    };

    const place = () => {
      if (!popup.isOpen()) return;
      if (!metrics) measure();
      const { width, naturalHeight, tipDepth, overflow } = metrics!;
      const area = resolveSafeArea(map);

      // Plus haute que la zone libre : plafonnée, le contenu défile.
      const availableHeight = Math.max(0, Math.floor(area.bottom - area.top - tipDepth));
      const shouldCap = naturalHeight > availableHeight + 0.5;
      if (shouldCap) {
        element.style.setProperty(MAX_HEIGHT_VAR, `${availableHeight}px`);
        if (!capped) {
          capped = true;
          popup.addClassName(CAPPED_CLASS);
        }
      } else if (capped) {
        capped = false;
        popup.removeClassName(CAPPED_CLASS);
        element.style.removeProperty(MAX_HEIGHT_VAR);
      }
      const height = shouldCap ? availableHeight : naturalHeight;

      const lngLat = popup.getLngLat();
      if (!lngLat) return;
      const point = map.project(lngLat, popup.getAltitude());
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

      const current = popup.options.anchor;
      const ordered = current && current !== candidates[0]
        ? [current, ...candidates.filter((anchor) => anchor !== current)]
        : candidates;
      let bestAnchor = ordered[0]!;
      let bestBox: Box | null = null;
      let bestOverflow = Infinity;
      for (const anchor of ordered) {
        const [offsetX, offsetY] = offsetFor(popup.options.offset, anchor);
        const vertical = anchor !== 'left' && anchor !== 'right';
        const box = popupBox(
          anchor,
          point.x + offsetX,
          point.y + offsetY,
          width + (vertical ? 0 : tipDepth),
          height + (vertical ? tipDepth : 0),
        );
        const footprint: Box = {
          left: box.left - overflow.left,
          top: box.top - overflow.top,
          right: box.right + overflow.right,
          bottom: box.bottom + overflow.bottom,
        };
        const amount = overflowAmount(footprint, area);
        if (amount < bestOverflow) {
          bestAnchor = anchor;
          bestBox = footprint;
          bestOverflow = amount;
        }
        if (amount === 0) break;
      }
      if (!bestBox) return;

      if (popup.options.anchor !== bestAnchor) {
        popup.options.anchor = bestAnchor;
        popup.setLngLat(lngLat);
      }

      let dx = shiftInto(bestBox.left, bestBox.right, area.left, area.right);
      let dy = shiftInto(bestBox.top, bestBox.bottom, area.top, area.bottom);

      const needsPan = Math.abs(dx) >= 1 || Math.abs(dy) >= 1;
      if (!needsPan) {
        panBudget = 0;
      } else if (panBudget > 0 && !map.isMoving()) {
        panBudget -= 1;
        // Le point visé à sa place exacte à l'écran (`center` + `offset` :
        // juste en perspective, contrairement à un `panBy` en pixels).
        const padding = map.getPadding();
        const centerX = (area.containerWidth + (padding.left ?? 0) - (padding.right ?? 0)) / 2;
        const centerY = (area.containerHeight + (padding.top ?? 0) - (padding.bottom ?? 0)) / 2;
        map.easeTo({
          center: lngLat,
          offset: [point.x + dx - centerX, point.y + dy - centerY],
          duration: PAN_DURATION_MS,
        });
      }

      // Point sorti de la carte : la fiche le suit au lieu de rester collée au bord.
      const pointInMap = point.x >= 0
        && point.y >= 0
        && point.x <= area.containerWidth
        && point.y <= area.containerHeight;
      if (!pointInMap) {
        dx = 0;
        dy = 0;
      }
      const shifted = Math.abs(dx) >= 1 || Math.abs(dy) >= 1;
      element.style.translate = shifted ? `${Math.round(dx)}px ${Math.round(dy)}px` : '';
      setDetached(shifted);
    };

    const remeasure = () => {
      measure();
      place();
    };

    const schedule = (requestPan: boolean) => {
      if (requestPan) panBudget = PAN_ATTEMPTS;
      if (frameId != null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        remeasure();
      });
    };

    const handleMove = () => place();
    // `isMoving()` est encore vrai pendant `moveend` : recadrage à la frame suivante.
    const handleMoveEnd = () => schedule(false);
    // L'utilisateur reprend la main (glisser, molette…) : plus de recadrage.
    const handleMoveStart = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) panBudget = 0;
    };
    const handleContentChange = () => schedule(true);

    map.on('move', handleMove);
    map.on('moveend', handleMoveEnd);
    map.on('resize', remeasure);
    map.on('movestart', handleMoveStart);
    const unsubscribeInsets = subscribeMapOverlayInsets(map, () => schedule(false));

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(handleContentChange);
    resizeObserver?.observe(content);
    // Menus déroulants / état de la fiche reconstruits sans changer sa taille.
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(handleContentChange);
    mutationObserver?.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });

    remeasure();

    return () => {
      map.off('move', handleMove);
      map.off('moveend', handleMoveEnd);
      map.off('resize', remeasure);
      map.off('movestart', handleMoveStart);
      unsubscribeInsets();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (frameId != null) window.cancelAnimationFrame(frameId);
      element.style.translate = '';
      element.style.removeProperty(MAX_HEIGHT_VAR);
      if (capped) popup.removeClassName(CAPPED_CLASS);
      setDetached(false);
      popup.options.anchor = preferredAnchor;
    };
  }

  popup.on('open', handleOpen);
  popup.on('close', handleClose);
  if (popup.isOpen()) handleOpen();

  return () => {
    popup.off('open', handleOpen);
    popup.off('close', handleClose);
    handleClose();
  };
}
