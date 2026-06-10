// POI map popup: HTML construction, action bindings and state resolution.
//
// The popup is a Mapbox `Popup` attached to each POI marker. Its content is
// rebuilt on every `open` (and after every toggle) through a `refresh`
// callback, so the displayed state always reflects the latest itinerary
// data — actions are resolved lazily via a getter, never captured at
// marker-creation time.

import type { PoiFeature } from '../types';
import { POI_LABELS } from '../types';
import { getPoiIconUrl } from './poi-icons';

export interface PoiPopupState {
  favoriteEnabled: boolean;
  pauseEnabled: boolean;
  pauseDurationMin: number;
  manualTraceEnabled: boolean;
}

export interface UsePoiPopupActions {
  getPopupState?: (feature: PoiFeature) => PoiPopupState;
  onStartHere?: (feature: PoiFeature) => void;
  onAddWaypoint?: (feature: PoiFeature) => void;
  onFinishHere?: (feature: PoiFeature) => void;
  onCyclePauseDuration?: (feature: PoiFeature) => void;
  onToggleFavorite?: (feature: PoiFeature, nextEnabled: boolean) => void;
  onTogglePause?: (
    feature: PoiFeature,
    nextEnabled: boolean,
    durationMin: number,
  ) => void;
  onToggleManualTrace?: (feature: PoiFeature, nextEnabled: boolean) => void;
  onOpenStreetView?: (feature: PoiFeature) => void;
  onDelete?: (feature: PoiFeature) => void;
}

const DEFAULT_POPUP_STATE: PoiPopupState = {
  favoriteEnabled: false,
  pauseEnabled: false,
  pauseDurationMin: 5,
  manualTraceEnabled: false,
};

const UI_ICON_URLS = {
  rightClick: '/right-click-icons',
  star: '/svgv2/icone/star-01.svg',
  globe: '/right-click-icons/globe-06.svg',
  chevron: '/svgv2/icone/chevron-down.svg',
  check: '/svgv2/icone/check.svg',
  trash: '/right-click-icons/trash-01.svg',
} as const;

export function resolvePopupState(
  actions: UsePoiPopupActions,
  feature: PoiFeature,
  nextState?: PoiPopupState,
): PoiPopupState {
  return {
    ...DEFAULT_POPUP_STATE,
    ...(actions.getPopupState?.(feature) ?? {}),
    ...(nextState ?? {}),
  };
}

function buildPopupHtml(feature: PoiFeature, state: PoiPopupState): string {
  const name = feature.name?.trim() || 'Sans nom';
  const category = POI_LABELS[feature.category] ?? feature.category.replace(/_/g, ' ');
  const pauseDurationLabel = formatPauseDuration(state.pauseDurationMin);

  return `
    <div class="rv-poi-popup__panel">
      <div class="rv-poi-popup__header">
        <button
          type="button"
          class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost${state.favoriteEnabled ? ' is-active' : ''}"
          aria-label="Favori"
          aria-pressed="${state.favoriteEnabled}"
          data-action="favorite-toggle"
        >
          <img src="${UI_ICON_URLS.star}" alt="" class="rv-poi-popup__icon rv-poi-popup__icon--star" />
        </button>
        <div class="rv-poi-popup__title">${escapeHtml(name)}</div>
        <button type="button" class="rv-poi-popup__icon-btn rv-poi-popup__icon-btn--ghost" aria-label="Ouvrir Street View" data-action="streetview">
          <img src="${UI_ICON_URLS.globe}" alt="" class="rv-poi-popup__icon" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row">
        <div class="rv-poi-popup__field-label">Type</div>
        <div class="rv-poi-popup__select" aria-label="Type de POI" role="presentation">
          <span class="rv-poi-popup__type-icon-wrap">
            <img src="${getPoiIconUrl(feature.category, state.favoriteEnabled)}" alt="" class="rv-poi-popup__type-icon" />
          </span>
          <span class="rv-poi-popup__select-value">${escapeHtml(category)}</span>
        </div>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <div class="rv-poi-popup__field-row rv-poi-popup__field-row--compact">
        <button type="button" class="rv-poi-popup__toggle-wrap rv-poi-popup__toggle-wrap--button" data-action="pause-toggle" aria-pressed="${state.pauseEnabled}">
          <span class="rv-poi-popup__checkbox${state.pauseEnabled ? ' is-active' : ''}">
            <img src="${UI_ICON_URLS.check}" alt="" class="rv-poi-popup__checkbox-icon" />
          </span>
          <span class="rv-poi-popup__toggle-label">Pause</span>
        </button>
        <button type="button" class="rv-poi-popup__select rv-poi-popup__select--duration" aria-label="Durée de pause" data-action="pause-duration">
          <span class="rv-poi-popup__select-value">${pauseDurationLabel}</span>
          <img src="${UI_ICON_URLS.chevron}" alt="" class="rv-poi-popup__chevron" />
        </button>
      </div>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__toggle-row rv-poi-popup__toggle-row--button" data-action="manual-trace" aria-pressed="${state.manualTraceEnabled}">
        <span class="rv-poi-popup__checkbox${state.manualTraceEnabled ? ' is-active' : ''}">
          <img src="${UI_ICON_URLS.check}" alt="" class="rv-poi-popup__checkbox-icon" />
        </span>
        <span class="rv-poi-popup__toggle-label rv-poi-popup__toggle-label--solid">Tracé manuel</span>
      </button>

      <div class="rv-poi-popup__divider"></div>

      <button type="button" class="rv-poi-popup__action-row" data-action="start-here">
        <span class="rv-poi-popup__action-icon-wrap" aria-hidden="true">
          <img src="${UI_ICON_URLS.rightClick}/start.svg" alt="" class="rv-poi-popup__action-icon rv-poi-popup__action-icon--pin" />
        </span>
        <span class="rv-poi-popup__action-label">Démarrer ici</span>
      </button>

      <button type="button" class="rv-poi-popup__action-row" data-action="add-waypoint">
        <span class="rv-poi-popup__action-icon-wrap" aria-hidden="true">
          <img src="${UI_ICON_URLS.rightClick}/ajouteruneetape.svg" alt="" class="rv-poi-popup__action-icon rv-poi-popup__action-icon--pin" />
        </span>
        <span class="rv-poi-popup__action-label">Ajouter une étape</span>
      </button>

      <button type="button" class="rv-poi-popup__action-row" data-action="finish-here">
        <span class="rv-poi-popup__action-icon-wrap" aria-hidden="true">
          <img src="${UI_ICON_URLS.rightClick}/finish.svg" alt="" class="rv-poi-popup__action-icon rv-poi-popup__action-icon--pin" />
        </span>
        <span class="rv-poi-popup__action-label">Finir ici</span>
      </button>

      <button type="button" class="rv-poi-popup__action-row rv-poi-popup__action-row--delete" data-action="delete">
        <span class="rv-poi-popup__utility-icon-wrap">
          <img src="${UI_ICON_URLS.trash}" alt="" class="rv-poi-popup__utility-icon" />
        </span>
        <span class="rv-poi-popup__action-label rv-poi-popup__action-label--delete">Supprimer</span>
      </button>
    </div>
  `;
}

/**
 * Build the popup DOM and wire every `[data-action]` button.
 *
 * `actions` must be the CURRENT actions object (resolve it through a ref
 * right before calling); `refresh` re-renders the popup with an optimistic
 * next state after a toggle.
 */
export function buildPopupContent(
  feature: PoiFeature,
  state: PoiPopupState,
  actions: UsePoiPopupActions,
  refresh: (nextState?: PoiPopupState) => void,
): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = buildPopupHtml(feature, state);
  const panel = root.firstElementChild;
  if (!(panel instanceof HTMLDivElement)) {
    return document.createElement('div');
  }

  const bindClick = (selector: string, handler: () => void) => {
    for (const node of panel.querySelectorAll<HTMLButtonElement>(selector)) {
      node.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handler();
      });
    }
  };

  bindClick('[data-action="streetview"]', () => {
    actions.onOpenStreetView?.(feature);
  });

  bindClick('[data-action="favorite-toggle"]', () => {
    const nextState = { ...state, favoriteEnabled: !state.favoriteEnabled };
    actions.onToggleFavorite?.(feature, nextState.favoriteEnabled);
    refresh(nextState);
  });

  bindClick('[data-action="pause-toggle"]', () => {
    const nextState = { ...state, pauseEnabled: !state.pauseEnabled };
    actions.onTogglePause?.(feature, nextState.pauseEnabled, nextState.pauseDurationMin);
    refresh(nextState);
  });

  bindClick('[data-action="pause-duration"]', () => {
    actions.onCyclePauseDuration?.(feature);
  });

  bindClick('[data-action="manual-trace"]', () => {
    const nextState = { ...state, manualTraceEnabled: !state.manualTraceEnabled };
    actions.onToggleManualTrace?.(feature, nextState.manualTraceEnabled);
    refresh(nextState);
  });

  bindClick('[data-action="start-here"]', () => {
    actions.onStartHere?.(feature);
  });

  bindClick('[data-action="add-waypoint"]', () => {
    actions.onAddWaypoint?.(feature);
  });

  bindClick('[data-action="finish-here"]', () => {
    actions.onFinishHere?.(feature);
  });

  bindClick('[data-action="delete"]', () => {
    actions.onDelete?.(feature);
  });

  return panel;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPauseDuration(durationMin: number): string {
  const safeDuration = Math.max(1, Math.round(durationMin || 5));
  return `${safeDuration} min`;
}
