import { ensureViewerPanel } from './template';

export type SnowModeKey = 'off' | 'cover' | 'thickness';

export const POINT_SIZE_MIN = 0.2;
export const POINT_SIZE_MAX = 1.0;
export const DENSITY_SCALE_MIN = 0.15;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toSliderPercent(value: number): number {
  return clamp(Math.round(value), 1, 100);
}

export function pointSizeToPercent(pointSize: number): number {
  const normalized = (clamp(pointSize, POINT_SIZE_MIN, POINT_SIZE_MAX) - POINT_SIZE_MIN)
    / (POINT_SIZE_MAX - POINT_SIZE_MIN);
  return toSliderPercent(1 + normalized * 99);
}

export function percentToPointSize(percent: number): number {
  const normalized = (toSliderPercent(percent) - 1) / 99;
  return POINT_SIZE_MIN + normalized * (POINT_SIZE_MAX - POINT_SIZE_MIN);
}

export function densityScaleToPercent(scale: number): number {
  const normalized = (clamp(scale, DENSITY_SCALE_MIN, DENSITY_SCALE_MAX) - DENSITY_SCALE_MIN)
    / (DENSITY_SCALE_MAX - DENSITY_SCALE_MIN);
  return toSliderPercent(1 + normalized * 99);
}

export function percentToDensityScale(percent: number): number {
  const normalized = (toSliderPercent(percent) - 1) / 99;
  return DENSITY_SCALE_MIN + normalized * (DENSITY_SCALE_MAX - DENSITY_SCALE_MIN);
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
  const snowModeSelect = queryElement<HTMLSelectElement>('panel-snow-mode');
  const lowQualityBtn = queryElement<HTMLButtonElement>('panel-engine-btn');
  const lowQualityBtnLabel = queryElement<HTMLSpanElement>('panel-engine-btn-label');
  const settingsBtn = queryElement<HTMLButtonElement>('panel-settings-btn');
  const settingsMenu = queryElement<HTMLDivElement>('panel-settings-menu');

  let pointControlsDisabled = false;
  let snowLoading = false;
  let settingsEnabled = false;
  let lastSnowMode: Exclude<SnowModeKey, 'off'> = 'cover';

  const syncSnowAvailability = () => {
    const snowEnabled = snowToggle?.checked ?? false;
    if (snowModeSelect) snowModeSelect.disabled = snowLoading || !snowEnabled;
    if (snowToggle) snowToggle.disabled = snowLoading;
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
    if (!settingsMenu || settingsMenu.hasAttribute('hidden')) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (settingsMenu.contains(target) || settingsBtn?.contains(target)) return;
    closeSettingsMenu();
  };

  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeSettingsMenu();
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
      ? (snowModeSelect?.value as Exclude<SnowModeKey, 'off'> | undefined) ?? lastSnowMode
      : 'off';
    options.onSnowModeChange?.(nextMode);
  };

  const handleSnowModeSelect = () => {
    const selected = (snowModeSelect?.value as Exclude<SnowModeKey, 'off'> | undefined) ?? 'cover';
    lastSnowMode = selected;
    if (snowToggle?.checked) options.onSnowModeChange?.(selected);
  };

  tileLabelEl && (tileLabelEl.textContent = options.tileLabel);
  locationEl && (locationEl.textContent = options.locationLabel);
  if (mapsLinkEl) mapsLinkEl.href = options.googleMapsUrl;
  if (pointSizeInput) pointSizeInput.value = String(toSliderPercent(options.pointSizePercent ?? 50));
  if (densityInput) densityInput.value = String(toSliderPercent(options.densityPercent ?? 100));

  pointSizeInput?.addEventListener('input', handlePointSizeInput);
  densityInput?.addEventListener('input', handleDensityInput);
  snowToggle?.addEventListener('change', handleSnowToggle);
  snowModeSelect?.addEventListener('change', handleSnowModeSelect);
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
      if (snowModeSelect && mode !== 'off') snowModeSelect.value = mode;
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
      snowModeSelect?.removeEventListener('change', handleSnowModeSelect);
      settingsBtn?.removeEventListener('click', handleSettingsClick);
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleEscape);
    },
  };
}