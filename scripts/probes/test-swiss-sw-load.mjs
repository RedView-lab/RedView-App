// Simulate the SW load pattern: 16 mercator tiles requested simultaneously,
// each spawning ~50 internal-tile range fetches → ~800 concurrent ranges
// fanned out through a 12-slot semaphore.
//
// This is the actual scenario the browser SW runs when the user pans into
// a fresh viewport over Switzerland.

import https from 'node:https';
import { performance } from 'node:perf_hooks';

const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d-raster/items';
const BBOX = '7.20,46.15,7.45,46.30';
const TIMEOUT_MS = 20_000;
const TILE_BYTES = 524_288;

const agent = new https.Agent({ keepAlive: true, maxSockets: 256 });

function fetchRange(url, offset, length) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const headers = { Range: `bytes=${offset}-${offset + length - 1}` };
    const req = https.get(url, { headers, agent }, (res) => {
      let total = 0;
      res.on('data', (c) => { total += c.length; });
      res.on('end', () => resolve({ ok: res.statusCode === 206 || res.statusCode === 200, status: res.statusCode, ms: performance.now() - t0 }));
      res.on('error', (err) => resolve({ ok: false, status: 0, ms: performance.now() - t0, err: err.message }));
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); resolve({ ok: false, status: 0, ms: performance.now() - t0, err: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, ms: performance.now() - t0, err: err.message }));
  });
}

// Single global semaphore — same as SWISS_CONCURRENCY in the SW
function makeSemaphore(slots) {
  let active = 0;
  const queue = [];
  function drain() {
    while (active < slots && queue.length > 0) {
      const { fn, resolve } = queue.pop(); // LIFO like SW
      active++;
      fn().then(resolve).finally(() => { active--; drain(); });
    }
  }
  return (fn) => new Promise((resolve) => { queue.push({ fn, resolve }); drain(); });
}

async function getCogUrls() {
  const r = await new Promise((resolve) => {
    https.get(`${STAC}?bbox=${BBOX}&limit=200`, { agent }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
    });
  });
  const json = JSON.parse(r);
  const urls = [];
  for (const f of json.features || []) {
    for (const [k, a] of Object.entries(f.assets || {})) {
      if (k.endsWith('.tif') && (a?.type || '').includes('tiff')) { urls.push(a.href); break; }
    }
  }
  return urls;
}

async function simulate(numBursts, fetchesPerBurst, semaphoreSlots) {
  const cogUrls = await getCogUrls();
  const sem = makeSemaphore(semaphoreSlots);
  const t0 = performance.now();

  // Each "burst" is one buildSwissTile() call requesting fetchesPerBurst ranges.
  // All bursts kick off at t=0 (worst case: user pans, 16 mercator tiles arrive
  // in the same animation frame).
  const bursts = [];
  for (let b = 0; b < numBursts; b++) {
    bursts.push((async () => {
      const fetches = [];
      for (let i = 0; i < fetchesPerBurst; i++) {
        const url = cogUrls[(b * fetchesPerBurst + i) % cogUrls.length];
        // Different offset per fetch so server doesn't just dedup
        const offset = 32_768 + (i % 8) * 65_536;
        fetches.push(sem(() => fetchRange(url, offset, TILE_BYTES)));
      }
      return Promise.all(fetches);
    })());
  }

  const results = (await Promise.all(bursts)).flat();
  const wall = performance.now() - t0;
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const okMs = ok.map((r) => r.ms).sort((a, b) => a - b);
  const errs = {};
  for (const r of fail) errs[r.err || `HTTP${r.status}`] = (errs[r.err || `HTTP${r.status}`] || 0) + 1;
  const p = (q) => okMs[Math.floor(q * okMs.length)] || 0;
  console.log(
    `bursts=${numBursts} fetchesEach=${fetchesPerBurst} sem=${semaphoreSlots}  ` +
    `total=${results.length} ok=${ok.length} fail=${fail.length} wall=${wall.toFixed(0)}ms  ` +
    `p50=${p(0.5).toFixed(0)} p95=${p(0.95).toFixed(0)} max=${p(0.999).toFixed(0)}ms  ` +
    (fail.length ? `errs=${JSON.stringify(errs)}` : ''),
  );
}

console.log('═══ BURST SIM (mimicking SW under viewport-pan load) ═══');
for (const cfg of [
  { bursts: 4,  perBurst: 25, sem: 12 },
  { bursts: 8,  perBurst: 25, sem: 12 },
  { bursts: 16, perBurst: 25, sem: 12 },
  { bursts: 16, perBurst: 50, sem: 12 },  // realistic: 16 mercator tiles × 50 internals
  { bursts: 16, perBurst: 50, sem: 8 },
  { bursts: 16, perBurst: 50, sem: 24 },
]) {
  await simulate(cfg.bursts, cfg.perBurst, cfg.sem);
}
