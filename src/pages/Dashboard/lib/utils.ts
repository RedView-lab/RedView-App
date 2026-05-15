import {
  CENTER_PANEL_HEIGHT_KEY,
  LEFT_PANEL_WIDTH_DEFAULT,
  LEFT_PANEL_WIDTH_KEY,
  LEFT_PANEL_WIDTH_MAX,
  LEFT_PANEL_WIDTH_MIN,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_KEY,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN_FALLBACK,
} from './constants';

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function readStoredCenterPanelHeight(): number | null {
  try {
    const raw = localStorage.getItem(CENTER_PANEL_HEIGHT_KEY);
    if (!raw) return null;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function readStoredLeftWidth(): number {
  try {
    const raw = localStorage.getItem(LEFT_PANEL_WIDTH_KEY);
    if (!raw) return LEFT_PANEL_WIDTH_DEFAULT;
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value)) return LEFT_PANEL_WIDTH_DEFAULT;
    return Math.min(LEFT_PANEL_WIDTH_MAX, Math.max(LEFT_PANEL_WIDTH_MIN, value));
  } catch {
    return LEFT_PANEL_WIDTH_DEFAULT;
  }
}

export function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_WIDTH_DEFAULT;
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value)) return PANEL_WIDTH_DEFAULT;
    return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN_FALLBACK, value));
  } catch {
    return PANEL_WIDTH_DEFAULT;
  }
}

export function clampLeftPanelWidth(value: number) {
  return Math.min(LEFT_PANEL_WIDTH_MAX, Math.max(LEFT_PANEL_WIDTH_MIN, value));
}

export function clampPanelWidth(value: number, minWidth: number) {
  return Math.min(PANEL_WIDTH_MAX, Math.max(minWidth, value));
}

export function measurePanelMinWidth(node: HTMLDivElement | null): number | null {
  if (!node || typeof document === 'undefined') return null;

  const panel = node.firstElementChild;
  if (!(panel instanceof HTMLElement)) return null;

  const clone = panel.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return null;

  clone.removeAttribute('style');
  clone.style.position = 'fixed';
  clone.style.left = '-10000px';
  clone.style.top = '0';
  clone.style.width = 'max-content';
  clone.style.maxWidth = 'none';
  clone.style.minWidth = '0';
  clone.style.height = 'auto';
  clone.style.visibility = 'hidden';
  clone.style.pointerEvents = 'none';
  clone.style.overflow = 'visible';

  document.body.appendChild(clone);
  const width = Math.ceil(clone.getBoundingClientRect().width);
  clone.remove();

  return Number.isFinite(width) && width > 0 ? width : null;
}

export function formatDisplayName(email: string): string {
  const localPart = email.split('@')[0] ?? 'Utilisateur';
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
