import mapboxgl from 'mapbox-gl';
import { translateAppText } from '@/shared/i18n';
import { MARKER_MAX_SCREEN_SCALE } from './constants';
import { getEndpointPopupOffset, getPausePopupOffset } from './markerVisualState';
import {
  buildEndpointPopupHtml,
  buildPausePopupHtml,
  buildWaypointPopupHtml,
  type PausePopupState,
} from './popupHtml';
import type { CheckpointDataRef, CheckpointPopupHandle } from './types';

/**
 * Popups Mapbox des checkpoints : contenu reconstruit depuis `dataRef` à
 * chaque ouverture, actions (favori, durée, suppression) relayées aux callbacks.
 */

function createPopupShell(options: mapboxgl.PopupOptions): mapboxgl.Popup {
  return new mapboxgl.Popup({
    className: 'rv-poi-popup',
    closeButton: false,
    closeOnClick: true,
    focusAfterOpen: false,
    maxWidth: 'none',
    ...options,
  });
}

function bindPopupClose(panel: Element, popup: mapboxgl.Popup): void {
  panel.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    popup.remove();
  });
}

export function createEndpointPopup(
  dataRef: CheckpointDataRef,
  callbacks: { onDelete?: (rowId: string) => void },
): CheckpointPopupHandle {
  const popup = createPopupShell({ offset: getEndpointPopupOffset(1) });
  const container = document.createElement('div');

  const refresh = () => {
    container.innerHTML = buildEndpointPopupHtml(dataRef.current);
    const panel = container.firstElementChild;
    if (!panel) return;
    bindPopupClose(panel, popup);

    panel.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rowId = dataRef.current.rowId;
      popup.remove();
      if (rowId) callbacks.onDelete?.(rowId);
    });
  };

  refresh();
  popup.on('open', refresh);
  popup.setDOMContent(container);
  return {
    popup,
    sync: () => {
      if (popup.isOpen()) refresh();
    },
  };
}

export function createPausePopup(
  dataRef: CheckpointDataRef,
  callbacks: {
    onChangeDuration?: (id: string, durationMin: number) => void;
    onDelete?: (id: string) => void;
    onToggleFavorite?: (id: string, favorite: boolean) => void;
  },
): CheckpointPopupHandle {
  const popup = createPopupShell({ offset: getPausePopupOffset(MARKER_MAX_SCREEN_SCALE) });

  const readState = (): Pick<PausePopupState, 'favoriteEnabled' | 'pauseDurationMin'> => ({
    favoriteEnabled: dataRef.current.favorite ?? false,
    pauseDurationMin: dataRef.current.durationMin || 15,
  });
  const state: PausePopupState = { ...readState(), isDurationDropdownOpen: false };
  const pauseId = () => dataRef.current.pauseId ?? '';

  const container = document.createElement('div');

  const refresh = () => {
    container.innerHTML = buildPausePopupHtml(dataRef.current.label || translateAppText('Pause'), state);
    const panel = container.firstElementChild;
    if (!panel) return;

    bindPopupClose(panel, popup);

    panel.querySelector('[data-action="favorite-toggle"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.favoriteEnabled = !state.favoriteEnabled;
      state.isDurationDropdownOpen = false;
      callbacks.onToggleFavorite?.(pauseId(), state.favoriteEnabled);
      refresh();
    });

    panel.querySelector('[data-action="pause-duration"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.isDurationDropdownOpen = !state.isDurationDropdownOpen;
      refresh();
    });

    for (const opt of panel.querySelectorAll<HTMLDivElement>('.rv-poi-popup__dropdown-option')) {
      opt.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const dur = Number(opt.dataset.duration);
        if (Number.isFinite(dur)) {
          state.pauseDurationMin = dur;
          state.isDurationDropdownOpen = false;
          callbacks.onChangeDuration?.(pauseId(), dur);
          refresh();
        }
      });
    }

    panel.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      popup.remove();
      callbacks.onDelete?.(pauseId());
    });
  };

  const syncFromData = () => {
    Object.assign(state, readState());
  };

  refresh();
  popup.on('open', () => {
    syncFromData();
    state.isDurationDropdownOpen = false;
    refresh();
  });
  popup.setDOMContent(container);
  return {
    popup,
    sync: () => {
      if (!popup.isOpen()) return;
      syncFromData();
      refresh();
    },
  };
}

export function createWaypointPopup(
  dataRef: CheckpointDataRef,
  callbacks: {
    onDelete?: (id: string) => void;
    onToggleFavorite?: (id: string, favorite: boolean) => void;
  },
): CheckpointPopupHandle {
  const popup = createPopupShell({ anchor: 'bottom-left', offset: [16, -16] });

  const state = { favoriteEnabled: dataRef.current.favorite ?? false };
  const waypointId = () => dataRef.current.waypointId ?? '';

  const container = document.createElement('div');

  const refresh = () => {
    container.innerHTML = buildWaypointPopupHtml(dataRef.current.label || translateAppText('Waypoint'), state);
    const panel = container.firstElementChild;
    if (!panel) return;

    bindPopupClose(panel, popup);

    panel.querySelector('[data-action="favorite-toggle"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.favoriteEnabled = !state.favoriteEnabled;
      callbacks.onToggleFavorite?.(waypointId(), state.favoriteEnabled);
      refresh();
    });

    panel.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      popup.remove();
      callbacks.onDelete?.(waypointId());
    });
  };

  const syncFromData = () => {
    state.favoriteEnabled = dataRef.current.favorite ?? false;
  };

  refresh();
  popup.on('open', () => {
    syncFromData();
    refresh();
  });
  popup.setDOMContent(container);
  return {
    popup,
    sync: () => {
      if (!popup.isOpen()) return;
      syncFromData();
      refresh();
    },
  };
}
