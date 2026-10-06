import { describe, expect, it } from 'vitest';

import { createOldestKeyTaker } from '../oldest-key.mjs';

/** xorshift32 : charge reproductible. */
function random(seed: number) {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/**
 * Cache LRU borné (lecture = remontée en queue, écriture = insertion puis
 * éviction en tête) avec la référence `keys().next()` ou le lecteur persistant.
 */
function simulate(useTaker: boolean, { ops, cap, keySpace, seed }: { ops: number; cap: number; keySpace: number; seed: number }) {
  const next = random(seed);
  const map = new Map<string, number>();
  const takeOldestKey = createOldestKeyTaker(map);
  const evicted: string[] = [];
  for (let i = 0; i < ops; i++) {
    const key = `k${Math.floor(keySpace * next() ** 2)}`;
    const roll = next();
    if (roll < 0.5) {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
    } else if (roll < 0.55) {
      map.delete(key);
    } else if (roll < 0.5502) {
      map.clear();
    } else {
      map.delete(key);
      map.set(key, i);
      while (map.size > cap) {
        const victim = useTaker ? takeOldestKey() : map.keys().next().value;
        if (victim === undefined) throw new Error('Map non vide sans plus ancienne clé');
        map.delete(victim);
        evicted.push(victim);
      }
    }
  }
  return { evicted, order: [...map.keys()] };
}

describe('createOldestKeyTaker', () => {
  it('evicts exactly the keys keys().next() would, in the same order', () => {
    for (const [cap, keySpace, seed] of [[16, 64, 1], [200, 1_000, 2], [2_000, 20_000, 3]]) {
      const reference = simulate(false, { ops: 60_000, cap, keySpace, seed });
      const taker = simulate(true, { ops: 60_000, cap, keySpace, seed });
      expect(reference.evicted.length).toBeGreaterThan(1_000);
      expect(taker.evicted).toEqual(reference.evicted);
      expect(taker.order).toEqual(reference.order);
    }
  });

  it('returns undefined on an empty map, then resumes after new insertions', () => {
    const map = new Map<string, number>();
    const takeOldestKey = createOldestKeyTaker(map);
    expect(takeOldestKey()).toBeUndefined();
    map.set('a', 1).set('b', 2);
    expect(takeOldestKey()).toBe('a');
    map.delete('a');
    expect(takeOldestKey()).toBe('b');
    map.delete('b');
    expect(takeOldestKey()).toBeUndefined();
    map.set('c', 3);
    expect(takeOldestKey()).toBe('c');
  });
});
