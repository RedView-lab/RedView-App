import { describe, expect, it } from 'vitest';

import { createJwtCache, JWT_REUSE_MS } from './jwtCache';

function setup() {
  let clock = 1_000;
  let user: string | null = 'alice';
  let created = 0;
  let fail = false;
  const cache = createJwtCache(
    async () => {
      created += 1;
      if (fail) throw new Error('429');
      return `jwt-${created}`;
    },
    () => user,
    () => clock,
  );
  return {
    cache,
    created: () => created,
    advance: (ms: number) => {
      clock += ms;
    },
    setUser: (next: string | null) => {
      user = next;
    },
    setFail: (next: boolean) => {
      fail = next;
    },
  };
}

describe('cache du JWT Appwrite', () => {
  it('reconnexions répétées : un seul JWT créé tant qu’il est frais', async () => {
    const { cache, created, advance } = setup();
    for (let index = 0; index < 50; index += 1) {
      expect(await cache.get()).toBe('jwt-1');
      advance(10_000);
    }
    expect(created()).toBe(1);
    advance(JWT_REUSE_MS);
    expect(await cache.get()).toBe('jwt-2');
  });

  it('demandes simultanées fusionnées', async () => {
    const { cache, created } = setup();
    const tokens = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(tokens).toEqual(['jwt-1', 'jwt-1', 'jwt-1']);
    expect(created()).toBe(1);
  });

  it('jeton refusé (fresh) ou autre compte : nouveau jeton ; déconnexion : vidé', async () => {
    const { cache, created, setUser } = setup();
    await cache.get();
    expect(await cache.get({ fresh: true })).toBe('jwt-2');
    expect(await cache.get()).toBe('jwt-2');
    setUser('bob');
    expect(await cache.get()).toBe('jwt-3');
    cache.clear();
    expect(await cache.get()).toBe('jwt-4');
    expect(created()).toBe(4);
  });

  it('un échec n’est pas gardé', async () => {
    const { cache, setFail } = setup();
    setFail(true);
    await expect(cache.get()).rejects.toThrow('429');
    setFail(false);
    expect(await cache.get()).toBe('jwt-2');
  });

  it('session changée pendant la création : le jeton n’est pas gardé pour la nouvelle', async () => {
    const { cache, setUser } = setup();
    const pending = cache.get();
    setUser('bob');
    expect(await pending).toBe('jwt-1');
    expect(await cache.get()).toBe('jwt-2');
  });
});
