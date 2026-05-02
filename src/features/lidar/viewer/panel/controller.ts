import { ensureViewerPanel } from './template';

export type SnowModeKey = 'off' | 'cover' | 'thickness';

export const POINT_SIZE_MIN = 0.02;
export const POINT_SIZE_MAX = 1.0;
export const DENSITY_SCALE_MIN = 0.01;
export const DENSITY_SCALE_MAX = 1.0;

interface ViewerPanelOptions {
  tileLabel: string;
  locationLabel: string;
  googleMapsUrl: string;
  pointSizePercent?: number;
  densityPercent?: number;
  onPointSizeChange?: (percent: number) => void;
  onDensityChange?: (percent: number) => void;
  onSnowModeChange?: (mode: SnowModeKey) => void;
  onLowQualityClick?: () => void;
}

interface LowQualityButtonState {
  label: string;
  disabled?: boolean;
  title?: string;
}

const SNOW_MODE_LABELS: Record<Exclude<SnowModeKey, 'off'>, string> = {
  cover: 'Couverture neigeuse',
  thickness: 'Epaisseur (cm)',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toSliderPercent(value: number): number {
  return clamp(Math.round(value), 1, 100);
}

function interpolateLog(min: number, max: number, normalized: number): number {
  return min * Math.pow(max / min, normalized);
}

function normalizeLog(value: number, min: number, max: number): number {
  return Math.log(value / min) / Math.log(max / min);
}

export function pointSizeToPercent(pointSize: number): number {
  const normalized = normalizeLog(
    clamp(pointSize, POINT_SIZE_MIN, POINT_SIZE_MAX),
    POINT_SIZE_MIN,
    POINT_SIZE_MAX,
  );
  return toSliderPercent(1 + normalized * 99);
}

export function percentToPointSize(percent: number): number {
  const normalized = (toSliderPercent(percent) - 1) / 99;
  return interpolateLog(POINT_SIZE_MIN, POINT_SIZE_MAX, normalized);
}

export function densityScaleToPercent(scale: number): number {
  return toSliderPercent(clamp(scale, DENSITY_SCALE_MIN, DENSITY_SCALE_MAX) * 100);
}

export function percentToDensityScale(percent: number): number {
  return toSliderPercent(percent) / 100;
}

function queryElement<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function createViewerPanel(options: ViewerPanelOptions) {
  const root = ensureViewerPanel();
  const tileLabelEl = queryElement<HTMLParagraphElement>('panel-tile-label');
  const locationEl = queryElement<HTMLParagraphElement>('panel-location-value');
  const mapsLinkEl = queryElement<HTMLAnchorElement>('panel-maps-link');
  const pointSizeInput = queryElement<HTMLInputElement>('panel-point-size');
  const densityInput = queryElement<HTMLInputElement>('panel-point-density');
  const snowToggle = queryElement<HTMLInputElement>('panel-snow-toggle');
  const snowModeButton = queryElement<HTMLButtonElement>('panel-snow-mode-button');
  const snowModeValue = queryElement<HTMLSpanElement>('panel-snow-mode-value');
  const snowModeMenu = queryElement<HTMLDivElement>('panel-snow-mode-menu');
  const snowModeOptions = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-snow-mode-option]'),
  );
  const lowQualityBtn = queryElement<HTMLButtonElement>('panel-engine-btn');
  const lowQualityBtnLabel = queryElement<HTMLSpanElement>('panel-engine-btn-label');
  const settingsBtn = queryElement<HTMLButtonElement>('panel-settings-btn');
  const settingsMenu = queryElement<HTMLDivElement>('panel-settings-menu');

  let pointControlsDisabled = false;
  let snowLoading = false;
  let settingsEnabled = false;
  let snowModeMenuOpen = false;
  let lastSnowMode: Exclude<SnowModeKey, 'off'> = 'cover';

  const syncSnowModeSelection = () => {
    if (snowModeValue) snowModeValue.textContent = SNOW_MODE_LABELS[lastSnowMode];
    snowModeOptions.forEach((option) => {
      const isSelected = option.dataset.snowModeOption === lastSnowMode;
      option.classList.toggle('is-selected', isSelected);
      option.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
  };

  const closeSnowModeMenu = () => {
    snowModeMenuOpen = false;
    snowModeMenu?.setAttribute('hidden', '');
    snowModeButton?.setAttribute('aria-expanded', 'false');
    root?.classList.remove('is-snow-menu-open');
  };

  const openSnowModeMenu = () => {
    if (!snowModeMenu || !snowModeButton || snowModeButton.disabled) return;
    snowModeMenuOpen = true;
    snowModeMenu.removeAttribute('hidden');
    snowModeButton.setAttribute('aria-expanded', 'true');
    root?.classList.add('is-snow-menu-open');
  };

  const syncSnowAvailability = () => {
    const snowEnabled = snowToggle?.checked ?? false;
    if (snowModeButton) snowModeButton.disabled = snowLoading || !snowEnabled;
    if (snowToggle) snowToggle.disabled = snowLoading;
    if ((snowModeButton?.disabled ?? false) && snowModeMenuOpen) closeSnowModeMenu();
    root?.classList.toggle('is-snow-loading', snowLoading);
  };

  const syncPointControls = () => {
    if (pointSizeInput) pointSizeInput.disabled = pointControlsDisabled;
    if (densityInput) densityInput.disabled = pointControlsDisabled;
    root?.classList.toggle('is-point-controls-disabled', pointControlsDisabled);
  };

  const closeSettingsMenu = () => {
    settingsMenu?.setAttribute('hidden', '');
    settingsBtn?.setAttribute('aria-expanded', 'false');
  };

  const syncSettingsButton = () => {
    if (!settingsBtn) return;
    settingsBtn.disabled = !settingsEnabled;
    settingsBtn.classList.toggle('is-disabled', !settingsEnabled);
    if (!settingsEnabled) settingsBtn.setAttribute('aria-expanded', 'false');
  };

  const handleDocumentClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (settingsMenu && !settingsMenu.hasAttribute('hidden')) {
      if (!settingsMenu.contains(target) && !settingsBtn?.contains(target)) closeSettingsMenu();
    }
    if (snowModeMenu && snowModeMenuOpen) {
      if (!snowModeMenu.contains(target) && !snowModeButton?.contains(target)) closeSnowModeMenu();
    }
  };

  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    closeSettingsMenu();
    closeSnowModeMenu();
  };

  const handleSettingsClick = (event: MouseEvent) => {
    if (!settingsMenu || !settingsEnabled) return;
    event.stopPropagation();
    const isHidden = settingsMenu.hasAttribute('hidden');
    if (isHidden) settingsMenu.removeAttribute('hidden');
    else settingsMenu.setAttribute('hidden', '');
    settingsBtn?.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
  };

  const handlePointSizeInput = () => {
    if (!pointSizeInput) return;
    options.onPointSizeChange?.(toSliderPercent(Number(pointSizeInput.value)));
  };

  const handleDensityInput = () => {
    if (!densityInput) return;
    options.onDensityChange?.(toSliderPercent(Number(densityInput.value)));
  };

  const handleSnowToggle = () => {
    if (!snowToggle) return;
    const nextMode = snowToggle.checked
      ? lastSnowMode
      : 'off';
    options.onSnowModeChange?.(nextMode);
  };

  const handleSnowModeButtonClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (snowModeButton?.disabled) return;
    if (snowModeMenuOpen) closeSnowModeMenu();
    else openSnowModeMenu();
  };

  const handleSnowModeOptionClick = (event: MouseEvent) => {
    const option = event.currentTarget;
    if (!(option instanceof HTMLButtonElement)) return;
    const selected = option.dataset.snowModeOption as Exclude<SnowModeKey, 'off'> | undefined;
    if (!selected) return;
    lastSnowMode = selected;
    syncSnowModeSelection();
    closeSnowModeMenu();
    if (snowToggle?.checked) options.onSnowModeChange?.(selected);
  };

  tileLabelEl && (tileLabelEl.textContent = options.tileLabel);
  locationEl && (locationEl.textContent = options.locationLabel);
  if (mapsLinkEl) mapsLinkEl.href = options.googleMapsUrl;
  if (pointSizeInput) pointSizeInput.value = String(toSliderPercent(options.pointSizePercent ?? 50));
  if (densityInput) densityInput.value = String(toSliderPercent(options.densityPercent ?? 100));
  syncSnowModeSelection();

  pointSizeInput?.addEventListener('input', handlePointSizeInput);
  densityInput?.addEventListener('input', handleDensityInput);
  snowToggle?.addEventListener('change', handleSnowToggle);
  snowModeButton?.addEventListener('click', handleSnowModeButtonClick);
  snowModeOptions.forEach((option) => option.addEventListener('click', handleSnowModeOptionClick));
  lowQualityBtn?.addEventListener('click', () => options.onLowQualityClick?.());
  settingsBtn?.addEventListener('click', handleSettingsClick);
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleEscape);

  syncSnowAvailability();
  syncPointControls();
  syncSettingsButton();

  return {
    setTileLabel(label: string) {
      if (tileLabelEl) tileLabelEl.textContent = label;
    },
    setLocation(locationLabel: string, googleMapsUrl: string) {
      if (locationEl) locationEl.textContent = locationLabel;
      if (mapsLinkEl) mapsLinkEl.href = googleMapsUrl;
    },
    setPointSizePercent(percent: number) {
      if (pointSizeInput) pointSizeInput.value = String(toSliderPercent(percent));
    },
    setDensityPercent(percent: number) {
      if (densityInput) densityInput.value = String(toSliderPercent(percent));
    },
    setPointControlsDisabled(disabled: boolean) {
      pointControlsDisabled = disabled;
      syncPointControls();
    },
    setSnowMode(mode: SnowModeKey) {
      if (mode !== 'off') lastSnowMode = mode;
      if (snowToggle) snowToggle.checked = mode !== 'off';
      syncSnowModeSelection();
      syncSnowAvailability();
    },
    setSnowLoading(loading: boolean) {
      snowLoading = loading;
      syncSnowAvailability();
    },
    setLowQualityButtonState(state: LowQualityButtonState) {
      if (!lowQualityBtn) return;
      if (lowQualityBtnLabel) lowQualityBtnLabel.textContent = state.label;
      else lowQualityBtn.textContent = state.label;
      lowQualityBtn.disabled = state.disabled ?? false;
      if (state.title) lowQualityBtn.title = state.title;
      else lowQualityBtn.removeAttribute('title');
    },
    setSettingsEnabled(enabled: boolean) {
      settingsEnabled = enabled;
      if (!enabled) closeSettingsMenu();
      syncSettingsButton();
    },
    destroy() {
      pointSizeInput?.removeEventListener('input', handlePointSizeInput);
      densityInput?.removeEventListener('input', handleDensityInput);
      snowToggle?.removeEventListener('change', handleSnowToggle);
      snowModeButton?.removeEventListener('click', handleSnowModeButtonClick);
      snowModeOptions.forEach((option) => option.removeEventListener('click', handleSnowModeOptionClick));
      settingsBtn?.removeEventListener('click', handleSettingsClick);
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleEscape);
    },
  };
}