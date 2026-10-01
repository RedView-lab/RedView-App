/**
 * Audit D / DW1 — weather overlay: blob URLs revoked while still referenced by
 * the module-level `recoloredBlobCache` (src/features/weather/overlay/vpsTileRenderer.ts).
 *
 * Uses the REAL cache module (cacheRecoloredBlob / getCachedRecoloredBlob) and
 * replays, line for line, the three revoke sites of the overlay hooks:
 *   A. useWeatherStyleManager.removeAll (L502-505) — runs in the cleanup of the
 *      [map, isMapLoaded] effect of useWeatherOverlay/hook.ts (L178-186), i.e.
 *      when Dashboard sets mapLoaded=false (project close, pages/Dashboard/index.tsx L33, L177).
 *   B. useWeatherDataPipeline.renderFromData (L196-198) — Forecast tab -> Tendances tab
 *      replaces the VPS layer and revokes its (cached) URL.
 *   C. useWeatherDataPipeline.renderVpsForecast (L494-498) — layer toggled off
 *      while its recolor was being encoded: cached THEN revoked.
 * After each, the next forecast render at the same hour/palette reads the cache
 * (L290 instant path / L443 network path) and hands Mapbox a dead blob: URL.
 *
 * Node's resolveObjectURL() returns undefined for a revoked blob URL, which is
 * exactly what the browser's image loader sees (net::ERR_FILE_NOT_FOUND).
 *
 * Also verifies (static) that the revoke sites are still present in the source,
 * so this script stops failing once the code is fixed.
 *
 * Exit code 1 = bug reproduces.   Run: npx tsx script-test-bench/audit/d-weather-blob-revoke.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveObjectURL } from 'node:buffer';
import { pathToFileURL } from 'node:url';

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const root = process.cwd();
const { cacheRecoloredBlob, getCachedRecoloredBlob } = await import(
  pathToFileURL(path.join(root, 'src/features/weather/overlay/vpsTileRenderer.ts')).href
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAlive = (url: string | undefined) => Boolean(url && resolveObjectURL(url));
const newBlobUrl = () => URL.createObjectURL(new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' }));

type Rendered = { url: string; signature: string };
let failures = 0;

function report(name: string, url: string | undefined) {
  const alive = isAlive(url);
  console.log(`${alive ? 'OK  ' : 'BUG '} ${name}: cache returns ${url} -> ${alive ? 'live' : 'REVOKED (Mapbox image load fails -> blank layer, status "ready")'}`);
  if (!alive) failures += 1;
}

// ── Scenario A: removeAll on project close, then reopen ────────────────
{
  const sig = 'vps|2026-10-01T12:00:00Z|gradient|abc';
  const url = newBlobUrl();
  cacheRecoloredBlob(sig, url);                   // useWeatherDataPipeline L494
  const renderedRef: { current: Record<string, Rendered> } = { current: { temperature: { url, signature: sig } } }; // L509
  // useWeatherStyleManager.removeAll L502-507 (verbatim logic)
  for (const rendered of Object.values(renderedRef.current)) {
    if (rendered?.url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(rendered.url), 1_000);
  }
  renderedRef.current = {};
  await sleep(1_100);
  // reopen: renderVpsForecast instant path L257 (hasBlob) -> L290-292
  report('A project close/reopen (removeAll)', getCachedRecoloredBlob(sig));
}

// ── Scenario B: Forecast -> Tendances -> Forecast ──────────────────────
{
  const sig = 'vps|2026-10-01T13:00:00Z|gradient|abc';
  const url = newBlobUrl();
  cacheRecoloredBlob(sig, url);
  const rendered: Rendered = { url, signature: sig };
  // renderFromData (trends) L184-198: new canvas url replaces layer, old rendered.url revoked after 1 s
  const trendsUrl = newBlobUrl();
  void trendsUrl;
  if (rendered?.url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(rendered.url), 1_000);
  await sleep(1_100);
  // back to forecast: rendered signature (trends) != vps sig -> L443 getCachedRecoloredBlob
  report('B forecast->trends->forecast (renderFromData)', getCachedRecoloredBlob(sig));
}

// ── Scenario C: toggle off during encode ───────────────────────────────
{
  const sig = 'vps|2026-10-01T14:00:00Z|fill|abc';
  const blobUrl = newBlobUrl();
  cacheRecoloredBlob(sig, blobUrl);               // L494
  const stillActive = false;                     // L496-497 user unticked the layer meanwhile
  if (!stillActive && blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl); // L498
  // user re-ticks the layer at the same hour -> L443
  report('C toggle-off during encode (renderVpsForecast L494-498)', getCachedRecoloredBlob(sig));
}

// ── Static guard: are the revoke sites still in the source? ────────────
const sm = fs.readFileSync(path.join(root, 'src/features/weather/overlay/useWeatherOverlay/useWeatherStyleManager.ts'), 'utf8');
const dp = fs.readFileSync(path.join(root, 'src/features/weather/overlay/useWeatherOverlay/useWeatherDataPipeline.ts'), 'utf8');
const removeAllBody = sm.slice(sm.indexOf('const removeAll'), sm.indexOf('const ensureLayer'));
const staticA = /revokeObjectURL\(rendered\.url\)/.test(removeAllBody) && !/RecoloredBlob/.test(removeAllBody);
const staticC = /cacheRecoloredBlob\(signature, blobUrl\);[\s\S]{0,400}revokeObjectURL\(blobUrl\)/.test(dp);
const staticB = /rendered\?\.url\.startsWith\('blob:'\)[\s\S]{0,120}revokeObjectURL\(rendered\.url\)/.test(dp);
console.log(`static: removeAll revokes cached URLs=${staticA}  renderFromData revokes=${staticB}  cache-then-revoke=${staticC}`);

if (failures > 0 && (staticA || staticB || staticC)) {
  console.error(`\nFAIL: ${failures} scenario(s) hand a revoked blob: URL to Mapbox.`);
  process.exit(1);
}
console.log('\nPASS');
