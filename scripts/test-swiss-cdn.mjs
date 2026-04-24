// Stress-test data.geo.admin.ch range-fetch capacity to understand the
// real concurrency / timeout envelope of the swissSURFACE3D CDN.
//
// Usage:
//   node scripts/test-swiss-cdn.mjs
//
// What we measure:
//   1. STAC bbox query latency (single request, warm vs cold)
//   2. COG header range fetch latency (32 KB from each of N COGs in parallel)
//   3. COG tile range fetch latency (~300-800 KB ranges in parallel at
//      varying concurrency: 4, 8, 12, 16, 24, 32). Reports p50/p95/max
//      and timeout rate per concurrency level.
//
// Targets a busy alpine area near Sion (the area the user is browsing).
// All requests use 20 s timeout and report failure cause.

import https from 'node:https';
import { performance } from 'node:perf_hooks';

const STAC_BASE = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swisssurface3d-raster/items';

// Sion area bbox (LV95 E ~2575-2590, N ~1115-1135 → wgs84)
const STAC_BBOX = '7.20,46.15,7.45,46.30';

const TIMEOUT_MS = 20_000;
const HEADER_BYTES = 32_768;
const TILE_BYTES = 524_288; // typical compressed LZW Float32 tile

const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function fetchRange(url, offset, length, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const headers = offset !== null
      ? { Range: `bytes=${offset}-${offset + length - 1}`, 'User-Agent': 'redview-cdn-probe/1.0' }
      : { 'User-Agent': 'redview-cdn-probe/1.0' };
    const req = https.get(url, { headers, agent }, (res) => {
      let total = 0;
      res.on('data', (c) => { total += c.length; });
      res.on('end', () => {
        const dt = performance.now() - t0;
        resolve({ ok: res.statusCode === 200 || res.statusCode === 206, status: res.statusCode, bytes: total, ms: dt, url });
      });
      res.on('error', (err) => {
        resolve({ ok: false, status: 0, bytes: 0, ms: performance.now() - t0, url, err: err.message });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
      resolve({ ok: false, status: 0, bytes: 0, ms: performance.now() - t0, url, err: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, bytes: 0, ms: performance.now() - t0, url, err: err.message });
    });
  });
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(label, results) {
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const okMs = ok.map((r) => r.ms);
  const failByErr = {};
  for (const r of fail) failByErr[r.err || `HTTP${r.status}`] = (failByErr[r.err || `HTTP${r.status}`] || 0) + 1;
  console.log(
    `${label.padEnd(28)} n=${results.length}  ok=${ok.length}  fail=${fail.length}  ` +
    `p50=${pct(okMs, 50).toFixed(0)}ms  p95=${pct(okMs, 95).toFixed(0)}ms  max=${pct(okMs, 100).toFixed(0)}ms  ` +
    (fail.length ? `errs=${JSON.stringify(failByErr)}` : ''),
  );
}

async function inFlight(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── 1. STAC query ────────────────────────────────────────────────────────
console.log('═══ STAC ════════════════════════════════════════════════════════════════');
const stacUrl = `${STAC_BASE}?bbox=${STAC_BBOX}&limit=200`;
const stacRuns = [];
for (let i = 0; i < 3; i++) {
  const r = await fetchRange(stacUrl, null, 0);
  stacRuns.push(r);
  console.log(`  STAC run ${i + 1}: status=${r.status} bytes=${r.bytes} ms=${r.ms.toFixed(0)} ${r.err || ''}`);
}

// Pull COG urls from the STAC response
let cogUrls = [];
{
  const r = await new Promise((resolve) => {
    https.get(stacUrl, { agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  });
  const json = JSON.parse(r);
  for (const f of json.features || []) {
    for (const [k, a] of Object.entries(f.assets || {})) {
      if (k.endsWith('.tif') && (a?.type || '').includes('tiff')) { cogUrls.push(a.href); break; }
    }
  }
  console.log(`  STAC features: ${json.features?.length || 0}, COG urls: ${cogUrls.length}`);
}

if (cogUrls.length === 0) {
  console.error('No COG URLs resolved — aborting');
  process.exit(1);
}

// ─── 2. COG headers in parallel ───────────────────────────────────────────
console.log('\n═══ COG HEADERS (32 KB range) ═══════════════════════════════════════════');
for (const conc of [4, 8, 16, 24]) {
  const sample = cogUrls.slice(0, Math.min(24, cogUrls.length));
  const t0 = performance.now();
  const results = await inFlight(sample, conc, (u) => fetchRange(u, 0, HEADER_BYTES));
  const wall = performance.now() - t0;
  summarize(`headers conc=${conc} wall=${wall.toFixed(0)}ms`, results);
}

// ─── 3. COG tile ranges in parallel (deeper into the file) ────────────────
console.log('\n═══ COG TILE RANGES (~512 KB at offset 65536) ═══════════════════════════');
for (const conc of [4, 8, 12, 16, 24, 32]) {
  const sample = cogUrls.slice(0, Math.min(32, cogUrls.length));
  const t0 = performance.now();
  // Deep offset to skip the IFD region and hit a real tile body.
  const results = await inFlight(sample, conc, (u) => fetchRange(u, 65_536, TILE_BYTES));
  const wall = performance.now() - t0;
  summarize(`ranges  conc=${conc} wall=${wall.toFixed(0)}ms`, results);
}

console.log('\nDone.');
