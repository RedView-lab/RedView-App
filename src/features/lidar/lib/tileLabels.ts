/**
 * Libellés personnalisés persistants des tuiles LiDAR en cache.
 *
 * Stockés dans `localStorage` (par profil de navigateur) pour qu'une tuile
 * renommée garde son libellé après un rechargement de page, un redémarrage du
 * navigateur ou de l'OS. Les tuiles en cache OPFS vivent dans le même profil de
 * navigateur, donc la portée coïncide naturellement — une tuile ne peut exister
 * sans son profil, son nom ne peut donc pas survivre au stockage qui la contient.
 */

const STORAGE_KEY = 'redview.lidarTileLabels.v1';

type LabelMap = Record<string, string>;

function safeGetStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadLidarTileLabels(): LabelMap {
  const storage = safeGetStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: LabelMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' && v.trim().length > 0) out[k] = v;
      }
      return out;
    }
  } catch {
    /* JSON corrompu, on continue */
  }
  return {};
}

function saveLidarTileLabels(labels: LabelMap): void {
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(labels));
  } catch {
    /* quota ou navigation privée, ignorer */
  }
}

export function setLidarTileLabel(id: string, label: string | null): LabelMap {
  const next = loadLidarTileLabels();
  const trimmed = label?.trim() ?? '';
  if (trimmed.length === 0) {
    delete next[id];
  } else {
    next[id] = trimmed;
  }
  saveLidarTileLabels(next);
  return next;
}
