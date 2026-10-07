import { afterEach, describe, expect, it, vi } from 'vitest';

import { createByteLru } from '../byte-lru.mjs';

const bufferCache = (maxBytes: number, options: { ttlMs?: number; maxEntryBytes?: number } = {}) =>
  createByteLru<Buffer>({ maxBytes, sizeOf: (value) => value.length, ...options });

describe('createByteLru', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts value and key bytes', () => {
    const cache = bufferCache(1000);
    cache.set('ab', Buffer.alloc(100));
    expect(cache.get('ab')?.length).toBe(100);
    expect(cache.bytes).toBe(102);
    expect(cache.size).toBe(1);
  });

  it('evicts the least recently used entries to stay within budget', () => {
    const cache = bufferCache(300, { maxEntryBytes: 300 });
    cache.set('a', Buffer.alloc(99));
    cache.set('b', Buffer.alloc(99));
    cache.set('c', Buffer.alloc(99));
    // Lire `a` le remonte : `b` devient le plus ancien.
    expect(cache.get('a')).toBeDefined();
    cache.set('d', Buffer.alloc(99));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.bytes).toBeLessThanOrEqual(300);
  });

  it('never keeps an entry above the per-entry cap', () => {
    const cache = bufferCache(1000);
    cache.set('small', Buffer.alloc(10));
    expect(cache.set('huge', Buffer.alloc(400))).toBe(false);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('small')).toBeDefined();
  });

  it('replacing a key releases the old value', () => {
    const cache = bufferCache(1000);
    cache.set('k', Buffer.alloc(200));
    cache.set('k', Buffer.alloc(50));
    expect(cache.bytes).toBe(51);
    expect(cache.size).toBe(1);
  });

  it('drops a replaced key whose new value is refused', () => {
    const cache = bufferCache(1000);
    cache.set('k', Buffer.alloc(100));
    expect(cache.set('k', Buffer.alloc(900))).toBe(false);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it('expires entries after their TTL', () => {
    vi.useFakeTimers();
    const cache = bufferCache(1000, { ttlMs: 1000 });
    cache.set('k', Buffer.alloc(10));
    vi.advanceTimersByTime(999);
    expect(cache.get('k')).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.bytes).toBe(0);
  });

  it('delete and clear release the bytes', () => {
    const cache = bufferCache(1000);
    cache.set('a', Buffer.alloc(10));
    cache.set('b', Buffer.alloc(10));
    cache.delete('a');
    expect(cache.bytes).toBe(11);
    cache.clear();
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });
});
