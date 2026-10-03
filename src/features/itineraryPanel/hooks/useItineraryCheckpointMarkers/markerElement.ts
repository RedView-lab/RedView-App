import { translateAppText } from '@/shared/i18n';
import { writeTracePointDataset } from '../../lib/tracer/tracePointDataset';
import {
  CHECKPOINT_END_ICON,
  CHECKPOINT_PAUSE_ICON,
  CHECKPOINT_START_ICON,
  CHECKPOINT_WAYPOINT_ICON,
  UI_ICON_URLS,
} from './constants';
import type { CheckpointData, CheckpointKind } from './types';

/** Éléments DOM des marqueurs de checkpoint : création et mise à jour en place. */

/** Pastille étoile des marqueurs pause / waypoint favoris. */
function createFavoriteBadge(): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'rv-poi-marker__favorite-badge';
  badge.setAttribute('aria-hidden', 'true');

  const badgeIcon = document.createElement('img');
  badgeIcon.className = 'rv-poi-marker__favorite-badge-icon';
  badgeIcon.src = UI_ICON_URLS.star;
  badgeIcon.alt = '';
  badgeIcon.draggable = false;
  badge.appendChild(badgeIcon);
  return badge;
}

export function createMarkerElement(
  kind: CheckpointKind,
  label: string,
  durationMin?: number | null,
  distanceKm?: number | null,
  favorite?: boolean,
): HTMLElement {
  if (kind === 'pause' || kind === 'waypoint') {
    const el = document.createElement('button');
    el.type = 'button';
    const isPin = kind === 'pause';
    el.className = `rv-poi-marker rv-poi-marker--${kind} ${isPin ? 'rv-poi-marker--pin' : kind === 'waypoint' ? '' : 'rv-poi-marker--round'}${favorite ? ' is-favorite rv-poi-marker--favorite' : ''}`;
    el.style.zIndex = favorite ? '50' : '20';

    const kindName = kind === 'pause' ? translateAppText('Pause') : translateAppText('Waypoint');
    const durSuffix = kind === 'pause' && durationMin ? ` · ${durationMin} min` : '';
    const distSuffix = distanceKm != null && distanceKm > 0 ? ` (${distanceKm.toFixed(1)} km)` : '';
    const favSuffix = favorite ? ` ★` : '';
    const title =
      label && label !== 'Pause' && label !== 'Waypoint'
        ? `${label}${durSuffix}${distSuffix}${favSuffix}`
        : `${kindName}${durSuffix}${distSuffix}${favSuffix}`;
    el.title = title;
    el.setAttribute('aria-label', title);

    const inner = document.createElement('div');
    inner.className = 'rv-poi-marker__inner';

    const img = document.createElement('img');
    img.className = 'rv-poi-marker__img';
    img.src = kind === 'pause' ? CHECKPOINT_PAUSE_ICON : CHECKPOINT_WAYPOINT_ICON;
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    inner.appendChild(img);

    if (kind === 'pause' && durationMin && durationMin > 0) {
      const timeBadge = document.createElement('span');
      timeBadge.className = 'rv-checkpoint-pause__time';
      timeBadge.textContent = `${durationMin} min`;
      inner.appendChild(timeBadge);
    }

    if (favorite) {
      inner.appendChild(createFavoriteBadge());
    }

    el.appendChild(inner);

    el.addEventListener('mouseenter', () => {
      el.style.zIndex = '100';
    });
    el.addEventListener('mouseleave', () => {
      el.style.zIndex = favorite ? '50' : '20';
    });

    return el;
  }

  const el = document.createElement('div');
  el.className = `rv-checkpoint-marker rv-checkpoint-marker--${kind}`;

  const kindName = kind === 'start' ? translateAppText('Départ') : translateAppText('Arrivée');
  const distSuffix = distanceKm != null && distanceKm > 0 ? ` (${distanceKm.toFixed(1)} km)` : '';
  const title = label ? `${kindName} : ${label}${distSuffix}` : `${kindName}${distSuffix}`;
  el.title = title;
  el.setAttribute('aria-label', title);

  const img = document.createElement('img');
  img.className = 'rv-checkpoint-marker__img';
  img.src = kind === 'start' ? CHECKPOINT_START_ICON : CHECKPOINT_END_ICON;
  img.alt = '';
  img.draggable = false;
  img.decoding = 'async';
  el.appendChild(img);

  return el;
}

/**
 * Expose sur l'élément du marqueur de quoi l'identifier depuis un handler DOM
 * générique (utilisé par le drag & drop de l'outil Tracer). Les pauses sont
 * exclues : elles sont positionnées par distance le long du tracé, pas par
 * coordonnées libres.
 */
export function applyTracePointDataset(element: HTMLElement, cp: CheckpointData): void {
  if (cp.kind === 'pause' || !cp.rowId) return;

  writeTracePointDataset(element.dataset, {
    itineraryId: cp.itineraryId,
    rowId: cp.rowId,
    kind: cp.kind,
    lon: cp.coord[0],
    lat: cp.coord[1],
  });
}

/** Met à jour titre, favori et badge d'un marqueur existant dont les données ont changé. */
export function updateMarkerElement(element: HTMLElement, cp: CheckpointData): void {
  let kindName = '';
  if (cp.kind === 'start') kindName = translateAppText('Départ');
  else if (cp.kind === 'end') kindName = translateAppText('Arrivée');
  else if (cp.kind === 'pause') kindName = translateAppText('Pause');
  else kindName = translateAppText('Waypoint');
  const distSuffix = cp.distanceKm != null && cp.distanceKm > 0 ? ` (${cp.distanceKm.toFixed(1)} km)` : '';
  const favSuffix = cp.favorite ? ` ★` : '';
  const isEndpoint = cp.kind === 'start' || cp.kind === 'end';
  const title = isEndpoint
    ? (cp.label ? `${kindName} : ${cp.label}${distSuffix}` : `${kindName}${distSuffix}`)
    : cp.label && cp.label !== 'Pause' && cp.label !== 'Waypoint'
      ? `${cp.label}${distSuffix}${favSuffix}`
      : `${kindName}${distSuffix}${favSuffix}`;
  element.title = title;
  element.setAttribute('aria-label', title);
  applyTracePointDataset(element, cp);

  if (cp.kind === 'pause' || cp.kind === 'waypoint') {
    element.classList.toggle('is-favorite', Boolean(cp.favorite));
    element.classList.toggle('rv-poi-marker--favorite', Boolean(cp.favorite));
    element.style.zIndex = cp.favorite ? '50' : '20';

    const inner = element.querySelector('.rv-poi-marker__inner');
    if (inner) {
      const existingBadge = inner.querySelector('.rv-poi-marker__favorite-badge');
      if (cp.favorite && !existingBadge) {
        inner.appendChild(createFavoriteBadge());
      } else if (!cp.favorite && existingBadge) {
        existingBadge.remove();
      }
    }
  }
}
