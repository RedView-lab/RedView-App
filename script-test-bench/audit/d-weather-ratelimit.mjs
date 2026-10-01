/**
 * Audit D / DW — weather traffic vs the shared /api rate-limit bucket.
 *
 * 1. LIVE (local server only): proves that every /api/* route except auth/*
 *    shares ONE 120 req/min/IP bucket (server.mjs MAX_API_REQUESTS) by sending
 *    125 requests from a private X-Forwarded-For bucket (the server trusts XFF
 *    from loopback, so this does not disturb other audits on 127.0.0.1).
 * 2. MODEL: request counts of the weather features, with the constants read
 *    from the source, for typical user actions.
 * Exit 1 if a plausible single-user action exceeds the bucket.
 *   node script-test-bench/audit/d-weather-ratelimit.mjs
 */
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3000';
const read = (p) => fs.readFileSync(p, 'utf8');
const num = (src, re) => Number((src.match(re) || [])[1]);

const server = read('server.mjs');
const LIMIT = num(server, /MAX_API_REQUESTS\s*=\s*(\d+)/);
const TILE_LIMIT = num(server, /MAX_TILE_REQUESTS\s*=\s*(\d+)/);

// ── 1. live check ──────────────────────────────────────────────────────
const xff = `192.0.2.${1 + Math.floor(Math.random() * 250)}`;
const statuses = {};
let first429 = null;
let retryAfter = null;
for (let i = 1; i <= LIMIT + 5; i++) {
  const res = await fetch(`${BASE}${i % 3 === 0 ? '/api/does-not-exist' : '/api/openmeteo/v1/nope' /* 404s: no upstream fetch */}`, { headers: { 'X-Forwarded-For': xff } });
  statuses[res.status] = (statuses[res.status] || 0) + 1;
  if (res.status === 429 && first429 === null) { first429 = i; retryAfter = res.headers.get('retry-after'); }
  await res.arrayBuffer();
}
// tiles bucket is separate
const tileRes = await fetch(`${BASE}/radar-tiles/5/16/11?path=/v2/radar/x`, { headers: { 'X-Forwarded-For': xff } });
console.log(`live: limit=${LIMIT}/min (tiles ${TILE_LIMIT}/min); statuses=${JSON.stringify(statuses)}; first 429 at request #${first429}, Retry-After=${retryAfter}; tile route same IP -> ${tileRes.status} (separate bucket)`);

// ── 2. model ───────────────────────────────────────────────────────────
const vps = read('src/features/weather/overlay/vpsWeatherClient.ts');
const prefetchBlock = vps.slice(vps.indexOf('const targetIndices'), vps.indexOf('];', vps.indexOf('const targetIndices')));
const PREFETCH = (prefetchBlock.match(/currentIndex [+-] \d/g) || []).length; // 5
const windGrid = read('src/features/weather/lib/wind-grid.ts');
const WIND_MAX_POINTS = Number((windGrid.match(/MAX_POINTS = ([\d_]+)/) || [])[1]?.replace(/_/g, '')) || 3072;
const om = read('src/features/weather/lib/open-meteo.ts');
const WIND_BATCH = num(om, /BATCH_SIZE = (\d+)/);
const WIND_RETRIES = num(om, /MAX_RETRIES = (\d+)/);
const batcher = read('src/features/weather/overlay/openMeteoBatchFetcher.ts');
const TRENDS_BATCH = num(batcher, /TRENDS_BATCH_SIZE = (\d+)/);

const scrub = (layers, hours) => layers * (hours + PREFETCH);
const windOneFetch = Math.ceil(WIND_MAX_POINTS / WIND_BATCH) * 2; // France HD + fallback split per batch (worst case at a border)
const windPerPan = windOneFetch * 3; // selection + prefetch +1 h and +24 h (prefetchWindGridData)
const rows = [
  ['open project: meta + 1 tile/layer + prefetch, 3 layers, 3 route variants', 1 + 3 * (1 + PREFETCH) + 3 + 1],
  ['scrub 24 h, 1 layer', scrub(1, 24)],
  ['scrub 24 h, 3 layers', scrub(3, 24)],
  ['scrub full slider (~62 h positions -> 48 VPS hours), 3 layers', scrub(3, 48)],
  ['scrub 24 h, 5 layers', scrub(5, 24)],
  [`Tendances tab, one viewport (<=896 pts / ${TRENDS_BATCH})`, Math.ceil(896 / TRENDS_BATCH)],
  [`legacy project with hidden Wind on: one pan at z>=12 (${WIND_MAX_POINTS} pts / ${WIND_BATCH}, x2 models, x3 selections)`, windPerPan],
];
console.log(`\nmodel (prefetch=${PREFETCH} tiles/layer, wind batch=${WIND_BATCH}, retries on 429=${WIND_RETRIES}):`);
let over = 0;
for (const [label, count] of rows) {
  const flag = count > LIMIT ? 'OVER' : count > LIMIT * 0.6 ? 'near' : 'ok';
  if (count > LIMIT) over += 1;
  console.log(`  ${flag.padEnd(4)} ${String(count).padStart(4)} req  ${label}`);
}
if (first429 !== LIMIT + 1) {
  console.error(`\nunexpected: first 429 at #${first429}, expected #${LIMIT + 1}`);
  process.exit(2);
}
if (over > 0) {
  console.error(`\nFAIL: ${over} single-user weather action(s) exceed the shared ${LIMIT}/min /api bucket (429 then also blocks BRouter/POI for up to 60 s).`);
  process.exit(1);
}
console.log('\nPASS');
