/**
 * Audit D / LIDAR — contrôles de régression sur les VRAIS modules de
 * téléchargement / stockage (src/features/lidar/lib/downloader.ts, storage.ts)
 * avec un `fetch` simulé.
 *
 *   npx tsx script-test-bench/audit/d-lidar-downloader.ts [--mem-mb=167] [--skip-fanout]
 *
 * Pas de réseau. Code de sortie = nombre de contrôles qui reproduisent un bogue.
 *
 * Contrôles
 *  A. Annulation après un nouvel essai sur 429 -> la récursion de fetchWithRetry perd `signal`
 *  B. Annulation d'un téléchargement au Japon -> downloadJapanTile ne transmet jamais `signal`
 *  C. Pic mémoire d'un téléchargement IGN d'~167 Mo (morceaux + mergeChunks)
 *  D. Éventail en cas d'échec du WFS -> nombre d'URL candidates aveugles récupérées
 *  E. Aller-retour des noms de fichiers de listCachedTiles pour chaque territoire
 *  F. Taille dans le repli CacheStorage -> Response(ArrayBuffer) n'a pas de content-length
 *  G. Suppression pendant que le fichier OPFS est verrouillé (NoModificationAllowedError)
 *     -> LidarManager.removeTile émet 'tileRemoved', jamais l'indication d'erreur
 *  H. Tuile de l'emprise suisse servie par l'IGN (Haute-Savoie) : une 2e sélection
 *     retélécharge tout le fichier car downloadIgnTile ne vérifie jamais le cache LAMB93
 */
import { downloadTile } from '../../src/features/lidar/lib/downloader.ts';
import { listCachedTiles, deleteTile } from '../../src/features/lidar/lib/storage.ts';
import { wgs84ToTileCoord } from '../../src/features/lidar/lib/coordConvert.ts';
import type { TileCoord } from '../../src/features/lidar/types.ts';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as const;
}));
const MEM_MB = Number(args.get('mem-mb') ?? 167);

let failures = 0;
const report: string[] = [];
function result(id: string, bug: boolean, msg: string) {
  if (bug) failures++;
  const line = `${bug ? 'BUG ' : 'OK  '} ${id}: ${msg}`;
  report.push(line);
  console.log(line);
}

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchImpl = () => Promise.reject(new Error('no mock'));
let fetchLog: string[] = [];
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  fetchLog.push(url);
  return fetchImpl(url, init);
}) as typeof fetch;

const LAS_MAGIC = [0x4c, 0x41, 0x53, 0x46]; // "LASF"

/** Un flux de corps qui ne se termine jamais, sauf si le signal de la requête est annulé. */
function hangingResponse(init?: RequestInit, onStart?: () => void): { res: Response; kill: () => void } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      c.enqueue(new Uint8Array([...LAS_MAGIC, 0, 0, 0, 0]));
      onStart?.();
    },
  });
  const sig = init?.signal;
  sig?.addEventListener('abort', () => {
    try { ctrl.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ }
  });
  return {
    res: new Response(stream, { status: 200, headers: { 'content-length': String(100 * 1024 * 1024) } }),
    kill: () => { try { ctrl.error(new Error('test teardown')); } catch { /* closed */ } },
  };
}

function settledWithin<T>(p: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([
    p.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>((r) => realSetTimeout(() => r('pending'), ms)),
  ]);
}

// Une tuile en France métropolitaine (Grenoble). Le WFS n'est pas analysable
// sous Node (pas de DOMParser), donc le téléchargeur utilise sa liste de repli
// codée en dur — la même branche qu'un navigateur quand
// data.geopf.fr/telechargement est indisponible.
const IGN_COORD: TileCoord = wgs84ToTileCoord(5.7245, 45.1885);

async function checkA() {
  const kills: Array<() => void> = [];
  let downloadCalls = 0;
  fetchLog = [];
  fetchImpl = async (url, init) => {
    if (url.includes('/resource/LiDARHD-NUALID')) return new Response('', { status: 200 });
    downloadCalls++;
    if (downloadCalls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    const h = hangingResponse(init);
    kills.push(h.kill);
    return h.res;
  };
  const ac = new AbortController();
  const p = downloadTile({ ...IGN_COORD, xKm: IGN_COORD.xKm + 1000 }, undefined, ac.signal); // clé unique, pas de cache
  // attend que le nouvel essai soit en cours de diffusion
  for (let i = 0; i < 100 && downloadCalls < 2; i++) await new Promise((r) => realSetTimeout(r, 20));
  ac.abort();
  const state = await settledWithin(p, 1500);
  result('A', state === 'pending',
    `cancel after HTTP 429 retry -> download promise ${state} 1.5 s after abort() (downloader.ts:355/366/399 recurse without \`signal\`)`);
  fetchImpl = async () => new Response("", { status: 404 });
  kills.forEach((k) => k());
  await p.catch(() => undefined);
}

async function checkB() {
  // Shizuoka (jeu de données VIRTUAL SHIZUOKA)
  const coord = wgs84ToTileCoord(138.38, 34.97);
  if (!String(coord.projection).startsWith('JGD2011')) {
    result('B', false, `skipped: projection=${coord.projection}`);
    return;
  }
  const kills: Array<() => void> = [];
  let started = false;
  fetchLog = [];
  fetchImpl = async (_url, init) => {
    const h = hangingResponse(init, () => { started = true; });
    kills.push(h.kill);
    return h.res;
  };
  const ac = new AbortController();
  const p = downloadTile(coord, undefined, ac.signal);
  for (let i = 0; i < 200 && !started; i++) await new Promise((r) => realSetTimeout(r, 20));
  if (!started) {
    result('B', false, `skipped: no Japan candidate URL for ${coord.projection} ${coord.xKm}/${coord.yKm}`);
    return;
  }
  ac.abort();
  const state = await settledWithin(p, 1500);
  result('B', state === 'pending',
    `Japan download (${fetchLog[0]?.slice(0, 80)}...) -> ${state} 1.5 s after abort() (downloader.ts:712-713 no signal)`);
  fetchImpl = async () => new Response("", { status: 404 });
  kills.forEach((k) => k());
  await p.catch(() => undefined);
}

async function checkC() {
  const total = MEM_MB * 1024 * 1024;
  const CHUNK = 64 * 1024;
  fetchLog = [];
  fetchImpl = async (url) => {
    if (url.includes('/resource/LiDARHD-NUALID')) return new Response('', { status: 200 });
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= total) { c.close(); return; }
        const n = Math.min(CHUNK, total - sent);
        const chunk = new Uint8Array(n);
        if (sent === 0) chunk.set(LAS_MAGIC);
        sent += n;
        c.enqueue(chunk);
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-length': String(total) } });
  };
  (globalThis as { gc?: () => void }).gc?.();
  const base = process.memoryUsage().arrayBuffers;
  let peak = base;
  const sample = () => { const ab = process.memoryUsage().arrayBuffers; if (ab > peak) peak = ab; };
  const timer = setInterval(sample, 5);
  const coord = { ...IGN_COORD, xKm: IGN_COORD.xKm + 2000 };
  const t0 = performance.now();
  const buf = await downloadTile(coord, () => sample());
  sample();
  clearInterval(timer);
  const dt = performance.now() - t0;
  const peakMb = (peak - base) / 1048576;
  result('C', peakMb > 1.8 * MEM_MB,
    `~${MEM_MB} MB tile: returned ${(buf.byteLength / 1048576).toFixed(1)} MB, peak extra ArrayBuffer memory ${peakMb.toFixed(0)} MB `
    + `(${(peakMb / MEM_MB).toFixed(2)}x file size; chunks[] + mergeChunks copy, downloader.ts:427/454) in ${dt.toFixed(0)} ms`);
  await deleteTile(coord);
}

async function checkD() {
  if (args.has('skip-fanout')) return;
  fetchLog = [];
  fetchImpl = async (url) => {
    if (url.includes('/resource/LiDARHD-NUALID')) return new Response('', { status: 503 });
    return new Response('', { status: 404 });
  };
  // accélère les pauses de 200 ms entre requêtes
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown;
  const t0 = performance.now();
  let err = '';
  try {
    await downloadTile({ ...IGN_COORD, xKm: IGN_COORD.xKm + 3000 });
  } catch (e) {
    err = (e as Error).message;
  } finally {
    (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
  }
  const downloads = fetchLog.filter((u) => u.includes('/download/')).length;
  const wallClockS = (downloads - 1) * 0.2; // vrai INTER_REQUEST_DELAY_MS, hors aller-retour réseau
  result('D', downloads > 20,
    `WFS down -> ${downloads} blind GETs on data.geopf.fr for ONE tile (>= ${wallClockS.toFixed(0)} s of sleeps + RTT), `
    + `final error: "${err.slice(0, 90)}..." (${(performance.now() - t0).toFixed(0)} ms with timers fast-forwarded)`);
}

async function checkE() {
  fetchImpl = async () => new Response('', { status: 500 });
  const samples: Array<[string, number, number]> = [
    ['LAMB93 Grenoble', 5.7245, 45.1885],
    ['LAMB93 Corsica', 9.15, 42.15],
    ['UTM40S Reunion', 55.53, -21.12],
    ['LV95 Zermatt', 7.75, 46.02],
    ['NZTM Christchurch', 172.63, -43.53],
    ['JGD Shizuoka', 138.38, 34.97],
  ];
  const { saveTile } = await import('../../src/features/lidar/lib/storage.ts');
  const bad: string[] = [];
  for (const [label, lon, lat] of samples) {
    const coord = wgs84ToTileCoord(lon, lat);
    const las = new Uint8Array(16); las.set(LAS_MAGIC);
    await saveTile(coord, las.buffer);
    const listed = (await listCachedTiles()).find((t) => t.coord.xKm === coord.xKm && t.coord.yKm === coord.yKm);
    const ok = listed && listed.coord.projection === coord.projection && listed.coord.altRef === coord.altRef;
    if (!ok) bad.push(`${label}: saved ${JSON.stringify(coord)} listed ${JSON.stringify(listed?.coord ?? null)}`);
    await deleteTile(coord);
  }
  result('E', bad.length > 0, bad.length ? `name round-trip broken: ${bad.join(' | ')}` : `file-name round-trip OK for ${samples.length} territories`);
}

function checkF() {
  // storage.ts:102-108 construit la Response en cache à partir d'un
  // ArrayBuffer ; storage.ts:292 lit plus tard `content-length` pour afficher
  // la taille.
  const r = new Response(new ArrayBuffer(167 * 1024 * 1024), { headers: { 'Content-Type': 'application/octet-stream' } });
  const cl = r.headers.get('content-length');
  result('F', cl === null, `Response(ArrayBuffer).headers content-length = ${cl} -> CacheStorage-fallback tiles listed as 0 MB`);
}

async function checkG() {
  // Faux OPFS dont les fichiers sont verrouillés (une poignée d'écriture /
  // synchrone ouverte dans l'onglet du visualiseur fait lever
  // NoModificationAllowedError par Chrome sur removeEntry).
  const locked = () => { throw new DOMException('locked', 'NoModificationAllowedError'); };
  const fakeDir = {
    getFileHandle: async () => ({ getFile: async () => new File([new Uint8Array(4)], 'x') }),
    removeEntry: async () => locked(),
  };
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: { getDirectory: async () => ({ getDirectoryHandle: async () => fakeDir }) },
  });
  const { LidarManager } = await import('../../src/features/lidar/lib/lidarManager.ts');
  const m = new LidarManager();
  const events: string[] = [];
  m.on((e) => events.push(e.type + (e.error ? `(${e.error})` : '')));
  await m.removeTile(IGN_COORD);
  Object.defineProperty(globalThis.navigator, 'storage', { configurable: true, value: undefined });
  result('G', !events.some((e) => e.startsWith('error')),
    `removeTile on a locked OPFS file -> events [${events.join(', ')}] (storage.ts:207-211 swallows; lidarManager.ts:99-102 hint unreachable)`);
}

async function checkH() {
  const coord = wgs84ToTileCoord(6.87, 45.92); // Chamonix
  if (coord.projection !== 'CH1903_LV95') { result('H', false, `skipped: ${coord.projection}`); return; }
  let ignDownloads = 0;
  fetchImpl = async (url) => {
    if (url.includes('/api/stac/')) return Response.json({ features: [] });
    if (url.includes('/resource/LiDARHD-NUALID')) return new Response('', { status: 200 });
    if (url.includes('data.geopf.fr/telechargement/download/')) {
      ignDownloads++;
      const body = new Uint8Array(1024); body.set(LAS_MAGIC);
      return new Response(body, { status: 200, headers: { 'content-length': '1024' } });
    }
    return new Response('', { status: 404 });
  };
  await downloadTile(coord);
  const first = ignDownloads;
  await downloadTile(coord);
  const lamb = (await import('../../src/features/lidar/lib/downloader.ts')).swissTileToLamb93TileCoord(coord);
  await deleteTile(lamb);
  result('H', ignDownloads > first,
    `Chamonix tile (LV95 ${coord.xKm}/${coord.yKm} -> LAMB93 ${lamb.xKm}/${lamb.yKm}): IGN file GETs after 1st selection=${first}, after 2nd=${ignDownloads} `
    + `(downloader.ts:159 checks cache with the CH key only; downloadIgnTile:225 never checks hasTile)`);
}

async function main() {
  console.log(`IGN test tile: ${JSON.stringify(IGN_COORD)}`);
  await checkG();
  await checkA();
  await checkB();
  await checkC();
  await checkD();
  await checkE();
  checkF();
  await checkH();
  globalThis.fetch = realFetch;
  console.log(`\n${failures} bug(s) reproduced`);
  process.exit(failures);
}

main().catch((e) => { console.error(e); process.exit(99); });
