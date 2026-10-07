/**
 * Audit D — weather endpoints probe (read-only). Default target is the LOCAL
 * prod server; pass a base URL to probe elsewhere:
 *   node script-test-bench/audit/d-weather-prod-probe.mjs [https://app.redview.tech]
 * Sends <= 13 requests, >= 3.2 s apart when the target is not localhost
 * (shared 120 req/min/IP bucket on prod).
 * Exit 1 if: the openmeteo proxy does not answer from the self-hosted VPS
 * Open-Meteo (`X-Weather-Source: self-hosted-vps`; the public API is
 * non-commercial and never used), the CSP still lets the browser reach
 * open-meteo.com, or route weather beyond the 4-day horizon answers 5xx (the
 * self-hosted instance answers 200 with null values there, which the client
 * reads as « no data »).
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const remote = !/127\.0\.0\.1|localhost/.test(BASE);
const GAP_MS = remote ? 3200 : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
// Local only: server trusts XFF from loopback, so use our own rate-limit bucket (other audits hammer 127.0.0.1).
const LOCAL_XFF = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
const problems = [];
/** Model the app requests everywhere (src/features/weather/lib/openMeteoConfig.ts). */
const MODEL = 'meteofrance_seamless';

async function probe(label, pathOrUrl, { show = [], body = false } = {}) {
  if (n > 0) await sleep(GAP_MS);
  n += 1;
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'redview-audit-D/1.0', ...(remote ? {} : { 'X-Forwarded-For': LOCAL_XFF }) } });
  } catch (e) {
    console.log(`#${n} ${label}: NETWORK ERROR ${e.message}`);
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Math.round(performance.now() - t0);
  const h = (k) => res.headers.get(k);
  const extra = show.map((k) => `${k}=${h(k) ?? '-'}`).join(' | ');
  console.log(`#${n} ${label}: ${res.status} ${ms}ms ${buf.length}B ct=${h('content-type')} cc=${h('cache-control')} src=${h('x-weather-source') ?? '-'} ${extra}`);
  if (body) console.log(`    body: ${buf.toString('utf8').slice(0, 220).replace(/\s+/g, ' ')}`);
  return { res, buf, ms };
}

const root = await probe('GET /', '/', { show: ['strict-transport-security', 'x-frame-options'] });
if (root) {
  const csp = root.res.headers.get('content-security-policy') || '';
  const openMeteoConnect = /connect-src[^;]*open-meteo/.test(csp);
  console.log(`    CSP present=${Boolean(csp)} rainviewer-connect=${/connect-src[^;]*rainviewer/.test(csp)} open-meteo-connect=${openMeteoConnect}`);
  if (openMeteoConnect) problems.push('CSP connect-src still allows open-meteo.com (the browser only talks to /api/openmeteo)');
}

const meta = await probe('meta.json (cold?)', '/api/weather/meta.json', { show: ['age'] });
let metaJson = null;
try { metaJson = meta && meta.res.ok ? JSON.parse(meta.buf.toString('utf8')) : null; } catch { /* */ }
if (metaJson) {
  console.log(`    meta: model=${metaJson.model} updatedAt=${metaJson.updatedAt} hours=${metaJson.hours?.length} first=${metaJson.hours?.[0]} last=${metaJson.hours?.at(-1)} fmt=${metaJson.tileFormat} grid=${JSON.stringify(metaJson.gridSize)} bbox=${JSON.stringify(metaJson.bbox)}`);
  console.log(`    variables: ${JSON.stringify(metaJson.variables)}`);
  await probe('meta.json (warm)', '/api/weather/meta.json');
  const hour = metaJson.hours[Math.min(6, metaJson.hours.length - 1)];
  const tile = `/api/weather/tiles/temperature_${hour}.${metaJson.tileFormat || 'png'}`;
  await probe(`tile ${tile} (cold?)`, tile);
  await probe('tile (warm)', tile);
}
await probe('tile unknown hour', '/api/weather/tiles/temperature_2000-01-01T00:00:00Z.png', { body: true });

const radar = await probe('radar.json', '/api/weather/radar.json');
let radarJson = null;
try { radarJson = radar && radar.res.ok ? JSON.parse(radar.buf.toString('utf8')) : null; } catch { /* */ }
if (radarJson) {
  const frames = radarJson.radar?.past ?? [];
  const last = frames.at(-1);
  console.log(`    radar: host=${radarJson.host} frames=${frames.length} last=${last?.path} age=${last ? Math.round(Date.now() / 1000 - last.time) : '?'}s`);
  // exactly what buildRadarTileUrl() produces (src/features/weather/radar/radarClient.ts L125-136)
  const q = `host=${encodeURIComponent(radarJson.host)}&path=${encodeURIComponent(last.path)}`;
  await probe('radar tile z5 raw', `/radar-tiles/5/16/11?${q}`);
  const p = encodeURIComponent('gradient:a0d8ff_0.1_1:3a7bd5_1_5:ff3b30_5_20');
  await probe('radar tile z5 recolor', `/radar-tiles/5/16/11?${q}&p=${p}&sig=x`);
}

// Route weather — same query as fetchRouteWeatherDataset (src/features/weather/lib/routeWeather.ts), 26 stations Paris->Lyon
const stations = Array.from({ length: 26 }, (_, i) => ({ lat: 48.8566 + (45.764 - 48.8566) * (i / 25), lng: 2.3522 + (4.8357 - 2.3522) * (i / 25) }));
const lats = stations.map((s) => s.lat.toFixed(4)).join(',');
const lngs = stations.map((s) => s.lng.toFixed(4)).join(',');
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const routeUrl = (start) => {
  const end = new Date(start.getTime() + 86400000);
  return `/api/openmeteo/v1/forecast?latitude=${lats}&longitude=${lngs}`
    + '&hourly=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,cloud_cover,relative_humidity_2m,sunshine_duration'
    + `&start_date=${iso(start)}&end_date=${iso(end)}`
    + '&timezone=auto&temperature_unit=celsius&precipitation_unit=mm&wind_speed_unit=kmh&cell_selection=nearest'
    + `&models=${MODEL}`;
};
const route = await probe('openmeteo route 26 stations (today)', routeUrl(today));
if (route && (!route.res.ok || route.res.headers.get('x-weather-source') !== 'self-hosted-vps')) {
  problems.push(`openmeteo route -> ${route.res.status} src=${route.res.headers.get('x-weather-source') ?? '-'} (expected 200 from the self-hosted VPS: OPENMETEO_UPSTREAM unset or VPS failing)`);
}
const far = await probe('openmeteo route start +30 d (beyond horizon)', routeUrl(new Date(today.getTime() + 30 * 86400000)), { body: true });
if (far && far.res.status >= 500) problems.push(`route weather beyond horizon -> ${far.res.status} (expected 200 with null values or a 4xx, never a 5xx)`);

// Wind batch — same as fetchBatch (src/features/weather/lib/open-meteo.ts), 200 coords (the proxy's limit)
const wc = Array.from({ length: 200 }, (_, i) => ({ lat: 45 + (i % 20) * 0.02, lng: 6 + Math.floor(i / 20) * 0.02 }));
const hourKey = `${iso(today)}T12:00`;
const wind = await probe(`openmeteo wind batch 200 coords ${MODEL}`,
  `/api/openmeteo/v1/forecast?latitude=${wc.map((c) => c.lat.toFixed(4)).join(',')}&longitude=${wc.map((c) => c.lng.toFixed(4)).join(',')}`
  + `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&start_hour=${encodeURIComponent(hourKey)}&end_hour=${encodeURIComponent(hourKey)}`
  + `&wind_speed_unit=ms&timeformat=iso8601&timezone=Europe%2FParis&cell_selection=nearest&models=${MODEL}`);
if (wind && !wind.res.ok) problems.push(`openmeteo wind batch -> ${wind.res.status}`);

console.log(`\nrequests sent: ${n}`);
if (problems.length) {
  console.error('PROBLEMS:\n - ' + problems.join('\n - '));
  process.exit(1);
}
