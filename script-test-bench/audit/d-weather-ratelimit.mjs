/**
 * Audit D / DW — weather traffic vs the /api rate-limit buckets.
 *
 * server.mjs picks the bucket from the RESOLVED route: auth/* (15/min),
 * weather = VPS tiles/meta (/api/weather/*, MAX_WEATHER_REQUESTS), pointcloud,
 * and the general bucket (MAX_API_REQUESTS) shared by BRouter, POI and
 * Open-Meteo (/api/openmeteo/*). A 429 in the general bucket blocks routing and
 * POI for up to 60 s, so a single weather action must never reach it.
 *
 * 1. LIVE (local server only): exhausts the general bucket from a private
 *    X-Forwarded-For (the server trusts XFF from loopback, so this does not
 *    disturb other audits on 127.0.0.1), checks the 429 lands exactly at
 *    MAX_API_REQUESTS + 1, and that the weather and tile routes of the same IP
 *    still answer (separate buckets).
 * 2. MODEL: request counts of the weather features per bucket, with the
 *    constants read from the source, for typical user actions.
 * Exit 1 if a plausible single-user action exceeds its bucket.
 *   node script-test-bench/audit/d-weather-ratelimit.mjs [base URL, default http://127.0.0.1:3000]
 */
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const read = (p) => fs.readFileSync(p, 'utf8');
const num = (src, re) => Number((src.match(re) || [])[1]);

const server = read('server.mjs');
const LIMITS = {
  general: num(server, /MAX_API_REQUESTS\s*=\s*(\d+)/),
  weather: num(server, /MAX_WEATHER_REQUESTS\s*=\s*(\d+)/),
  tiles: num(server, /MAX_TILE_REQUESTS\s*=\s*(\d+)/),
};
for (const [name, value] of Object.entries(LIMITS)) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`cannot read the ${name} limit from server.mjs`);
    process.exit(2);
  }
}

// ── 1. live check ──────────────────────────────────────────────────────
const xff = `192.0.2.${1 + Math.floor(Math.random() * 250)}`;
const headers = { 'X-Forwarded-For': xff };
const statuses = {};
let first429 = null;
let retryAfter = null;
for (let i = 1; i <= LIMITS.general + 5; i++) {
  const res = await fetch(`${BASE}${i % 3 === 0 ? '/api/does-not-exist' : '/api/openmeteo/v1/nope' /* 404s: no upstream fetch */}`, { headers });
  statuses[res.status] = (statuses[res.status] || 0) + 1;
  if (res.status === 429 && first429 === null) { first429 = i; retryAfter = res.headers.get('retry-after'); }
  await res.arrayBuffer();
}
// Same IP, general bucket exhausted: the weather route ('..' in the query is
// refused by the handler with 400, before any upstream fetch) and a tile route
// must still pass the rate limiter.
const weatherRes = await fetch(`${BASE}/api/weather/meta.json?probe=..`, { headers });
await weatherRes.arrayBuffer();
const tileRes = await fetch(`${BASE}/radar-tiles/5/16/11?path=/v2/radar/x`, { headers });
await tileRes.arrayBuffer();
console.log(`live: general=${LIMITS.general}/min, weather=${LIMITS.weather}/min, tiles=${LIMITS.tiles}/min per family`);
console.log(`  general bucket: statuses=${JSON.stringify(statuses)}; first 429 at request #${first429}, Retry-After=${retryAfter}`);
console.log(`  same IP after that: /api/weather -> ${weatherRes.status}, /radar-tiles -> ${tileRes.status}`);

let liveFailures = 0;
if (first429 !== LIMITS.general + 1) {
  console.error(`  FAIL first 429 at #${first429}, expected #${LIMITS.general + 1}`);
  liveFailures += 1;
}
if (weatherRes.status === 429) {
  console.error('  FAIL /api/weather is counted in the general bucket');
  liveFailures += 1;
}
if (tileRes.status === 429) {
  console.error('  FAIL tile routes are counted in the general bucket');
  liveFailures += 1;
}

// ── 2. model ───────────────────────────────────────────────────────────
const vps = read('src/features/weather/overlay/vpsWeatherClient.ts');
if (!vps.includes('/api/weather/tiles/')) {
  console.error('vpsWeatherClient no longer fetches /api/weather/tiles/: update the bucket model');
  process.exit(2);
}
const prefetchBlock = vps.slice(vps.indexOf('const targetIndices'), vps.indexOf('];', vps.indexOf('const targetIndices')));
const PREFETCH = (prefetchBlock.match(/currentIndex [+-] \d/g) || []).length; // 5
const windGrid = read('src/features/weather/lib/wind-grid.ts');
const WIND_MAX_POINTS = Number((windGrid.match(/MAX_POINTS = ([\d_]+)/) || [])[1]?.replace(/_/g, '')) || 3072;
const om = read('src/features/weather/lib/open-meteo.ts');
const WIND_BATCH = num(om, /BATCH_SIZE = (\d+)/);
const WIND_RETRIES = num(om, /MAX_RETRIES = (\d+)/);

const scrub = (layers, hours) => layers * (hours + PREFETCH);
const windOneFetch = Math.ceil(WIND_MAX_POINTS / WIND_BATCH); // one model (meteofrance_seamless) per batch
const windPerPan = windOneFetch * 3; // selection + prefetch +1 h and +24 h (prefetchWindGridData)
// [label, { bucket: requests }]
const rows = [
  ['open project: meta + 1 tile/layer + prefetch, 3 layers, 3 route variants', { weather: 1 + 3 * (1 + PREFETCH), general: 3 + 1 }],
  ['scrub 24 h, 1 layer', { weather: scrub(1, 24) }],
  ['scrub 24 h, 3 layers', { weather: scrub(3, 24) }],
  ['scrub full slider (~62 h positions -> 48 VPS hours), 3 layers', { weather: scrub(3, 48) }],
  ['scrub 24 h, 5 layers', { weather: scrub(5, 24) }],
  ['scrub full slider, 5 layers, twice within a minute', { weather: 2 * scrub(5, 48) }],
  // Dormant: the Wind section is hidden and windEnabled forced off at load
  // (useOverlayWindSnowState) — this row guards its return.
  [`Wind overlay if re-enabled: one pan at z>=12 (${WIND_MAX_POINTS} pts / ${WIND_BATCH}, x3 selections)`, { general: windPerPan }],
];
console.log(`\nmodel (prefetch=${PREFETCH} tiles/layer, wind batch=${WIND_BATCH}, retries on 429=${WIND_RETRIES}):`);
let over = 0;
for (const [label, counts] of rows) {
  const parts = [];
  let worst = 'ok';
  for (const [bucket, count] of Object.entries(counts)) {
    const limit = LIMITS[bucket];
    const flag = count > limit ? 'OVER' : count > limit * 0.6 ? 'near' : 'ok';
    if (flag === 'OVER') over += 1;
    if (flag === 'OVER' || (flag === 'near' && worst === 'ok')) worst = flag;
    parts.push(`${bucket} ${count}/${limit}`);
  }
  console.log(`  ${worst.padEnd(4)} ${parts.join(', ').padEnd(28)} ${label}`);
}

if (liveFailures > 0) {
  console.error(`\nFAIL: ${liveFailures} live bucket check(s) failed.`);
  process.exit(1);
}
if (over > 0) {
  console.error(`\nFAIL: ${over} single-user weather action(s) exceed their bucket (a 429 in the general bucket also blocks BRouter/POI for up to 60 s).`);
  process.exit(1);
}
console.log('\nPASS');
