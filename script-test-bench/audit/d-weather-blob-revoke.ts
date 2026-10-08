/**
 * Audit D / DW1 — surcouche météo : URL de blob révoquées alors qu'elles sont
 * encore référencées par le `recoloredBlobCache` de niveau module
 * (src/features/weather/overlay/vpsTileRenderer.ts).
 *
 * Utilise le VRAI module de cache (cacheRecoloredBlob / getCachedRecoloredBlob)
 * et rejoue, ligne pour ligne, les sites de révocation des hooks de surcouche :
 *   A. useWeatherStyleManager.removeAll (L502-505) — s'exécute dans le
 *      nettoyage de l'effet [map, isMapLoaded] de useWeatherOverlay/hook.ts
 *      (L178-186), c'est-à-dire quand le Dashboard pose mapLoaded=false
 *      (fermeture du projet, pages/Dashboard/index.tsx L33, L177).
 *   C. useWeatherDataPipeline.renderVpsForecast (L494-498) — couche décochée
 *      pendant l'encodage de sa recoloration : mise en cache PUIS révoquée.
 * Après chacun, le rendu de prévision suivant à la même heure / palette lit le
 * cache (chemin instantané L290 / chemin réseau L443) et passe à Mapbox une
 * URL blob: morte.
 *
 * resolveObjectURL() de Node renvoie undefined pour une URL de blob révoquée,
 * exactement ce que voit le chargeur d'images du navigateur
 * (net::ERR_FILE_NOT_FOUND).
 *
 * Vérifie aussi (statiquement) que les sites de révocation sont toujours dans
 * le source, pour que ce script cesse d'échouer une fois le code corrigé.
 *
 * Code de sortie 1 = le bogue se reproduit.   Lancement : npx tsx script-test-bench/audit/d-weather-blob-revoke.ts
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

// ── Scénario A : removeAll à la fermeture du projet, puis réouverture ──
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

// ── Scénario C : décocher pendant l'encodage ───────────────────────────
{
  const sig = 'vps|2026-10-01T14:00:00Z|fill|abc';
  const blobUrl = newBlobUrl();
  cacheRecoloredBlob(sig, blobUrl);               // L494
  const stillActive = false;                     // L496-497 l'utilisateur a décoché la couche entre-temps
  if (!stillActive && blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl); // L498
  // l'utilisateur recoche la couche à la même heure -> L443
  report('C toggle-off during encode (renderVpsForecast L494-498)', getCachedRecoloredBlob(sig));
}

// ── Garde statique : les sites de révocation sont-ils encore dans le source ? ──
const sm = fs.readFileSync(path.join(root, 'src/features/weather/overlay/useWeatherOverlay/useWeatherStyleManager.ts'), 'utf8');
const dp = fs.readFileSync(path.join(root, 'src/features/weather/overlay/useWeatherOverlay/useWeatherDataPipeline.ts'), 'utf8');
const removeAllBody = sm.slice(sm.indexOf('const removeAll'), sm.indexOf('const ensureLayer'));
const staticA = /revokeObjectURL\(rendered\.url\)/.test(removeAllBody) && !/RecoloredBlob/.test(removeAllBody);
const staticC = /cacheRecoloredBlob\(signature, blobUrl\);[\s\S]{0,400}revokeObjectURL\(blobUrl\)/.test(dp);
console.log(`static: removeAll revokes cached URLs=${staticA}  cache-then-revoke=${staticC}`);

if (failures > 0 && (staticA || staticC)) {
  console.error(`\nFAIL: ${failures} scenario(s) hand a revoked blob: URL to Mapbox.`);
  process.exit(1);
}
console.log('\nPASS');
