import { ensureViewerPanel } from './template';

export type SnowModeKey = 'off' | 'cover' | 'thickness';
export type ViewerEngineKey = 'webgpu' | 'webgl';

export const POINT_SIZE_MIN = 0.02;
export const POINT_SIZE_MAX = 1.0;
export const DENSITY_SCALE_MIN = 0.01;
export const DENSITY_SCALE_MAX = 1.0;

export interface ViewerEngineOption {
  key: ViewerEngineKey;
  label?: string;
  disabled?: boolean;
  title?: string;
}

interface ViewerPanelOptions {
  tileLabel: string;
  locationLabel: string;
  googleMapsUrl: string;
  pointSizePercent?: number;
  densityPercent?: number;
  engineMode?: ViewerEngineKey;
  engineOptions?: ViewerEngineOption[];
  onPointSizeChange?: (percent: number) => void;
  onDensityChange?: (percent: number) => void;
  onEngineModeChange?: (mode: ViewerEngineKey) => void;
  onSnowModeChange?: (mode: SnowModeKey) => void;
  onPrimaryActionClick?: () => void;
}

interface PrimaryActionState {
  label: string;
  disabled?: boolean;
  title?: string;
}

const ENGINE_MODE_LABELS: Record<ViewerEngineKey, string> = {
  webgpu: 'WebGpu (+ précis)',
  webgl: 'WebGl HD',
};

const SNOW_MODE_LABELS: Record<Exclude<SnowModeKey, 'off'>, string> = {
  cover: 'Couverture neigeuse',
  thickness: 'Epaisseur (cm)',
};

function normalizeEngineOptions(options?: ViewerEngineOption[]): ViewerEngineOption[] {
  if (!options || options.length === 0) {
    return [
      { key: 'webgpu', label: ENGINE_MODE_LABELS.webgpu },
      { key: 'webgl', label: ENGINE_MODE_LABELS.webgl },
    ];
  }

  return options.map((option) => ({
    ...option,
    label: option.label ?? ENGINE_MODE_LABELS[option.key],
  }));
}

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

function syncRangeFill(input: HTMLInputElement | null): void {
  if (!input) return;
  const min = Number(input.min || '0');
  const max = Number(input.max || '100');
  const value = Number(input.value || min);
  const ratio = max <= min ? 0 : (value - min) / (max - min);
  input.style.setProperty('--viewer-panel-range-fill', `${clamp(ratio, 0, 1) * 100}%`);
}

export function createViewerPanel(options: ViewerPanelOptions) {
  const root = ensureViewerPanel();
  const tileLabelEl = queryElement<HTMLParagraphElement>('panel-tile-label');
  const locationEl = queryElement<HTMLParagraphElement>('panel-location-value');
  const mapsLinkEl = queryElement<HTMLAnchorElement>('panel-maps-link');
  const pointSizeInput = queryElement<HTMLInputElement>('panel-point-size');
  const densityInput = queryElement<HTMLInputElement>('panel-point-density');
  const engineModeButton = queryElement<HTMLButtonElement>('panel-engine-mode-button');
  const engineModeValue = queryElement<HTMLSpanElement>('panel-engine-mode-value');
  const engineModeMenu = queryElement<HTMLDivElement>('panel-engine-mode-menu');
  const engineModeOptions = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-engine-mode-option]'),
  );
  const snowToggle = queryElement<HTMLInputElement>('panel-snow-toggle');
  const snowModeButton = queryElement<HTMLButtonElement>('panel-snow-mode-button');
  const snowModeValue = queryElement<HTMLSpanElement>('panel-snow-mode-value');
  const snowModeMenu = queryElement<HTMLDivElement>('panel-snow-mode-menu');
  const snowModeOptions = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-snow-mode-option]'),
  );
  const primaryActionBtn = queryElement<HTMLButtonElement>('panel-engine-btn');
  const primaryActionBtnLabel = queryElement<HTMLSpanElement>('panel-engine-btn-label');

  let pointControlsDisabled = false;
  let snowLoading = false;
  let engineModeMenuOpen = false;
  let snowModeMenuOpen = false;
  let lastSnowMode: Exclude<SnowModeKey, 'off'> = 'cover';
  let currentEngineMode: ViewerEngineKey = options.engineMode ?? 'webgpu';
  let availableEngineOptions = normalizeEngineOptions(options.engineOptions);

  const getEngineOption = (key: ViewerEngineKey) => availableEngineOptions.find((option) => option.key === key);

  const closeEngineModeMenu = () => {
    engineModeMenuOpen = false;
    engineModeMenu?.setAttribute('hidden', '');
    engineModeButton?.setAttribute('aria-expanded', 'false');
    root?.classList.remove('is-engine-menu-open');
  };

  const openEngineModeMenu = () => {
    if (!engineModeMenu || !engineModeButton || engineModeButton.disabled) return;
    engineModeMenuOpen = true;
    engineModeMenu.removeAttribute('hidden');
    engineModeButton.setAttribute('aria-expanded', 'true');
    root?.classList.add('is-engine-menu-open');
  };

  const syncEngineSelection = () => {
    const currentOption = getEngineOption(currentEngineMode);
    if (engineModeValue) {
      engineModeValue.textContent = currentOption?.label ?? ENGINE_MODE_LABELS[currentEngineMode];
    }

    const hasAlternativeEnabled = availableEngineOptions.some(
      (option) => option.key !== currentEngineMode && !option.disabled,
    );
    if (engineModeButton) {
      engineModeButton.disabled = !hasAlternativeEnabled;
      if (currentOption?.title) engineModeButton.title = currentOption.title;
      else engineModeButton.removeAttribute('title');
    }

    engineModeOptions.forEach((option) => {
      const optionKey = option.dataset.engineModeOption as ViewerEngineKey | undefined;
      if (!optionKey) return;
      const config = getEngineOption(optionKey);
      const isSelected = optionKey === currentEngineMode;
      option.classList.toggle('is-selected', isSelected);
      option.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      option.setAttribute('aria-disabled', config?.disabled ? 'true' : 'false');
      if (config?.title) option.title = config.title;
      else option.removeAttribute('title');
    });

    if ((engineModeButton?.disabled ?? false) && engineModeMenuOpen) closeEngineModeMenu();
  };

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

  const handleDocumentClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (engineModeMenu && engineModeMenuOpen) {
      if (!engineModeMenu.contains(target) && !engineModeButton?.contains(target)) closeEngineModeMenu();
    }
    if (snowModeMenu && snowModeMenuOpen) {
      if (!snowModeMenu.contains(target) && !snowModeButton?.contains(target)) closeSnowModeMenu();
    }
  };

  const handleEscape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    closeEngineModeMenu();
    closeSnowModeMenu();
  };

  const handlePointSizeInput = () => {
    if (!pointSizeInput) return;
    syncRangeFill(pointSizeInput);
    options.onPointSizeChange?.(toSliderPercent(Number(pointSizeInput.value)));
  };

  const handleDensityInput = () => {
    if (!densityInput) return;
    syncRangeFill(densityInput);
    options.onDensityChange?.(toSliderPercent(Number(densityInput.value)));
  };

  const handleEngineModeButtonClick = (event: MouseEvent) => {
    event.stopPropagation();
    if (engineModeButton?.disabled) return;
    if (engineModeMenuOpen) closeEngineModeMenu();
    else openEngineModeMenu();
  };

  const handleEngineModeOptionClick = (event: MouseEvent) => {
    const option = event.currentTarget;
    if (!(option instanceof HTMLButtonElement)) return;
    const selected = option.dataset.engineModeOption as ViewerEngineKey | undefined;
    if (!selected) return;
    const config = getEngineOption(selected);
    if (config?.disabled) return;
    closeEngineModeMenu();
    if (selected === currentEngineMode) return;
    currentEngineMode = selected;
    syncEngineSelection();
    options.onEngineModeChange?.(selected);
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
  syncRangeFill(pointSizeInput);
  syncRangeFill(densityInput);
  syncEngineSelection();
  syncSnowModeSelection();

  pointSizeInput?.addEventListener('input', handlePointSizeInput);
  densityInput?.addEventListener('input', handleDensityInput);
  engineModeButton?.addEventListener('click', handleEngineModeButtonClick);
  engineModeOptions.forEach((option) => option.addEventListener('click', handleEngineModeOptionClick));
  snowToggle?.addEventListener('change', handleSnowToggle);
  snowModeButton?.addEventListener('click', handleSnowModeButtonClick);
  snowModeOptions.forEach((option) => option.addEventListener('click', handleSnowModeOptionClick));
  primaryActionBtn?.addEventListener('click', () => options.onPrimaryActionClick?.());
  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleEscape);

  syncSnowAvailability();
  syncPointControls();

  return {
    setTileLabel(label: string) {
      if (tileLabelEl) tileLabelEl.textContent = label;
    },
    setLocation(locationLabel: string, googleMapsUrl: string) {
      if (locationEl) locationEl.textContent = locationLabel;
      if (mapsLinkEl) mapsLinkEl.href = googleMapsUrl;
    },
    setPointSizePercent(percent: number) {
      if (pointSizeInput) {
        pointSizeInput.value = String(toSliderPercent(percent));
        syncRangeFill(pointSizeInput);
      }
    },
    setDensityPercent(percent: number) {
      if (densityInput) {
        densityInput.value = String(toSliderPercent(percent));
        syncRangeFill(densityInput);
      }
    },
    setPointControlsDisabled(disabled: boolean) {
      pointControlsDisabled = disabled;
      syncPointControls();
    },
    setEngineMode(mode: ViewerEngineKey) {
      currentEngineMode = mode;
      syncEngineSelection();
    },
    setEngineOptions(nextOptions: ViewerEngineOption[]) {
      availableEngineOptions = normalizeEngineOptions(nextOptions);
      syncEngineSelection();
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
    setPrimaryActionState(state: PrimaryActionState) {
      if (!primaryActionBtn) return;
      if (primaryActionBtnLabel) primaryActionBtnLabel.textContent = state.label;
      else primaryActionBtn.textContent = state.label;
      primaryActionBtn.disabled = state.disabled ?? false;
      if (state.title) primaryActionBtn.title = state.title;
      else primaryActionBtn.removeAttribute('title');
    },
    destroy() {
      pointSizeInput?.removeEventListener('input', handlePointSizeInput);
      densityInput?.removeEventListener('input', handleDensityInput);
      engineModeButton?.removeEventListener('click', handleEngineModeButtonClick);
      engineModeOptions.forEach((option) => option.removeEventListener('click', handleEngineModeOptionClick));
      snowToggle?.removeEventListener('change', handleSnowToggle);
      snowModeButton?.removeEventListener('click', handleSnowModeButtonClick);
      snowModeOptions.forEach((option) => option.removeEventListener('click', handleSnowModeOptionClick));
      document.removeEventListener('click', handleDocumentClick);
      document.removeEventListener('keydown', handleEscape);
    },
  };
}