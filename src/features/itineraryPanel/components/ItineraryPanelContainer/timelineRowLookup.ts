import type { PoiFeature } from '@/features/poi/types';
import type { SelectPoiOnChartPayload } from '@/features/poi/lib/chartPoiSyncBridge';
import { requestTimelineRowReveal } from '../../sections/timeline/useVirtualRows';
import type { TimelineItem } from '../../types';

/** Lignes de timeline portées par un marqueur de checkpoint (popup dédiée). */
export function isCheckpointKind(
  kind: TimelineItem['kind'],
): kind is 'start' | 'end' | 'pause' | 'waypoint' {
  return kind === 'start' || kind === 'end' || kind === 'pause' || kind === 'waypoint';
}

/** Ligne de feuille de route correspondant à un POI cliqué sur la carte. */
export function findTimelineItemForPoiFeature(
  timeline: TimelineItem[],
  feature: PoiFeature,
): TimelineItem | undefined {
  return timeline.find((item) => {
    if (item.kind === 'poi' && item.osmId != null && item.osmId === feature.id) return true;
    if (item.id === `poi-${feature.id}`) return true;
    if (item.lat != null && item.lon != null) {
      return Math.abs(item.lat - feature.lat) < 0.0001 && Math.abs(item.lon - feature.lon) < 0.0001;
    }
    return false;
  });
}

/** Ligne de feuille de route visée par une demande « ouvrir sur la carte » (graphe). */
export function findTimelineItemForOpenPayload(
  timeline: TimelineItem[],
  payload: SelectPoiOnChartPayload,
): TimelineItem | undefined {
  return timeline.find((item) => {
    if (
      payload.id != null &&
      (String(item.id) === String(payload.id) ||
        (typeof payload.id === 'string' && payload.id.endsWith(`::${item.id}`)) ||
        item.id === `poi-${payload.id}` ||
        String(item.osmId) === String(payload.id))
    ) {
      return true;
    }
    if (payload.osmId != null && String(item.osmId) === String(payload.osmId)) return true;
    if (payload.lat != null && payload.lon != null && item.lat != null && item.lon != null) {
      return Math.abs(item.lat - payload.lat) < 0.0005 && Math.abs(item.lon - payload.lon) < 0.0005;
    }
    return false;
  });
}

/**
 * Centre la ligne `itemId` dans la liste défilante de la feuille de route
 * (défilement doux), en la faisant d'abord monter si la liste est fenêtrée.
 */
export function centerTimelineRowInList(itemId: string): void {
  const tryScroll = (attempts = 6) => {
    const rowEl = document.querySelector<HTMLElement>(`[data-timeline-id="${itemId}"]`);
    if (rowEl) {
      let container: HTMLElement | null = rowEl.parentElement;
      while (container) {
        const style = window.getComputedStyle(container);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && container.scrollHeight > container.clientHeight) {
          break;
        }
        container = container.parentElement;
      }

      // Pas de liste défilante (feuille de route courte) : la ligne est déjà
      // visible. Jamais de scrollIntoView ici : il ferait aussi défiler les
      // coques du dashboard et décalerait toute l'interface.
      if (container) {
        const rowRect = rowEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const targetScrollTop =
          container.scrollTop +
          (rowRect.top - containerRect.top) -
          (container.clientHeight / 2) +
          (rowRect.height / 2);

        container.scrollTo({
          top: Math.max(0, targetScrollTop),
          behavior: 'smooth',
        });
      }
      return;
    }
    // Feuille de route fenêtrée : la ligne hors écran n'est pas montée,
    // on la fait défiler jusqu'à la fenêtre puis on réessaie.
    if (attempts === 6) requestTimelineRowReveal(itemId);
    if (attempts > 0) {
      setTimeout(() => tryScroll(attempts - 1), 50);
    }
  };
  window.requestAnimationFrame(() => tryScroll());
}
