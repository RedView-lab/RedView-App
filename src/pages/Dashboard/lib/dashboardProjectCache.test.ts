import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROJECT_CACHE_KEY_PREFIX } from '@/features/map3d/lib/mapCacheEpoch';
import { compactProjectCacheStorage } from './dashboardProjectCache';

/** localStorage en mémoire, ordre d'insertion (comme les navigateurs pour `key(i)`). */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
  };
}

const entry = (cachedAt: string) => JSON.stringify({ ownerId: 'u1', cachedAt, project: { id: 'p' } });

describe('compactProjectCacheStorage', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes every unreadable entry, even adjacent ones', () => {
    storage.setItem(`${PROJECT_CACHE_KEY_PREFIX}a`, '{not json');
    storage.setItem(`${PROJECT_CACHE_KEY_PREFIX}b`, '{still not json');
    storage.setItem(`${PROJECT_CACHE_KEY_PREFIX}c`, '');
    storage.setItem(`${PROJECT_CACHE_KEY_PREFIX}d`, entry('2026-10-07T10:00:00Z'));
    storage.setItem('redview:other-key', 'kept');

    compactProjectCacheStorage();

    expect(storage.getItem(`${PROJECT_CACHE_KEY_PREFIX}a`)).toBeNull();
    expect(storage.getItem(`${PROJECT_CACHE_KEY_PREFIX}b`)).toBeNull();
    expect(storage.getItem(`${PROJECT_CACHE_KEY_PREFIX}c`)).toBeNull();
    expect(storage.getItem(`${PROJECT_CACHE_KEY_PREFIX}d`)).not.toBeNull();
    expect(storage.getItem('redview:other-key')).toBe('kept');
  });

  it('keeps the most recent entries within the count budget, the pinned one first', () => {
    for (let i = 0; i < 5; i++) storage.setItem(`${PROJECT_CACHE_KEY_PREFIX}p${i}`, entry(`2026-10-0${i + 1}T10:00:00Z`));

    compactProjectCacheStorage('p0');

    const kept = ['p0', 'p1', 'p2', 'p3', 'p4'].filter((id) => storage.getItem(`${PROJECT_CACHE_KEY_PREFIX}${id}`) !== null);
    expect(kept).toEqual(['p0', 'p3', 'p4']);
  });
});
