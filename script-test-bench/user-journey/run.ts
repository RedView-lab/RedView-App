/**
 * RedView Test-Bench : parcours principal d'un utilisateur, de bout en bout,
 * sur le build de production — `npm run e2e:journey` (dans `check:full`, donc
 * en CI et avant chaque déploiement).
 *
 * Vrai serveur bundlé (`dist-server/server.mjs`, CSP de prod) + navigateur
 * Playwright + faux Appwrite en mémoire (dashboard-perf/fakeAppwrite.mjs).
 * Rien ne part vers la prod : services du VPS (BRouter, POI, météo) remplacés
 * par des réponses fixes, mesure d'audience et GlitchTip interceptés, aucun
 * secret. Marche sans jeton Mapbox (CI) : rien n'est lu sur la carte.
 *
 *   1. connexion (e-mail + mot de passe) ;
 *   2. création d'un projet, renommage ;
 *   3. import d'une trace GPX (boucle de 25,2 km, 1 001 points) ;
 *   4. enregistrement : le document arrive au cloud ;
 *   5. export GPX : mêmes points que la trace importée ;
 *   6. « autre appareil » (profil de navigateur vierge, même compte) : le
 *      projet s'ouvre depuis le cloud, avec son itinéraire ;
 *   7. « Télécharger mes données » : archive ZIP lisible, compte.json et le
 *      projet en .redview (itinéraire compris) ;
 *   8. « Supprimer mon compte » : mot à taper, code e-mail, appel serveur
 *      (simulé ici ; la purge serveur est couverte par
 *      api/_lib/__tests__/accountDeletion.test.ts), puis données locales
 *      effacées et retour à l'écran de connexion.
 *
 * Mesure d'audience : le vrai tracker Umami (copie figée) tourne sur l'appareil 1
 * et ses envois sont capturés — écrans et événements attendus du parcours, avec
 * le contexte commun et le tag de release, et aucun e-mail, nom de projet, id
 * ou chemin de projet dans une seule charge utile (src/shared/lib/analytics/).
 *
 * Accessibilité : chaque écran du parcours (connexion, projets, éditeur avec
 * l'itinéraire, compte, suppression du compte) audité par axe-core (WCAG A/AA),
 * comparé au cliquet a11y-baseline.json (cf. a11y.ts) ; après une correction,
 * `--update-a11y-baseline` le fait redescendre.
 *
 * Contrôles globaux : aucune erreur de page, aucun appel Appwrite non simulé,
 * aucune violation CSP, aucune erreur envoyée à GlitchTip.
 *
 * Usage : `npm run build:vite` puis
 *   npx tsx script-test-bench/user-journey/run.ts [--channel msedge|chromium] [--headed] [--keep] [--update-a11y-baseline]
 * (chromium par défaut en CI, Edge sinon). Rapport : script-test-bench/reports/user-journey/.
 * Sortie non nulle au premier contrôle en échec (capture d'écran jointe).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';

import { installBackend, startAppServer } from '../dashboard-perf/harness.mjs';
import { auditScreen, buildBaseline, compareWithBaseline, readBaseline, type A11yFinding } from './a11y.ts';
import { openZip, readZipEntry } from '../../src/features/redviewFile/lib/zip/zipReader.ts';
import { EVENT_LABELS } from '../../src/shared/lib/analytics/labels.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_DIR = path.join(REPO, 'script-test-bench', 'reports', 'user-journey');
const argv = process.argv.slice(2);
const CHANNEL = argv.includes('--channel') ? argv[argv.indexOf('--channel') + 1] : process.env.CI ? 'chromium' : 'msedge';
const HEADED = argv.includes('--headed');
const UPDATE_A11Y_BASELINE = argv.includes('--update-a11y-baseline');
const A11Y_BASELINE = path.join(REPO, 'script-test-bench', 'user-journey', 'a11y-baseline.json');
const PROJECT_NAME = 'Tour E2E';
const ITINERARY_NAME = 'Boucle E2E';
const TRACK_POINTS = 1001;
const DELETION_CODE = '424242';

type StepResult = { step: string; ok: boolean; seconds: number; detail?: string };
const results: StepResult[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class CheckError extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}

/** Boucle de ~25,2 km autour du lac d'Annecy, 1 001 points, altitude ondulée (aucun trou : pas de routage). */
function loopGpx(): string {
  const n = TRACK_POINTS - 1;
  const radius = 0.036;
  const [lat0, lon0] = [45.86, 6.17];
  let points = '';
  for (let i = 0; i <= n; i += 1) {
    const angle = (i / n) * 2 * Math.PI;
    const lat = lat0 + radius * Math.sin(angle);
    const lon = lon0 + (radius / Math.cos((lat0 * Math.PI) / 180)) * Math.cos(angle);
    points += `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${(450 + 150 * Math.sin(3 * angle)).toFixed(1)}</ele></trkpt>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="redview-e2e" xmlns="http://www.topografix.com/GPX/1/1">`
    + `<trk><name>${ITINERARY_NAME}</name><trkseg>${points}</trkseg></trk></gpx>`;
}

/** Profil vierge, français, avec WebGL logiciel au besoin (CI). */
async function launch(profileDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    channel: CHANNEL === 'chromium' ? undefined : CHANNEL,
    headless: !HEADED,
    viewport: { width: 1600, height: 900 },
    locale: 'fr-FR',
    acceptDownloads: true,
    args: ['--enable-unsafe-swiftshader'],
  });
}

/** Services du VPS : réponses fixes et immédiates (ni réseau, ni quota du serveur). */
async function stubVpsServices(context: BrowserContext, origin: string) {
  const unavailable = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service coupé (e2e)' }) };
  for (const route of ['brouter', 'poi', 'openmeteo', 'weather', 'meteofrance', 'overpass', 'geocode-iconic', 'snow-context']) {
    await context.route(new RegExp(`^${origin}/api/${route}(?:[/?]|$)`), (request) => request.fulfill(unavailable));
  }
}

/** Défauts d'accessibilité relevés écran par écran (cf. a11y.ts). */
const a11yFindings: A11yFinding[] = [];
const a11yScreens: string[] = [];

async function auditA11y(page: Page, screen: string) {
  a11yFindings.push(...await auditScreen(page, screen));
  a11yScreens.push(screen);
}

/** Messages d'erreur de la console (ressources en échec exclues) : affichés en cas d'échec, pour le diagnostic. */
const consoleErrors: string[] = [];

function pageWatch(page: Page, label: string, errors: string[]) {
  page.on('pageerror', (error) => errors.push(`[${label}] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      consoleErrors.push(`[${label}] ${message.text().slice(0, 400)}`);
    }
  });
}

async function step(name: string, run: () => Promise<string | void>) {
  const startedAt = performance.now();
  try {
    const detail = (await run()) ?? undefined;
    results.push({ step: name, ok: true, seconds: (performance.now() - startedAt) / 1000, detail });
    console.log(`✔ ${name}${detail ? ` — ${detail}` : ''} (${((performance.now() - startedAt) / 1000).toFixed(1)} s)`);
  } catch (error) {
    results.push({ step: name, ok: false, seconds: (performance.now() - startedAt) / 1000, detail: String((error as Error).message ?? error) });
    console.log(`✖ ${name} : ${(error as Error).message ?? error}`);
    throw error;
  }
}

/** Distance totale de l'itinéraire, lue dans la feuille de route ou le résumé (jamais sur la carte). */
async function expectItineraryDistance(page: Page) {
  await page.getByText(ITINERARY_NAME).first().waitFor({ timeout: 60_000 });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const text = await page.evaluate(() => document.body.innerText);
    if (/25[.,]2\s?km/.test(text)) return;
    check(Date.now() < deadline, `distance de 25,2 km introuvable dans la page (itinéraire « ${ITINERARY_NAME} »)`);
    await sleep(500);
  }
}

async function readDownload(page: Page, trigger: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  try {
    await trigger();
  } catch (error) {
    pending.catch(() => undefined);
    throw error;
  }
  const download = await pending;
  const file = await download.path();
  check(file, 'téléchargement sans fichier');
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(file) };
}

async function zipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const directory = await openZip(new Blob([new Uint8Array(bytes)]), { maxEntries: 1000 });
  const out = new Map<string, Uint8Array>();
  for (const [name, entry] of directory.entries) out.set(name, await readZipEntry(directory, entry, 512 * 1024 * 1024));
  return out;
}

async function main() {
  check(fs.existsSync(path.join(REPO, 'dist', 'index.html')), 'dist/ absent : lancer `npm run build:vite` d’abord');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-user-journey-'));
  const gpxPath = path.join(workDir, 'boucle-e2e.gpx');
  fs.writeFileSync(gpxPath, loopGpx());

  const server = await startAppServer(REPO);
  const pageErrors: string[] = [];
  const contexts: BrowserContext[] = [];
  let page: Page | null = null;
  let failed = false;
  /** Envois de mesure d'audience capturés (joints au rapport, pour l'audit). */
  let analyticsSent: unknown[] = [];

  try {
    // ── Appareil 1 ───────────────────────────────────────────────────────
    const context = await launch(path.join(workDir, 'profile-1'));
    contexts.push(context);
    const { appwrite, telemetry } = await installBackend(context, { root: REPO, origin: server.origin, loggedIn: false, analytics: true });
    await stubVpsServices(context, server.origin);
    page = context.pages()[0] ?? await context.newPage();
    pageWatch(page, 'appareil 1', pageErrors);
    const p = page;

    await step('connexion', async () => {
      await p.goto(server.origin);
      await p.getByPlaceholder('Saisissez votre e-mail').waitFor({ timeout: 30_000 });
      await auditA11y(p, 'connexion');
      await p.getByPlaceholder('Saisissez votre e-mail').fill('bench@redview.test');
      await p.getByPlaceholder('••••••••').fill('mot-de-passe-e2e');
      await p.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await p.getByRole('button', { name: 'Créer un projet' }).waitFor({ timeout: 30_000 });
      await auditA11y(p, 'projets');
    });

    await step('création et renommage du projet', async () => {
      await p.getByRole('button', { name: 'Créer un projet' }).click();
      const title = p.getByRole('textbox', { name: 'Nom du projet' });
      await title.waitFor({ timeout: 60_000 });
      await title.fill(PROJECT_NAME);
      await title.press('Enter');
      return `${appwrite.state.collections.get('projects')?.size ?? 0} projet(s) au cloud`;
    });

    await step('import GPX', async () => {
      await p.getByRole('button', { name: 'Nouvel itinéraire' }).click();
      const chooser = p.waitForEvent('filechooser');
      await p.getByText('Uploader un fichier gpx').click();
      await (await chooser).setFiles(gpxPath);
      await expectItineraryDistance(p);
      await auditA11y(p, 'editeur');
      return '25,2 km';
    });

    await step('enregistrement au cloud', async () => {
      await p.getByRole('button', { name: 'Enregistrer le projet' }).click();
      const deadline = Date.now() + 30_000;
      for (;;) {
        const doc = [...(appwrite.state.collections.get('projects')?.values() ?? [])][0] as Record<string, unknown> | undefined;
        if (doc && doc.name === PROJECT_NAME && typeof doc.data === 'string' && doc.data.length > 1000) {
          return `document ${String(doc.data).slice(0, 3)}… ${(String(doc.data).length / 1024).toFixed(0)} Kio`;
        }
        check(Date.now() < deadline, 'le projet renommé avec son itinéraire n’est jamais arrivé au cloud');
        await sleep(250);
      }
    });

    await step('export GPX', async () => {
      // Panneau droit replié quand la colonne centrale serait trop étroite (pages/Dashboard/lib/layout.ts).
      const showRight = p.getByRole('button', { name: 'Afficher le panneau droit' });
      if (await showRight.isVisible().catch(() => false)) await showRight.click();
      const expand = p.getByRole('button', { name: 'Développer le module exporter' });
      if (await expand.isVisible().catch(() => false)) await expand.click();
      const { name, bytes } = await readDownload(p, () => p.locator('.rvc-exporter-panel button', { hasText: 'Exporter' }).last().click());
      const xml = bytes.toString('utf8');
      const points = xml.match(/<trkpt\b/g)?.length ?? 0;
      check(/\.gpx$/i.test(name), `fichier exporté inattendu : ${name}`);
      check(points >= TRACK_POINTS * 0.98 && points <= TRACK_POINTS * 1.02, `${points} points exportés pour ${TRACK_POINTS} importés`);
      return `${name}, ${points} points`;
    });

    // ── Appareil 2 : profil vierge, même compte ─────────────────────────
    await step('ouverture sur un autre appareil (depuis le cloud)', async () => {
      const other = await launch(path.join(workDir, 'profile-2'));
      contexts.push(other);
      await appwrite.install(other);
      await stubVpsServices(other, server.origin);
      await other.route('https://analytics.redview.tech/**', (route) => route.fulfill({ status: 204, body: '' }));
      await other.route(`${server.origin}/s/**`, (route) => route.fulfill({ status: 204, body: '' }));
      await other.route('https://errors.redview.tech/**', (route) => route.fulfill({ status: 200, body: '{}' }));
      await other.route(`${server.origin}/api/billing/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"subscription":null,"plan":"beta","customer":null,"invoices":[],"paymentMethods":[]}' }));
      const second = other.pages()[0] ?? await other.newPage();
      pageWatch(second, 'appareil 2', pageErrors);
      await second.goto(server.origin);
      await second.getByRole('button', { name: `Ouvrir ${PROJECT_NAME}` }).click({ timeout: 30_000 });
      await expectItineraryDistance(second);
      await other.close();
      contexts.splice(contexts.indexOf(other), 1);
      return 'itinéraire et 25,2 km retrouvés';
    });

    await step('« Télécharger mes données »', async () => {
      await p.getByRole('button', { name: 'Retour au gestionnaire de projet' }).click();
      await p.getByRole('button', { name: 'Compte', exact: true }).click();
      await p.getByRole('button', { name: 'Télécharger', exact: true }).waitFor({ timeout: 30_000 });
      await auditA11y(p, 'compte');
      const { name, bytes } = await readDownload(p, () => p.getByRole('button', { name: 'Télécharger', exact: true }).click());
      check(/^redview-donnees-\d{4}-\d{2}-\d{2}\.zip$/.test(name), `nom d'archive inattendu : ${name}`);
      const entries = await zipEntries(bytes);
      check(entries.has('LISEZMOI.txt') && entries.has('compte.json'), `archive incomplète : ${[...entries.keys()].join(', ')}`);
      const account = JSON.parse(new TextDecoder().decode(entries.get('compte.json')));
      check(account.account?.email === 'bench@redview.test', 'compte.json sans le compte');
      check(account.projects?.length === 1 && account.projects[0].exported === true, 'compte.json : le projet n’est pas exporté');
      const projectFile = entries.get(account.projects[0].file);
      check(projectFile, `fichier ${account.projects[0].file} absent de l'archive`);
      const redview = await zipEntries(projectFile);
      const project = JSON.parse(new TextDecoder().decode(redview.get('project.json')));
      const itinerary = project.itineraries?.find((candidate: { name?: string }) => candidate.name === ITINERARY_NAME);
      check(itinerary, `project.json du .redview sans l'itinéraire « ${ITINERARY_NAME} »`);
      return `${name} : ${entries.size} entrées, ${account.projects[0].file}`;
    });

    await step('« Supprimer mon compte »', async () => {
      const requests: Array<Record<string, unknown>> = [];
      await context.route(`${server.origin}/api/auth/delete-account`, async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
        requests.push({ ...body, authorization: route.request().headers().authorization ?? null });
        if (body.action === 'request-code') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"sent":true}' });
        if (body.action === 'confirm' && body.code === DELETION_CODE && body.confirm === 'delete-my-account') {
          appwrite.state.loggedIn = false; // compte supprimé : la session n'existe plus
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"deleted":true}' });
        }
        return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"Invalid code"}' });
      });
      await p.getByRole('button', { name: 'Supprimer mon compte' }).click();
      const dialog = p.getByRole('dialog', { name: 'Supprimer votre compte' });
      await dialog.waitFor();
      await auditA11y(p, 'suppression-compte');
      const send = dialog.getByRole('button', { name: 'Recevoir le code' });
      check(await send.isDisabled(), 'le code part sans le mot de confirmation');
      await dialog.getByRole('textbox').fill('supprimer');
      await send.click();
      await dialog.getByRole('textbox', { name: 'Code reçu par e-mail' }).fill(DELETION_CODE);
      await dialog.getByRole('button', { name: 'Supprimer définitivement' }).click();
      await p.getByText('Votre compte et vos données ont été supprimés.', { exact: false }).waitFor({ timeout: 15_000 });
      check(requests.length === 2 && requests[0].action === 'request-code' && requests[1].action === 'confirm', `appels inattendus : ${JSON.stringify(requests)}`);
      check(requests.every((request) => request.authorization === 'Bearer fake-jwt'), 'appel sans JWT');
      // Rechargement automatique (4 s) : retour à l'écran de connexion, rien du compte sur l'appareil.
      await p.getByPlaceholder('Saisissez votre e-mail').waitFor({ timeout: 30_000 });
      const local = await p.evaluate(async () => {
        const databases = (await indexedDB.databases?.()) ?? [];
        // Une base rouverte vide au démarrage ne compte pas : seuls des projets restés en seraient une fuite.
        const projectRows = await new Promise<number>((resolve) => {
          if (!databases.some((db) => db.name === 'redview_storage_v1')) return resolve(0);
          const request = indexedDB.open('redview_storage_v1');
          request.onerror = () => resolve(0);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('projects')) { db.close(); return resolve(0); }
            const count = db.transaction('projects').objectStore('projects').count();
            count.onsuccess = () => { db.close(); resolve(count.result); };
            count.onerror = () => { db.close(); resolve(0); };
          };
        });
        return {
          projectRows,
          collab: databases.some((db) => db.name === 'redview-collab'),
          // Réglages d'affichage de l'appareil (langue, thème) : gardés exprès, comme à la déconnexion (profile.ts).
          keys: Object.keys(localStorage).filter((key) => key.startsWith('redview:') && key !== 'redview:project-browser-settings:v1'
            && /project|folder|session|routing|billing|subscription/i.test(key)),
          session: (localStorage.getItem('cookieFallback') ?? '').includes('a_session'),
        };
      });
      check(local.projectRows === 0, `${local.projectRows} projet(s) resté(s) dans la copie locale`);
      check(!local.collab, 'lots de co-édition restés sur l’appareil');
      check(local.keys.length === 0, `clés locales du compte restées : ${local.keys.join(', ')}`);
      check(!local.session, 'session Appwrite restée dans le stockage local');
      return 'code demandé puis confirmé, appareil nettoyé, écran de connexion';
    });

    await step('mesure d’audience', async () => {
      const sent = telemetry.analytics;
      analyticsSent = sent;
      const screens = sent.filter((s) => s.type === 'event' && !s.payload.name).map((s) => String(s.payload.url));
      const events = sent.filter((s) => s.type === 'event' && s.payload.name);
      const names = events.map((s) => String(s.payload.name));
      const firstIndex = (url: string) => screens.indexOf(url);
      check(firstIndex('/connexion') >= 0 && firstIndex('/projets') > firstIndex('/connexion') && firstIndex('/editeur-3d') > firstIndex('/projets'),
        `écrans attendus /connexion → /projets → /editeur-3d, reçus : ${[...new Set(screens)].join(', ') || 'aucun'}`);
      // Noms en français courant (labels.ts) : ce que l'équipe lit dans Umami.
      for (const expected of ['login_completed', 'project_created', 'gpx_imported', 'route_exported', 'account_data_exported', 'account_deleted'] as const) {
        check(names.includes(EVENT_LABELS[expected]), `événement « ${EVENT_LABELS[expected]} » absent (reçus : ${[...new Set(names)].join(', ')})`);
      }
      const exported = events.find((s) => s.payload.name === EVENT_LABELS.route_exported)?.payload.data as Record<string, unknown> | undefined;
      check(exported?.format === 'GPX' && exported?.espace === 'Application' && typeof exported?.formule === 'string',
        `export GPS sans format ni contexte lisibles : ${JSON.stringify(exported)}`);
      check(sent.every((s) => typeof s.payload.tag === 'string' && String(s.payload.tag).length > 0), 'envoi sans tag de release');
      check(sent.every((s) => /^\/[a-z0-9/-]*(\?|$)/.test(String(s.payload.url ?? ''))), `URL hors écrans : ${sent.map((s) => s.payload.url).find((u) => !/^\/[a-z0-9/-]*(\?|$)/.test(String(u ?? '')))}`);
      check(!sent.some((s) => s.type === 'identify'), 'identify envoyé');
      const all = JSON.stringify(sent);
      for (const forbidden of ['bench@redview.test', '@', PROJECT_NAME, ITINERARY_NAME, '/project/', 'boucle-e2e']) {
        check(!all.includes(forbidden), `donnée personnelle dans la mesure : « ${forbidden} »`);
      }
      check(!/[0-9a-f]{20}/i.test(all.replace(/"tag":"[^"]*"/g, '')), 'identifiant (20 caractères hexadécimaux) dans la mesure');
      return `${sent.length} envois, ${[...new Set(screens)].length} écrans, ${new Set(names).size} sortes d’événements`;
    });

    await step('accessibilité (axe, WCAG A/AA)', async () => {
      const elements = a11yFindings.reduce((sum, finding) => sum + finding.targets.length, 0);
      const summary = `${a11yScreens.length} écrans, ${a11yFindings.length} règle(s) en défaut, ${elements} élément(s)`;
      if (UPDATE_A11Y_BASELINE) {
        fs.writeFileSync(A11Y_BASELINE, `${JSON.stringify(buildBaseline(a11yFindings), null, 2)}\n`);
        return `${summary} — référence réécrite`;
      }
      const { regressions, stale } = compareWithBaseline(a11yFindings, readBaseline(A11Y_BASELINE), a11yScreens);
      check(regressions.length === 0, `défauts d'accessibilité nouveaux :\n  ${regressions.join('\n  ')}`);
      check(stale.length === 0, `défauts corrigés, la référence doit redescendre (--update-a11y-baseline) :\n  ${stale.join('\n  ')}`);
      return summary;
    });

    await step('contrôles globaux', async () => {
      check(pageErrors.length === 0, `erreurs de page : ${pageErrors.slice(0, 5).join(' | ')}`);
      check(appwrite.state.unhandled.length === 0, `appels Appwrite non simulés : ${appwrite.state.unhandled.slice(0, 5).join(', ')}`);
      check(telemetry.cspReports.length === 0, `violations CSP : ${telemetry.cspReports.slice(0, 5).join(' | ')}`);
      check(telemetry.errors.length === 0, `erreurs envoyées à GlitchTip : ${telemetry.errors.slice(0, 5).join(' | ')}`);
      return `${appwrite.state.calls.length} appels Appwrite simulés`;
    });
  } catch (error) {
    failed = true;
    if (page) await page.screenshot({ path: path.join(REPORT_DIR, 'failure.png') }).catch(() => undefined);
    if (pageErrors.length) console.log(['erreurs de page :', ...pageErrors.slice(0, 10)].join('\n  '));
    if (consoleErrors.length) console.log(['console (erreurs) :', ...consoleErrors.slice(-10)].join('\n  '));
    if (!(error instanceof CheckError)) console.error(error);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await server.stop();
    if (!argv.includes('--keep')) fs.rmSync(workDir, { recursive: true, force: true });
  }

  const report = { date: new Date().toISOString(), channel: CHANNEL, ok: !failed, steps: results, analytics: analyticsSent, a11y: a11yFindings };
  fs.writeFileSync(path.join(REPORT_DIR, `user-journey-${report.date.replace(/[:.]/g, '-')}.json`), JSON.stringify(report, null, 2));
  console.log(failed ? `\nParcours en échec (capture : ${path.relative(REPO, path.join(REPORT_DIR, 'failure.png'))})` : '\nParcours principal : OK');
  process.exitCode = failed ? 1 : 0;
}

await main();
