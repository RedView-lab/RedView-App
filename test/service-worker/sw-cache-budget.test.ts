import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

// Les caches de tuiles du SW n'avaient aucun plafond (seuls ceux d'une ancienne
// époque étaient purgés) et une invalidation de tuile dérivée parcourait toutes
// les clés des caches de pente et d'altitude (B5-2, audit du 2026-10-10).
//
// Le vrai code du SW (runtime/cache-budget.js, runtime/lifecycle.js) est chargé
// dans un contexte vm comme le fait importScripts(), avec un CacheStorage en
// mémoire qui suit la spécification : `keys()` dans l'ordre d'insertion, une
// réécriture remet l'entrée à la fin, `ignoreSearch` ignore la requête.

const SW_DIR = path.resolve(import.meta.dirname, '../../public/sw-dem');
const ORIGIN = 'https://app.test';

const NAMES = {
  CACHE_NAME: 'dem-tiles-e',
  NEGATIVE_CACHE_NAME: 'dem-negative-e',
  ORTHO_CACHE_NAME: 'ortho-tiles-e',
  VHR_CACHE_NAME: 'vhr-tiles-v1-e',
  SLOPE_CACHE_NAME: 'slope-tiles-v3-e',
  ALTITUDE_CACHE_NAME: 'altitude-tiles-e',
  CONTOUR_CACHE_NAME: 'contour-tiles-v2-e',
  STATIC_CACHE_NAME: 'dem-static-e',
};

function makeCaches({ forbidKeys = false } = {}) {
  const stores = new Map<string, Map<string, Response>>();
  const urlOf = (req: Request | string) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
  const strip = (url: string) => url.replace(/\?.*$/, '');
  const storeOf = (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    return store;
  };
  const open = async (name: string) => {
    const store = storeOf(name);
    return {
      match: async (req: Request | string) => store.get(urlOf(req))?.clone(),
      put: async (req: Request | string, res: Response) => {
        const url = urlOf(req);
        store.delete(url);
        store.set(url, res);
      },
      delete: async (req: Request | string, options?: { ignoreSearch?: boolean }) => {
        const url = urlOf(req);
        if (!options?.ignoreSearch) return store.delete(url);
        let deleted = false;
        for (const key of [...store.keys()]) {
          if (strip(key) === strip(url)) deleted = store.delete(key) || deleted;
        }
        return deleted;
      },
      keys: async () => {
        if (forbidKeys) throw new Error(`keys() parcouru sur ${name}`);
        return [...store.keys()].map((url) => new Request(url));
      },
    };
  };
  return { caches: { open, keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) }, urls: (name: string) => [...storeOf(name).keys()], open };
}

function loadSw(files: string[], options: { forbidKeys?: boolean } = {}) {
  const { caches, urls, open } = makeCaches(options);
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let now = 0;
  let nextId = 1;
  const listeners = new Map<string, (event: unknown) => void>();
  // Dans le SW, une URL relative se résout sur l'origine du worker.
  const SwRequest = class extends Request {
    constructor(input: string | Request, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
    }
  };
  const context = vm.createContext({
    ...NAMES,
    Request: SwRequest, Response, URL, Math, Map, Set, Promise, Array, Object, Number, String, Boolean, Error,
    console: { log() {}, warn() {}, error() {}, debug() {} },
    DEBUG: false,
    caches,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    self: { addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) },
    slopeHotDeleteTile: () => {},
  });
  for (const file of files) {
    const full = path.join(SW_DIR, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  }
  const advance = async (ms: number) => {
    now += ms;
    for (let due = timers.filter((t) => t.at <= now); due.length > 0; due = timers.filter((t) => t.at <= now)) {
      for (const timer of due) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { context, urls, open, advance, listeners };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('plafond des caches de tuiles du SW (B5-2)', () => {
  it('au repos, retire les tuiles écrites le plus tôt au-delà du plafond de leur famille', async () => {
    const sw = loadSw(['runtime/cache-budget.js']);
    const budgets = new Map(vm.runInContext('MAP_CACHE_BUDGETS', sw.context) as Array<[string, number]>);
    const demMax = budgets.get(NAMES.CACHE_NAME)!;
    const dem = await sw.open(NAMES.CACHE_NAME);
    const total = demMax + 100;
    for (let i = 0; i < total; i += 1) await dem.put(`/dem-tiles/14/${i}/0`, new Response('t'));
    // Relue et réécrite (mise à niveau) : elle redevient la plus récente.
    await dem.put('/dem-tiles/14/0/0', new Response('t2'));
    const ortho = await sw.open(NAMES.ORTHO_CACHE_NAME);
    await ortho.put('/ortho-tiles/14/1/1', new Response('o'));

    const noteMapTileRequest = vm.runInContext('noteMapTileRequest', sw.context) as () => void;
    noteMapTileRequest();
    await sw.advance(4000);
    noteMapTileRequest(); // une requête repousse la passe : jamais pendant le chargement de la carte
    await sw.advance(4000);
    expect(sw.urls(NAMES.CACHE_NAME)).toHaveLength(total);
    await sw.advance(10_000);

    const kept = sw.urls(NAMES.CACHE_NAME);
    const dropped = 100 + Math.floor(demMax * 0.1);
    expect(kept).toHaveLength(total - dropped);
    expect(kept).toContain(`${ORIGIN}/dem-tiles/14/0/0`);
    expect(kept).not.toContain(`${ORIGIN}/dem-tiles/14/1/0`);
    expect(kept).toContain(`${ORIGIN}/dem-tiles/14/${total - 1}/0`);
    expect(sw.urls(NAMES.ORTHO_CACHE_NAME)).toHaveLength(1);
  });

  it('chaque famille gérée a un plafond, sauf l’ortho THR qui se plafonne elle-même', () => {
    const sw = loadSw(['runtime/cache-budget.js']);
    const names = (vm.runInContext('MAP_CACHE_BUDGETS', sw.context) as Array<[string, number]>).map(([name]) => name);
    expect(names.sort()).toEqual([
      NAMES.ALTITUDE_CACHE_NAME, NAMES.CACHE_NAME, NAMES.CONTOUR_CACHE_NAME, NAMES.NEGATIVE_CACHE_NAME,
      NAMES.ORTHO_CACHE_NAME, NAMES.SLOPE_CACHE_NAME,
    ].sort());
    const vhr = fs.readFileSync(path.join(SW_DIR, 'sources/vhr-ortho.js'), 'utf8');
    expect(vhr).toMatch(/async function maybeTrimVhrCache/);
  });

  it('le SW charge le plafond avant le routeur, qui le prévient de chaque requête de tuile', () => {
    const entry = fs.readFileSync(path.resolve(SW_DIR, '../sw-dem.js'), 'utf8');
    const budgetAt = entry.indexOf("'/sw-dem/runtime/cache-budget.js'");
    expect(budgetAt).toBeGreaterThan(entry.indexOf("'/sw-dem/sources/vhr-ortho.js'"));
    expect(budgetAt).toBeLessThan(entry.indexOf("'/sw-dem/runtime/router.js'"));
    expect(fs.readFileSync(path.join(SW_DIR, 'runtime/router.js'), 'utf8')).toMatch(/noteMapTileRequest\(\)/);
  });

  it('une tuile DEM améliorée invalide ses tuiles de pente et d’altitude sans parcourir les caches', async () => {
    const sw = loadSw(['runtime/lifecycle.js'], { forbidKeys: true });
    const slope = await sw.open(NAMES.SLOPE_CACHE_NAME);
    const altitude = await sw.open(NAMES.ALTITUDE_CACHE_NAME);
    for (const url of [
      '/slope-tiles/12/10/10',
      '/slope-tiles/12/10/10?res=2&rv-dem-profile=terrain',
      '/slope-tiles/12/11/10?zone=abc123',
      '/slope-tiles/12/10/9?source-dem=fast-30m',
      '/slope-tiles/12/12/12',
      '/slope-tiles/13/10/10',
    ]) await slope.put(url, new Response('s'));
    for (const url of ['/altitude-tiles/12/10/10?zone=abc123', '/altitude-tiles/12/11/10?zone=abc123']) {
      await altitude.put(url, new Response('a'));
    }

    sw.listeners.get('message')!({ data: { type: 'INVALIDATE_DERIVED_TILE', z: 12, x: 10, y: 10 } });
    await settle();

    expect(sw.urls(NAMES.SLOPE_CACHE_NAME)).toEqual([`${ORIGIN}/slope-tiles/12/12/12`, `${ORIGIN}/slope-tiles/13/10/10`]);
    expect(sw.urls(NAMES.ALTITUDE_CACHE_NAME)).toEqual([`${ORIGIN}/altitude-tiles/12/11/10?zone=abc123`]);
  });
});
