import { translateAppText } from '@/shared/i18n';
import { formatDistanceLabel } from '../../sections/timeline/TimelineTimelineView/utils';
import {
  CHECKPOINT_END_ICON,
  CHECKPOINT_START_ICON,
  CHECKPOINT_WAYPOINT_ICON,
  PAUSE_DURATION_OPTIONS,
  UI_ICON_URLS,
} from './constants';
import type { CheckpointData } from './types';

/** Gabarits HTML des popups de checkpoint (même habillage que les popups POI). */

export interface PausePopupState {
  favoriteEnabled: boolean;
  pauseDurationMin: number;
  isDurationDropdownOpen: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function buildPausePopupHtml(title: string, state: PausePopupState): string {
  // Défense en profondeur : toute valeur interpolée est échappée ou coercée en nombre.
  const pauseMin = Number(state.pauseDurationMin);
  const safePauseMin = Number.isFinite(pauseMin) ? Math.round(pauseMin) : 0;
  const favoriteEnabled = state.favoriteEnabled === true;
  return `
    <div class="rv-poi-popup__panel">
      <div class="rv-poi-popup__header">
        <button
          type="button"
          class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost${favoriteEnabled ? ' is-active' : ''}"
          aria-label="${escapeHtml(translateAppText('Favori'))}"
          aria-pressed="${favoriteEnabled}"
          data-action="favorite-toggle"
        >
          <img src="${escapeHtml(UI_ICON_URLS.star)}" alt="" class="rv-poi-popup__icon rv-poi-popup__icon--star" />
        </button>
        <div class="rv-poi-popup__title">${escapeHtml(title)}</div>
        <button type="button" class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost" aria-label="${escapeHtml(translateAppText('Fermer'))}" data-action="close">
          <img src="${escapeHtml(UI_ICON_URLS.globe)}" alt="" class="rv-poi-popup__icon" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">${escapeHtml(translateAppText('Type'))}</div>
        <div class="rv-poi-popup__select" aria-label="${escapeHtml(translateAppText('Type de POI'))}" role="presentation">
          <span class="rv-poi-popup__type-icon-wrap">
            <img src="${escapeHtml(UI_ICON_URLS.pausePin)}" alt="" class="rv-poi-popup__type-icon" />
          </span>
          <span class="rv-poi-popup__select-value">${escapeHtml(translateAppText('Pause'))}</span>
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">${escapeHtml(translateAppText('Durée'))}</div>
        <div class="rv-poi-popup__select-wrap">
          <button
            type="button"
            class="rv-poi-popup__select rv-poi-popup__select--duration"
            aria-label="${escapeHtml(translateAppText('Durée de pause'))}"
            data-action="pause-duration"
            aria-haspopup="listbox"
            aria-expanded="${state.isDurationDropdownOpen === true}"
          >
            <span class="rv-poi-popup__select-value">${safePauseMin} min</span>
            <img src="${escapeHtml(UI_ICON_URLS.chevron)}" alt="" class="rv-poi-popup__chevron" />
          </button>
          ${
            state.isDurationDropdownOpen
              ? `
            <div class="rv-dropdown rv-poi-popup__dropdown" role="listbox" aria-label="${escapeHtml(translateAppText('Durée de pause'))}">
              ${PAUSE_DURATION_OPTIONS.map((dur) => {
                const selected = dur === state.pauseDurationMin;
                return `
                  <div
                    class="rv-dropdown__item rv-poi-popup__dropdown-option${selected ? ' is-selected' : ''}"
                    role="option"
                    data-duration="${dur}"
                    aria-selected="${selected}"
                  >
                    <span class="rv-dropdown__label">${dur} min</span>
                  </div>
                `;
              }).join('')}
            </div>
          `
              : ''
          }
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__action-row rv-poi-popup__action-row--delete" data-action="delete">
        <span class="rv-poi-popup__utility-icon-wrap">
          <img src="${escapeHtml(UI_ICON_URLS.trash)}" alt="" class="rv-poi-popup__utility-icon" />
        </span>
        <span class="rv-poi-popup__action-label rv-poi-popup__action-label--delete">${escapeHtml(translateAppText('Supprimer'))}</span>
      </button>
    </div>
  `;
}

export function buildWaypointPopupHtml(title: string, state: { favoriteEnabled: boolean }): string {
  const favoriteEnabled = state.favoriteEnabled === true;
  return `
    <div class="rv-poi-popup__panel">
      <div class="rv-poi-popup__header">
        <button
          type="button"
          class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost${favoriteEnabled ? ' is-active' : ''}"
          aria-label="${escapeHtml(translateAppText('Favori'))}"
          aria-pressed="${favoriteEnabled}"
          data-action="favorite-toggle"
        >
          <img src="${escapeHtml(UI_ICON_URLS.star)}" alt="" class="rv-poi-popup__icon rv-poi-popup__icon--star" />
        </button>
        <div class="rv-poi-popup__title">${escapeHtml(title)}</div>
        <button type="button" class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost" aria-label="${escapeHtml(translateAppText('Fermer'))}" data-action="close">
          <img src="${escapeHtml(UI_ICON_URLS.globe)}" alt="" class="rv-poi-popup__icon" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">${escapeHtml(translateAppText('Type'))}</div>
        <div class="rv-poi-popup__select" aria-label="${escapeHtml(translateAppText('Type de POI'))}" role="presentation">
          <span class="rv-poi-popup__type-icon-wrap">
            <img src="${escapeHtml(CHECKPOINT_WAYPOINT_ICON)}" alt="" class="rv-poi-popup__type-icon" />
          </span>
          <span class="rv-poi-popup__select-value">${escapeHtml(translateAppText('Waypoint'))}</span>
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__action-row rv-poi-popup__action-row--delete" data-action="delete">
        <span class="rv-poi-popup__utility-icon-wrap">
          <img src="${escapeHtml(UI_ICON_URLS.trash)}" alt="" class="rv-poi-popup__utility-icon" />
        </span>
        <span class="rv-poi-popup__action-label rv-poi-popup__action-label--delete">${escapeHtml(translateAppText('Supprimer'))}</span>
      </button>
    </div>
  `;
}

export function buildEndpointPopupHtml(data: CheckpointData): string {
  const isStart = data.kind === 'start';
  const kindLabel = isStart ? translateAppText('Départ') : translateAppText('Arrivée');
  const title = data.label && data.label !== translateAppText('Rechercher un lieu') ? data.label : kindLabel;
  const distanceKm = isStart ? 0 : data.distanceKm;
  const rows: string[] = [
    buildPopupInfoRow(
      translateAppText('Type'),
      kindLabel,
      isStart ? CHECKPOINT_START_ICON : CHECKPOINT_END_ICON,
    ),
  ];
  if (distanceKm != null && Number.isFinite(distanceKm)) {
    rows.push(buildPopupInfoRow(translateAppText('Distance'), formatDistanceLabel(distanceKm)));
  }
  if (data.timeLabel) {
    rows.push(
      buildPopupInfoRow(
        isStart ? translateAppText('Heure de départ') : translateAppText('Arrivée estimée'),
        data.timeLabel,
      ),
    );
  }
  if (!isStart && data.durationLabel) {
    rows.push(buildPopupInfoRow(translateAppText('Durée totale'), data.durationLabel));
  }

  return `
    <div class="rv-poi-popup__panel">
      <div class="rv-poi-popup__header">
        <div class="rv-poi-popup__title">${escapeHtml(title)}</div>
        <button type="button" class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost" aria-label="${escapeHtml(translateAppText('Fermer'))}" data-action="close">
          <img src="${escapeHtml(UI_ICON_URLS.globe)}" alt="" class="rv-poi-popup__icon" />
        </button>
      </div>
      ${rows.map((row) => `<div class="rv-poi-popup__divider"></div>${row}`).join('')}
    </div>
  `;
}

/** Ligne « libellé · valeur » en lecture seule, même gabarit que la ligne Type. */
function buildPopupInfoRow(label: string, value: string, iconSrc?: string): string {
  const icon = iconSrc
    ? `<span class="rv-poi-popup__type-icon-wrap"><img src="${escapeHtml(iconSrc)}" alt="" class="rv-poi-popup__type-icon" /></span>`
    : '';
  return `
    <div class="rv-poi-popup__field-row">
      <div class="rv-poi-popup__field-label">${escapeHtml(label)}</div>
      <div class="rv-poi-popup__select" role="presentation">
        ${icon}
        <span class="rv-poi-popup__select-value">${escapeHtml(value)}</span>
      </div>
    </div>
  `;
}
