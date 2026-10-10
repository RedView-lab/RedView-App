/**
 * E2E de la catégorie POI « cimetière » sur le build de prod (`npm run e2e:poi-cemetery`,
 * après `npm run build:vite` + `npm run build:server`) : harnais de user-journey (faux
 * Appwrite, services du VPS simulés), aucun appel à la prod.
 *
 *   1. connexion, projet, import d'une boucle GPX ;
 *   2. onglet POI : la ligne « Cimetières » est cochée à 100 m ;
 *   3. « Charger » : le faux serveur POI renvoie un cimetière sans nom à 60 m,
 *      un cimetière à 400 m (hors des 100 m) et une fontaine ; on vérifie la
 *      catégorie demandée, la feuille de route, la popup, l'export GPX.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

import { installBackend, startAppServer } from '../dashboard-perf/harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const CHANNEL = argv.includes('--channel') ? argv[argv.indexOf('--channel') + 1] : process.env.CI ? 'chromium' : 'msedge';
const OUT = path.join(REPO, 'script-test-bench', 'reports', 'poi-cemetery');
const TRACK_POINTS = 1001;
const [LAT0, LON0, R] = [45.86, 6.17, 0.036];
let failures = 0;
const check = (ok: unknown, label: string, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Point de la boucle à l'angle `a`, décalé de `outM` mètres vers l'extérieur. */
function onLoop(a: number, outM = 0): { lat: number; lon: number } {
  const r = R + outM / 111_320;
  return { lat: LAT0 + r * Math.sin(a), lon: LON0 + (r / Math.cos((LAT0 * Math.PI) / 180)) * Math.cos(a) };
}

function loopGpx(): string {
  let pts = '';
  for (let i = 0; i < TRACK_POINTS; i++) {
    const a = (i / (TRACK_POINTS - 1)) * 2 * Math.PI;
    const p = onLoop(a);
    pts += `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${(450 + 150 * Math.sin(3 * a)).toFixed(1)}</ele></trkpt>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="redview-e2e" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Boucle cimetières</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

const POIS = [
  { id: 10_000_000_000_001, osmId: 1, osmType: 'way', ...onLoop(0.8, 60), category: 'cemetery', name: null, tags: { landuse: 'cemetery' }, source: null, srcConfidence: null },
  { id: 10_000_000_000_002, osmId: 2, osmType: 'way', ...onLoop(2.4, 400), category: 'cemetery', name: 'Cimetière lointain', tags: {}, source: null, srcConfidence: null },
  { id: 3, osmId: 3, osmType: 'node', ...onLoop(4.0, 5), category: 'drinking_water', name: null, tags: { amenity: 'drinking_water' }, source: null, srcConfidence: null },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-cemetery-e2e-'));
  const gpxPath = path.join(work, 'boucle.gpx');
  fs.writeFileSync(gpxPath, loopGpx());
  const server = await startAppServer(REPO);
  const context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    channel: CHANNEL === 'chromium' ? undefined : CHANNEL, headless: true, viewport: { width: 1600, height: 900 }, locale: 'fr-FR', acceptDownloads: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const pageErrors: string[] = [];
  try {
    await installBackend(context, { root: REPO, origin: server.origin, loggedIn: false, analytics: false });
    const requested: Array<{ categories: string[]; radiusM: number }> = [];
    for (const route of ['brouter', 'openmeteo', 'weather', 'meteofrance', 'overpass', 'geocode-iconic', 'snow-context']) {
      await context.route(new RegExp(`^${server.origin}/api/${route}(?:[/?]|$)`), (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"e2e"}' }));
    }
    await context.route(new RegExp(`^${server.origin}/api/poi(?:[/?]|$)`), async (r) => {
      const url = new URL(r.request().url());
      if (url.searchParams.get('op') !== 'corridor') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"features":[]}' });
      const body = JSON.parse(r.request().postData() ?? '{}') as { categories: string[]; radiusM: number };
      requested.push({ categories: body.categories, radiusM: body.radiusM });
      const features = POIS.filter((p) => body.categories.includes(p.category));
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ features }) });
    });
    const p: Page = context.pages()[0] ?? await context.newPage();
    p.on('pageerror', (e) => pageErrors.push(String(e)));

    await p.goto(server.origin);
    await p.getByPlaceholder('Saisissez votre e-mail').fill('bench@redview.test');
    await p.getByPlaceholder('••••••••').fill('mot-de-passe-e2e');
    await p.getByRole('button', { name: 'Se connecter', exact: true }).click();
    await p.getByRole('button', { name: 'Créer un projet' }).click({ timeout: 30_000 });
    await p.getByRole('textbox', { name: 'Nom du projet' }).waitFor({ timeout: 60_000 });
    await p.getByRole('button', { name: 'Nouvel itinéraire' }).click();
    const chooser = p.waitForEvent('filechooser');
    await p.getByText('Uploader un fichier gpx').click();
    await (await chooser).setFiles(gpxPath);
    await p.getByText(/25[,.]\d\s*km/).first().waitFor({ timeout: 30_000 });

    await p.getByRole('navigation', { name: "Mode d'édition" }).getByRole('button', { name: 'POI' }).click();
    const cemeteryBox = p.getByRole('checkbox', { name: 'Cimetières', exact: true });
    await cemeteryBox.waitFor({ state: 'attached', timeout: 10_000 });
    check(await cemeteryBox.isChecked(), 'ligne « Cimetières » cochée par défaut');
    check(await p.getByRole('textbox', { name: 'Distance Cimetières' }).inputValue() === '100m', 'distance par défaut 100 m');
    const labels = await p.locator('.rvi-cfield__label').allTextContents();
    check(labels[0] === 'Fontaines' && labels[1] === 'Cimetières', 'à côté des fontaines', labels.slice(0, 3).join(', '));
    await p.screenshot({ path: path.join(OUT, 'cemetery-panel.png') });

    // La recherche part d'elle-même après l'import ; sinon « Charger ».
    const load = p.getByRole('button', { name: 'Charger', exact: true });
    if (await load.isVisible().catch(() => false)) await load.click();
    await p.getByText(/POI trouvés/).first().waitFor({ timeout: 30_000 });
    // Une requête par rayon : les cimetières seuls à 100 m (+ tolérance), le
    // reste à 20 m — jamais tous les commerces au rayon des cimetières.
    const cemeteryRequest = requested.find((q) => q.categories.includes('cemetery'));
    check(cemeteryRequest?.categories.length === 1 && cemeteryRequest.radiusM >= 100, 'cimetières interrogés seuls, à ≥ 100 m', JSON.stringify(cemeteryRequest ?? null).slice(0, 80));
    const others = requested.filter((q) => !q.categories.includes('cemetery'));
    check(others.length > 0 && others.every((q) => q.radiusM < 30), 'autres catégories interrogées à < 30 m', others.map((q) => `${q.categories.length} cat. à ${q.radiusM.toFixed(0)} m`).join(', '));
    const found = await p.getByText(/POI trouvés/).first().textContent();
    // 60 m gardé (≤ 100 m), 400 m écarté, la fontaine à 5 m gardée (≤ 20 m).
    check(/\(2 POI trouvés\)/.test(found ?? ''), 'filtrage latéral : cimetière à 60 m gardé, à 400 m écarté', found ?? '');

    // Feuille de route : un cimetière sans nom s'appelle « Cimetière ».
    const sheet = p.getByRole('button', { name: /Feuille de route/ }).first();
    if (await sheet.isVisible().catch(() => false)) await sheet.click();
    const row = p.getByText('Cimetière', { exact: true }).first();
    await row.waitFor({ timeout: 15_000 }).catch(() => {});
    check(await row.isVisible().catch(() => false), 'ligne « Cimetière » dans la feuille de route');
    const icon = await p.locator('img[src*="cemetery"]').count();
    check(icon > 0, 'icône cimetière affichée', `${icon} image(s)`);
    await p.screenshot({ path: path.join(OUT, 'cemetery-roadbook.png') });

    // Export GPX : nom CIM, type Garmin water, catégorie exacte.
    const showRight = p.getByRole('button', { name: 'Afficher le panneau droit' });
    if (await showRight.isVisible().catch(() => false)) await showRight.click();
    const expand = p.getByRole('button', { name: 'Développer le module exporter' });
    if (await expand.isVisible().catch(() => false)) await expand.click();
    const download = p.waitForEvent('download');
    await p.locator('.rvc-exporter-panel button', { hasText: 'Exporter' }).last().click();
    const file = await (await download).path();
    const xml = fs.readFileSync(file!, 'utf8');
    const wpt = xml.match(/<wpt[\s\S]*?<\/wpt>/g)?.find((w) => w.includes('cemetery')) ?? '';
    check(/<name>CIM_[GD]\d+<\/name>/.test(wpt), 'export GPX : nom CIM_…', wpt.match(/<name>[^<]*<\/name>/)?.[0] ?? '(absent)');
    check(wpt.includes('<type>water</type>'), 'export GPX : type Garmin water');
    check(wpt.includes('<redview:category>cemetery</redview:category>'), 'export GPX : catégorie exacte');
    check(pageErrors.length === 0, 'aucune erreur de page', pageErrors.join(' | '));
  } catch (err) {
    failures++;
    console.log('✖', err instanceof Error ? err.message.split(/\r?\n/)[0] : err);
    await context.pages()[0]?.screenshot({ path: path.join(OUT, 'cemetery-failure.png') }).catch(() => {});
  } finally {
    await context.close();
    await server.stop();
  }
  console.log(failures ? `\n${failures} ÉCHEC(S)` : '\nOK');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
