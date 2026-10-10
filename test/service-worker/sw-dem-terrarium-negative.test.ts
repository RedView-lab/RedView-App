import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

// Hors des pays à LiDAR national (Italie, Autriche, Belgique…), le relief vient
// d'AWS Terrarium seul. Une tuile que Terrarium n'a vraiment pas (404) est une
// absence confirmée, gardée 1 h dans le cache négatif ; un échec passager
// (5xx, 429, délai, réseau) ne doit jamais l'être : la tuile reviendrait pour
// une heure en « trou » de relief (B5-1, audit du 2026-10-10).
//
// Le vrai `computeDemRequest` est chargé dans un contexte vm comme le SW
// l'importScripts(), avec les pipelines nationaux bouchés (tuile hors de
// France / Suisse / Norvège / Espagne) et un CacheStorage en mémoire.

type CacheEntry = { status: number; headers: Headers };

function makeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new Map()));
    const keyOf = (req: Request | string) => (typeof req === 'string' ? req : req.url);
    return {
      match: async (req: Request | string) => store.get(keyOf(req))?.clone(),
      put: async (req: Request | string, res: Response) => { store.set(keyOf(req), res); },
      delete: async (req: Request | string) => store.delete(keyOf(req)),
    };
  };
  const entries = (name: string): CacheEntry[] =>
    [...(stores.get(name)?.values() ?? [])].map((res) => ({ status: res.status, headers: res.headers }));
  return { caches: { open }, entries };
}

function loadPipeline(fetchImpl: (url: string) => Promise<Response>) {
  const { caches, entries } = makeCaches();
  const noTile = (reason: string) => new Response(null, { status: 204, headers: { 'x-no-tile-reason': reason } });
  const context = vm.createContext({
    Blob, Response, Request, Headers, Math, Float32Array, Uint8Array, DataView, Map, Set, Promise, Date,
    AbortSignal, String, Boolean, parseInt, Array, Object, JSON, Error,
    console: { log() {}, warn() {}, error() {}, debug() {} },
    performance: { now: () => Date.now() },
    caches,
    fetch: (url: string) => fetchImpl(url),
    // Aiguillage : tuile de carte ordinaire, hors de toute région LiDAR.
    resolveDemRequestPurposeFromRequest: () => null,
    isMapDemTileRequest: () => false,
    isExpertFallbackRiskTile: () => false,
    buildDemCacheKey: (z: number, x: number, y: number) => new Request(`https://app.test/dem-tiles/${z}/${x}/${y}`),
    demHotGet: () => null,
    demHotPut: () => {},
    tileOverlapsFrance: () => false,
    tileOverlapsOverseasFrance: () => false,
    tileOverlapsSwitzerland: () => false,
    tileOverlapsNorway: () => false,
    tileOverlapsSpain: () => false,
    mercatorTileBounds: () => ({ west: 11, east: 11.35, south: 44, north: 44.25 }),
    shouldUseIGN: () => false,
    shouldUseIGNHighres: () => false,
    shouldUseIGNTerrainWms: () => false,
    shouldUseSwiss: () => false,
    shouldUseNorway: () => false,
    shouldUseSpain: () => false,
    tryParentOverzoom: async () => null,
    noTileResponse: noTile,
    guardDemTileHealth: async (_cache: unknown, blob: Blob, _z: number, _x: number, _y: number, demSource: string) =>
      ({ blob, demSource, shortCache: false, healthStatus: 'ok' }),
    finalize: async () => new Response('tile', { status: 200 }),
    scheduleBackgroundUpgrade: () => {},
    scheduleSurfaceMnsRecovery: () => {},
  });
  for (const file of ['core/config.js', 'sources/mapbox.js', 'sources/aws-terrain.js', 'runtime/dem-handler/compute-request.js']) {
    const full = path.resolve(import.meta.dirname, '../../public/sw-dem', file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  }
  const run = vm.runInContext('(z, x, y) => computeDemRequest(new Request(`https://app.test/dem-tiles/${z}/${x}/${y}`), z, x, y, 0, "default")', context) as
    (z: number, x: number, y: number) => Promise<Response>;
  const negative = () => entries(vm.runInContext('NEGATIVE_CACHE_NAME', context) as string);
  const confirmedTtl = vm.runInContext('NEGATIVE_TTL_CONFIRMED', context) as number;
  return { run, negative, confirmedTtl };
}

// Bologne, z10 : couverte par Terrarium seul.
const TILE = [10, 543, 374] as const;

describe('sw-dem — absence confirmée de Terrarium (B5-1)', () => {
  it('un 404 de Terrarium est une absence confirmée, gardée 1 h', async () => {
    const sw = loadPipeline(async () => new Response('missing', { status: 404 }));
    const res = await sw.run(...TILE);
    expect(res.status).toBe(204);
    const neg = sw.negative();
    expect(neg).toHaveLength(1);
    expect(Number(neg[0].headers.get('x-neg-ttl'))).toBe(sw.confirmedTtl);
  });

  it.each([
    ['HTTP 503', async () => new Response('busy', { status: 503 })],
    ['HTTP 429', async () => new Response('slow down', { status: 429 })],
    ['HTTP 403', async () => new Response('denied', { status: 403 })],
    ['coupure réseau', async () => { throw new TypeError('Failed to fetch'); }],
    ['délai dépassé', async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }],
  ])('un échec passager (%s) n’est jamais mis en cache comme une absence', async (_label, fetchImpl) => {
    const sw = loadPipeline(fetchImpl as (url: string) => Promise<Response>);
    const res = await sw.run(...TILE);
    expect(res.status).toBe(204);
    const confirmed = sw.negative().filter((entry) => Number(entry.headers.get('x-neg-ttl')) >= sw.confirmedTtl);
    expect(confirmed).toEqual([]);
  });

  it('la tuile revient dès que Terrarium répond de nouveau', async () => {
    let fail = true;
    const sw = loadPipeline(async () => (fail ? new Response('busy', { status: 503 }) : new Response('png', { status: 200 })));
    expect((await sw.run(...TILE)).status).toBe(204);
    fail = false;
    // Le décodage PNG n'existe pas dans le contexte vm : seul l'aiguillage compte ici.
    // La seconde requête doit retourner chez Terrarium au lieu de servir le cache négatif.
    const res = await sw.run(...TILE);
    expect(res.headers.get('x-no-tile-reason')).not.toBe('neg-cache');
  });
});
