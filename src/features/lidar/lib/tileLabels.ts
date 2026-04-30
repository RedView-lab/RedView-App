/**
 * Persistent custom labels for cached LiDAR tiles.
 *
 * Stored in `localStorage` (per browser profile) so a renamed tile keeps its
 * label across page reloads, browser restarts and OS reboots. The OPFS-cached
 * tiles themselves live in the same browser profile, so this scope matches
 * naturally — a tile cannot exist without its profile, so its name cannot
 * outlive the storage that holds it.
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
    /* corrupt JSON, fall through */
  }
  return {};
}

export function saveLidarTileLabels(labels: LabelMap): void {
  const storage = safeGetStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(labels));
  } catch {
    /* quota or privacy mode, ignore */
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
