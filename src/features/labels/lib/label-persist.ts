import type { LabelCategory } from '../types';
import { LABEL_CATEGORIES } from './label-config';

const STORAGE_KEY = 'redview_label_prefs';

// ── Construction de l'état par défaut à partir des définitions de catégories ──

function defaults(): Record<LabelCategory, boolean> {
  const state = {} as Record<LabelCategory, boolean>;
  for (const cat of LABEL_CATEGORIES) {
    state[cat.id] = cat.defaultEnabled;
  }
  return state;
}

// ── Chargement de l'état persisté des étiquettes depuis localStorage ──

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
