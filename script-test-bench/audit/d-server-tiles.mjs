// Audit D — tile routes, headers, CSP and rate limiting of the local prod server.
//
// Usage:  npx tsx script-test-bench/audit/d-server-tiles.mjs [--base http://127.0.0.1:3000] [--no-ratelimit]
//
// Exits non-zero when one of the regression checks marked BUG reproduces.
// The rate-limit section hammers the LOCAL server only (cheap 204 routes).
import { inflateSync, crc32 } from 'node:zlib';

const args = process.argv.slice(2);
const BASE = (() => {
  const i = args.indexOf('--base');
  return i >= 0 ? args[i + 1] : 'http://127.0.0.1:3000';
})();
const DO_RATELIMIT = !args.includes('--no-ratelimit');

const results = [];
function check(id, ok, detail, { bug = true } = {}) {
  results.push({ id, ok, detail, bug });
  console.log(`${ok ? 'PASS' : bug ? 'BUG ' : 'WARN'}  ${id}  ${detail}`);
}

async function get(path, init = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, { redirect: 'manual', ...init });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, ms: performance.now() - t0 };
}

function pngInfo(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25] };
}

// Strict structural validation (chunk CRCs, mandatory IDAT).
function pngValidate(buf) {
  const errors = [];
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return ['bad signature'];
  let off = 8; let idat = 0; const types = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    types.push(type);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.slice(off + 4, off + 8 + len)) !== crc) errors.push(`CRC mismatch on chunk "${type}"`);
    if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) errors.push(`unknown CRITICAL chunk "${type}"`);
    if (type === 'IDAT') idat++;
    off += 12 + len;
  }
  if (!idat) errors.push('no IDAT chunk');
  return errors.length ? errors.concat([`chunks=${types.join(',')}`]) : [];
}

function pngIdat(buf) {
  let off = 8; const parts = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') parts.push(buf.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  return inflateSync(Buffer.concat(parts));
}

// ── A. Headers / CSP ────────────────────────────────────────────────────
async function sectionHeaders() {
  console.log('\n== A. headers / CSP ==');
  for (const p of ['/', '/viewer', '/viewer.html', '/some/spa/route', '/sw-dem.js', '/sw-dem/core/config.js', '/sw-dem/workers/slope-pool.worker.js']) {
    const { res } = await get(p);
    const csp = res.headers.get('content-security-policy') || '';
    check(`A.csp ${p}`, res.status === 200 && csp.includes("default-src 'self'"), `status=${res.status} csp=${csp ? 'yes' : 'NO'} cache=${res.headers.get('cache-control')}`);
  }
  const { res: r } = await get('/');
  const csp = r.headers.get('content-security-policy') || '';
  const connect = (csp.split(';').find((d) => d.trim().startsWith('connect-src')) || '');
  // Every external host the browser (page or SW) talks to for map layers.
  const required = [
    'https://api.mapbox.com', 'https://events.mapbox.com', 'https://a.tiles.mapbox.com',
    'https://api.rainviewer.com', 'https://tilecache.rainviewer.com', 'https://tilecache.rainviewer.net',
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/1/1/1.png',
    'https://data.geopf.fr', 'https://data.geo.admin.ch', 'https://wmts10.geo.admin.ch',
    'https://hoydedata.no', 'https://wcs.hoydedata.no', 'https://servicios.idee.es', 'https://www.ign.es',
    'https://japan-pointcloud.s3.ap-northeast-1.amazonaws.com', 'https://opentopography.s3.sdsc.edu',
  ];
  const tokens = connect.trim().split(/\s+/).slice(1);
  const matches = (u) => {
    const url = new URL(u);
    return tokens.some((t) => {
      if (t === "'self'" || t === 'blob:' || t === 'data:') return false;
      const m = t.match(/^https:\/\/(\*\.)?([^/]+)(\/.*)?$/);
      if (!m) return false;
      const [, wild, host, pth] = m;
      const hostOk = wild ? url.hostname.endsWith('.' + host) : url.hostname === host;
      if (!hostOk) return false;
      if (!pth) return true;
      return pth.endsWith('/') ? url.pathname.startsWith(pth) : url.pathname === pth;
    });
  };
  for (const u of required) check(`A.connect-src ${new URL(u).host}`, matches(u), u);
  const { res: tile } = await get('/slope-tiles/99/0/0');
  check('A.base-headers on tile route', tile.headers.get('x-content-type-options') === 'nosniff', `nosniff=${tile.headers.get('x-content-type-options')} hsts=${!!tile.headers.get('strict-transport-security')}`);
}

// ── B. invalid coordinates ──────────────────────────────────────────────
async function sectionInvalid() {
  console.log('\n== B. invalid coordinates ==');
  const bad = ['-1/0/0', '23/0/0', '99999999999999999999/0/0', '1/2/0', '1/0/2', '3/8/1', 'a/b/c', '1.5/0/0', '%2e%2e/%2e%2e/x', '..%2f..%2fetc/passwd/1', '0/0', '12/2100/1460/extra'];
  for (const prefix of ['/slope-tiles/', '/altitude-tiles/', '/dem-tiles/', '/radar-tiles/', '/ortho-tiles/']) {
    for (const c of bad) {
      const p = prefix + c + (prefix === '/radar-tiles/' ? '?path=/v2/radar/abc' : '');
      const { res, buf } = await get(p);
      const ct = res.headers.get('content-type') || '';
      let ok;
      if (prefix === '/ortho-tiles/') ok = res.status < 500; // no server route: SPA fallback expected
      else ok = res.status === 204 || res.status === 400;
      // trailing garbage after valid coords: server regex has no `$`
      if (c === '12/2100/1460/extra' && prefix !== '/ortho-tiles/' && prefix !== '/radar-tiles/') ok = true;
      check(`B ${p.slice(0, 60)}`, ok, `status=${res.status} type=${ct} len=${buf.length}`, { bug: res.status >= 500 });
    }
  }
  // ortho-tiles has no server fallback: SPA index.html is returned with 200
  const { res, buf } = await get('/ortho-tiles/12/2100/1460');
  check('B.ortho-tiles server fallback', !(res.status === 200 && (res.headers.get('content-type') || '').includes('text/html')),
    `GET /ortho-tiles/12/2100/1460 without SW -> ${res.status} ${res.headers.get('content-type')} (${buf.length} B, SPA index.html)`, { bug: false });
}

// ── C. valid tiles: latency, size, cache headers ────────────────────────
async function sectionValid() {
  console.log('\n== C. valid tiles (Mont Blanc area) ==');
  const tiles = [['slope', '/slope-tiles/12/2120/1462'], ['altitude', '/altitude-tiles/12/2120/1462'], ['dem', '/dem-tiles/12/2120/1462'],
    ['slope-z14', '/slope-tiles/14/8482/5850'], ['dem-z14', '/dem-tiles/14/8482/5850']];
  for (const [name, p] of tiles) {
    const cold = await get(p + '?audit=' + Date.now());
    const warm = await get(p + '?audit=' + Date.now());
    const info = pngInfo(cold.buf);
    console.log(`      ${name.padEnd(10)} cold=${cold.ms.toFixed(0)}ms warm=${warm.ms.toFixed(0)}ms size=${cold.buf.length}B png=${JSON.stringify(info)} cache=${cold.res.headers.get('cache-control')}`);
    check(`C.${name} 256px`, info && info.w === 256 && info.h === 256, `status=${cold.res.status}`);
  }

  // Slope source maxzoom is 16 (HD) but AWS stops at z14: the fallback
  // answers z15/z16 with a 1x1 transparent PNG, 200 + immutable 7 days.
  const s15 = await get('/slope-tiles/15/16965/11701');
  const i15 = pngInfo(s15.buf);
  check('C.slope z15 not a cached 1x1 placeholder', !(s15.res.status === 200 && i15?.w === 1 && /immutable|max-age=604800/.test(s15.res.headers.get('cache-control') || '')),
    `status=${s15.res.status} png=${JSON.stringify(i15)} cache=${s15.res.headers.get('cache-control')}`);

  const v15 = pngValidate(s15.buf);
  check('C.placeholder PNG is a valid image', v15.length === 0, `TRANSPARENT_1X1_PNG: ${v15.join('; ') || 'ok'} (browsers reject it -> Mapbox tile error, cached 7 days)`);

  // DEM z15 (DEM_SOURCE_MAXZOOM=17): placeholder instead of 204 (SW contract: never fake a tile).
  const d15 = await get('/dem-tiles/15/16965/11701');
  const di = pngInfo(d15.buf);
  check('C.dem z15 answers 204, not a placeholder', d15.res.status === 204,
    `status=${d15.res.status} png=${JSON.stringify(di)} valid=${pngValidate(d15.buf).length === 0} cache=${d15.res.headers.get('cache-control')}`);
  const okTile = await get('/slope-tiles/12/2120/1462');
  check('C.generated slope PNG valid', pngValidate(okTile.buf).length === 0, pngValidate(okTile.buf).join('; ') || 'ok');

  // Slope fallback ignores ?zone / rv-dem-profile / source-dem: identical bytes.
  const a = await get('/slope-tiles/12/2120/1462');
  const b = await get('/slope-tiles/12/2120/1462?zone=deadbeef&rv-dem-profile=terrain&source-dem=fast-30m&res=2');
  check('C.slope fallback honours zone mask', !a.buf.equals(b.buf) || a.buf.length < 100,
    `plain=${a.buf.length}B zone+profile=${b.buf.length}B identical=${a.buf.equals(b.buf)}`, { bug: false });
}

// ── D. radar fallback ───────────────────────────────────────────────────
async function sectionRadar() {
  console.log('\n== D. radar ==');
  let path;
  try {
    const meta = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
    path = meta.radar.past.at(-1).path;
    console.log(`      rainviewer frames past=${meta.radar.past.length} nowcast=${meta.radar.nowcast?.length ?? 0} latest=${path}`);
  } catch (e) {
    console.log('      rainviewer meta unavailable', e.message);
    return;
  }
  const z = 5, x = 16, y = 11;
  const upstream = `https://tilecache.rainviewer.com${path}/512/${z}/${x}/${y}/2/1_1.png`;
  const t0 = performance.now();
  const raw = Buffer.from(await (await fetch(upstream)).arrayBuffer());
  const info = pngInfo(raw);
  let filters = {};
  try {
    const inflated = pngIdat(raw);
    const bpp = info.colorType === 6 ? 4 : info.colorType === 3 ? 1 : 3;
    const stride = 1 + info.w * bpp * (info.depth / 8);
    for (let r = 0; r < info.h; r++) filters[inflated[r * stride]] = (filters[inflated[r * stride]] || 0) + 1;
  } catch (e) { filters = { error: e.message }; }
  console.log(`      upstream ${raw.length}B ${(performance.now() - t0).toFixed(0)}ms png=${JSON.stringify(info)} rowFilters=${JSON.stringify(filters)}`);
  const pal = 'gradient:3b82f6_0_2:22c55e_2_5:ef4444_5_20';
  const local = await get(`/radar-tiles/${z}/${x}/${y}?host=${encodeURIComponent('https://tilecache.rainviewer.com')}&path=${encodeURIComponent(path)}&p=${encodeURIComponent(pal)}`);
  const recolored = !local.buf.equals(raw);
  console.log(`      local /radar-tiles ${local.res.status} ${local.ms.toFixed(0)}ms ${local.buf.length}B source=${local.res.headers.get('x-weather-source')} changed=${recolored}`);
  const nonZeroFilterRows = Object.entries(filters).filter(([f]) => f !== '0').reduce((s, [, n]) => s + n, 0);
  check('D.server radar recolor handles PNG row filters', !(info?.colorType === 6 && nonZeroFilterRows > 0 && recolored),
    `upstream colorType=${info?.colorType} rows with filter!=0: ${nonZeroFilterRows}/${info?.h}; recolorRadarPng() rewrites the still-filtered bytes as if they were pixels`);
  check('D.server radar recolor actually applied', info?.colorType !== 6 ? !(local.res.headers.get('x-weather-source') === 'server-radar-recolor' && !recolored) : true,
    `upstream colorType=${info?.colorType}; header claims ${local.res.headers.get('x-weather-source')} while bytes ${recolored ? 'differ' : 'are identical to upstream'}`);
  const evil = await get(`/radar-tiles/${z}/${x}/${y}?host=${encodeURIComponent('https://evil.example')}&path=${encodeURIComponent('/../../x')}`);
  check('D.radar SSRF path rejected', evil.res.status === 400, `status=${evil.res.status}`);
}

// ── E. rate limiting (tiles bucket) ─────────────────────────────────────
async function sectionRateLimit() {
  console.log('\n== E. rate limit (tiles bucket) ==');
  let first429 = -1; let retryAfter = null;
  const N = 650;
  for (let i = 1; i <= N; i++) {
    const res = await fetch(`${BASE}/slope-tiles/99/0/0?i=${i}`);
    await res.arrayBuffer();
    if (res.status === 429 && first429 < 0) { first429 = i; retryAfter = res.headers.get('retry-after'); }
  }
  check('E.tiles bucket enforced', first429 === 601, `first 429 at request #${first429} (expected 601), Retry-After=${retryAfter}`, { bug: false });
  const api = await fetch(`${BASE}/api/health`);
  check('E.api bucket independent from tiles', api.status === 200, `/api/health -> ${api.status}`, { bug: false });
  const radar = await fetch(`${BASE}/radar-tiles/1/0/0?path=/v2/radar/abc`);
  check('E.radar shares tiles bucket', radar.status === 429, `/radar-tiles after exhaustion -> ${radar.status}`, { bug: false });
  console.log('      NOTE: SW-less map with 4 overlay sources (dem/slope/altitude/radar) at 60deg pitch fires 100-250 tile requests per viewport; 600/min is reached after ~3-6 pans.');
}

await sectionHeaders();
await sectionInvalid();
await sectionValid();
await sectionRadar();
if (DO_RATELIMIT) await sectionRateLimit();

const bugs = results.filter((r) => !r.ok && r.bug);
console.log(`\n${results.length} checks, ${bugs.length} bug(s) reproduced`);
process.exit(bugs.length ? 1 : 0);
