import type { LabelCategory } from '../types';
import { LABEL_CATEGORIES } from './label-config';

const STORAGE_KEY = 'redview_label_prefs';

// ── Build default state from category definitions ─────────────────────

function defaults(): Record<LabelCategory, boolean> {
  const state = {} as Record<LabelCategory, boolean>;
  for (const cat of LABEL_CATEGORIES) {
    state[cat.id] = cat.defaultEnabled;
  }
  return state;
}

// ── Load persisted label state from localStorage ──────────────────────

export function loadLabelState(): Record<LabelCategory, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();

    const parsed = JSON.parse(raw) as Record<string, boolean>;
    const state = defaults();

    for (const cat of LABEL_CATEGORIES) {
      if (typeof parsed[cat.id] === 'boolean') {
        state[cat.id] = parsed[cat.id];
      }
    }
    return state;
  } catch {
    return defaults();
  }
}

// ── Persist label state to localStorage ───────────────────────────────

export function saveLabelState(state: Record<LabelCategory, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded — silently ignore
  }
}
