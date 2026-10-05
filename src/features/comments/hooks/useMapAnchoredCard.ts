import { useLayoutEffect, type RefObject } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { resolvePanelArea, type MapOverlayInsets } from '@/features/map3d/components/panelPlacement';

/**
 * Carte (fil ouvert, saisie) collée à sa bulle, comme chez Figma : à droite de
 * la bulle, son haut aligné sur celui de la bulle ; à gauche si elle ne tient
 * pas ; toujours dans la carte visible (hors des panneaux de l'interface).
 * Suivie à chaque mouvement de la carte par écriture directe du style (pas de
 * rendu React par image). Px de mise en page du conteneur de la carte
 * (`map.project`, `clientWidth`) : justes sous le zoom CSS de l'interface.
 */

/** Taille de la bulle repliée (CommentPin). */
export const COMMENT_PIN_SIZE_PX = 36;
const GAP = 8;
const EDGE = 8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

export function useMapAnchoredCard(
  map: MapboxMap | null,
  anchor: { lng: number; lat: number } | null,
  cardRef: RefObject<HTMLElement | null>,
  overlayInsets: MapOverlayInsets | null | undefined,
): void {
  const lng = anchor?.lng;
  const lat = anchor?.lat;

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!map || !card || lng === undefined || lat === undefined) return;

    const place = () => {
      const container = map.getContainer();
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const point = map.project([lng, lat]);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const area = resolvePanelArea(container.clientWidth, container.clientHeight, width, height, EDGE, overlayInsets);
      const right = area.left + area.width - EDGE;
      let left = point.x + COMMENT_PIN_SIZE_PX + GAP;
      if (left + width > right) left = point.x - GAP - width;
      left = clamp(left, area.left + EDGE, right - width);
      const top = clamp(point.y - COMMENT_PIN_SIZE_PX, area.top + EDGE, area.top + area.height - EDGE - height);
      card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      card.style.visibility = 'visible';
    };

    place();
    map.on('move', place);
    map.on('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(card);
    return () => {
      map.off('move', place);
      map.off('resize', place);
      observer?.disconnect();
    };
  }, [cardRef, lat, lng, map, overlayInsets]);
}
