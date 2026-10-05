// E2E co-édition EN PRODUCTION (https://app.redview.tech) avec deux vrais
// comptes (scripts/collab-test-accounts.mjs) dans deux contextes de navigation
// isolés : invitation par e-mail, « Partagés avec moi », pastilles, synchro,
// seul l'auteur route, annuler par utilisateur, latence mesurée, rechargement
// (modification faite pendant la connexion, onglet fermé avant l'état du
// serveur puis rouvert), redéploiement du serveur temps réel en pleine
// édition, persistance Appwrite, mesures du serveur (port interne, par SSH),
// départ d'un éditeur ; le projet de test est supprimé à la fin.
//
//   node --env-file=.env script-test-bench/collab-e2e/prod-two-accounts.mjs [--skip-redeploy]
//
// Le redéploiement passe par SSH (même méthode que scripts/deploy.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { Client, Databases, Query, Storage, Teams } from 'node-appwrite';

import { connect, launch, sleep, waitFor } from '../screen-audit/cdp.mjs';
import { armSlowWelcome, SLOW_WELCOME_SCRIPT } from './slowWelcome.mjs';
import { DENIAL_CODES, READ_SOCKET_LOG, SOCKET_LOG_SCRIPT } from './socketLog.mjs';

const APP = process.env.RV_APP_URL ?? 'https://app.redview.tech';
const PORT = 9381;
const MULTIPLAYER_APP_UUID = 'krejrvgvs2w5kmfo27rutffz';
const SSH = ['-i', path.join(os.homedir(), '.ssh', 'oracle_brouter.key'), '-o', 'ConnectTimeout=15', 'opc@141.145.220.99'];
const accounts = JSON.parse(readFileSync(path.join(os.homedir(), '.redview', 'collab-test-accounts.json'), 'utf8'));
const skipRedeploy = process.argv.includes('--skip-redeploy');

const admin = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const DB = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const databases = new Databases(admin);
const storage = new Storage(admin);
const teams = new Teams(admin);

const out = { steps: {}, metrics: {}, errors: { A: [], B: [] }, brouter: { A: [], B: [] }, sockets: { A: [], B: [] } };
const failures = [];
const check = (condition, label) => {
  out.steps[label] = condition ? 'ok' : 'FAILED';
  if (!condition) failures.push(label);
  console.error(`${condition ? '✅' : '❌'} ${label}`);
};
const note = (label, value) => {
  out.metrics[label] = value;
  console.error(`   ${label} : ${typeof value === 'string' ? value : JSON.stringify(value)}`);
};

const STORE_HELPER = `(() => {
  window.__rvStore = () => {
    const el = document.querySelector('.mapboxgl-map');
    const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    for (let f = key ? el[key] : null; f; f = f.return) {
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && typeof v.setProject === 'function' && v.project && 'derivedComputeGate' in v) return v;
    }
    return null;
  };
})()`;
const store = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;
/** Session temps réel en ligne (état du serveur reçu) : attribut de l'en-tête du panneau. */
const SESSION_ONLINE = `!!document.querySelector('[data-rv-collab-status="online"]')`;
const SESSION_STATUS = `document.querySelector('[data-rv-collab-status]')?.dataset.rvCollabStatus ?? 'aucun'`;
const EDITOR_READY = `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.()`;
/** Rechargement réel (et non l'ancienne page, encore là juste après la commande). */
async function reloadPage(page) {
  await page.evaluate(`window.__rvBeforeReload = true`);
  await page.send('Page.reload', {});
  await waitFor(page, `!window.__rvBeforeReload`, { timeout: 60_000 });
}
const click = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;
const clickButton = (pattern) => `(() => { const b = [...document.querySelectorAll('button')].find((x) => ${pattern}.test(x.textContent || x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true; })()`;
const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
const IGNORED_CONSOLE = /Stripe|sprite|SW %c|umami|analytics|Download the React DevTools|favicon|ERR_BLOCKED_BY_CLIENT/;

async function newPage(browser, name) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', {});
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const page = await connect(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STORE_HELPER });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SOCKET_LOG_SCRIPT });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_WELCOME_SCRIPT });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  page.on('Page.javascriptDialogOpening', () => void page.send('Page.handleJavaScriptDialog', { accept: true }));
  page.on('Network.requestWillBeSent', (p) => {
    if (new URL(p.request.url).pathname.startsWith('/api/brouter')) out.brouter[name].push(`${Date.now()} ${p.request.method}`);
  });
  page.on('Network.webSocketCreated', (p) => {
    if (new URL(p.url).pathname.startsWith('/multiplayer')) out.sockets[name].push(`${Date.now()} ${p.url}`);
  });
  page.on('Runtime.exceptionThrown', (p) => out.errors[name].push(`exception: ${(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').split('\n')[0]}`));
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return;
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (!IGNORED_CONSOLE.test(text)) out.errors[name].push(`console.error: ${text.slice(0, 300)}`);
  });
  page.on('Network.loadingFailed', (p) => {
    if (p.canceled || /ERR_ABORTED|ERR_BLOCKED/.test(p.errorText)) return;
    out.errors[name].push(`requête en échec : ${p.errorText}`);
  });
  page.on('Network.responseReceived', (p) => {
    const { status, url } = p.response;
    if (status >= 400 && !/favicon|umami|analytics/.test(url)) out.errors[name].push(`HTTP ${status} ${url.split('?')[0].slice(0, 140)}`);
  });
  return page;
}

const projectsVisible = `[...document.querySelectorAll('button')].some((b) => /Créer un projet|Create a project/.test(b.textContent))`;

async function login(page, account) {
  await page.send('Page.navigate', { url: APP });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitFor(page, `!!document.querySelector('input[type=email]') || ${projectsVisible}`, { timeout: 90_000 });
    if (await page.evaluate(projectsVisible)) return;
    await page.evaluate(setInput('input[type=email]', account.email));
    await page.evaluate(setInput('input[type=password]', account.password));
    await sleep(200);
    await page.evaluate(click('.rv-login-submit-btn'));
    try {
      await waitFor(page, projectsVisible, { timeout: 30_000 });
      return;
    } catch {
      // Rechargement par le Service Worker au premier passage : on recommence.
    }
  }
  throw new Error(`connexion impossible pour ${account.email}`);
}

const ssh = (command, input) => execFileSync('ssh', [...SSH, command], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

function redeployMultiplayer() {
  const php = `<?php
require 'vendor/autoload.php';
$app = require_once 'bootstrap/app.php';
$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
$a = App\\Models\\Application::where('uuid', '${MULTIPLAYER_APP_UUID}')->firstOrFail();
echo json_encode(queue_application_deployment(application: $a, deployment_uuid: (string) Illuminate\\Support\\Str::uuid()));`;
  const res = JSON.parse(ssh('sudo docker exec -i coolify php', php));
  return res.deployment_uuid;
}

function deploymentStatus(uuid) {
  if (!/^[0-9a-f-]{36}$/.test(uuid)) return 'invalid';
  return ssh(`echo "SELECT status FROM application_deployment_queues WHERE deployment_uuid = '${uuid}';" | sudo docker exec -i coolify-db psql -U coolify -d coolify -t -A`);
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function readHealth() {
  const res = await fetch(`${APP}/multiplayer/health`, { cache: 'no-store' });
  return res.json();
}

/** Journal du serveur temps réel (conteneur courant) depuis `since`, sans le bruit du SDK. */
function readServerLogs(since) {
  const container = `$(sudo docker ps -q -f name=${MULTIPLAYER_APP_UUID} | head -n1)`;
  return ssh(`sudo docker logs --since ${since} ${container} 2>&1 | grep -v 'SDK is built for Appwrite' | tail -n 200`)
    .split('\n').filter(Boolean);
}

/** Mesures du serveur temps réel : port interne du conteneur, jamais public (lu par SSH). */
function readServerMetrics() {
  const container = `$(sudo docker ps -q -f name=${MULTIPLAYER_APP_UUID} | head -n1)`;
  return JSON.parse(ssh(`sudo docker exec ${container} wget -qO- http://127.0.0.1:17791/metrics.json`));
}

async function deleteProject(projectId, errors) {
  const attempt = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      if (error?.code !== 404) errors.push(`${projectId} ${label}: ${error?.message ?? error}`);
    }
  };
  await attempt('journal', async () => {
    const rows = await databases.listDocuments(DB, 'project_journal', [Query.equal('project_id', projectId), Query.limit(100)]);
    for (const row of rows.documents) await databases.deleteDocument(DB, 'project_journal', row.$id);
  });
  await attempt('vues', async () => {
    const rows = await databases.listDocuments(DB, 'project_views', [Query.equal('project_id', projectId), Query.limit(100)]);
    for (const row of rows.documents) await databases.deleteDocument(DB, 'project_views', row.$id);
  });
  await attempt('fichiers', async () => {
    for (const name of [`${projectId}.collab.gz`, `${projectId}.json.gz`]) {
      const list = await storage.listFiles('project-payloads', [Query.equal('name', name), Query.limit(100)]);
      for (const file of list.files) await storage.deleteFile('project-payloads', file.$id);
    }
  });
  await attempt('miniature', () => storage.deleteFile('project-thumbnails', projectId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 36)));
  await attempt('équipe', () => teams.delete(`p${projectId}`));
  await attempt('projet', () => databases.deleteDocument(DB, 'projects', projectId));
}

/** Projets des comptes de test (ids). */
async function testAccountProjects() {
  const ids = [];
  for (const account of [accounts.A, accounts.B]) {
    const rows = await databases.listDocuments(DB, 'projects', [Query.equal('user_id', account.userId), Query.select(['$id']), Query.limit(100)]);
    ids.push(...rows.documents.map((doc) => doc.$id));
  }
  return ids;
}

/** Supprime tous les projets des comptes de test (restes d'une passe interrompue compris). */
async function cleanupTestAccounts() {
  const errors = [];
  for (const id of await testAccountProjects()) await deleteProject(id, errors);
  return errors.length > 0 ? errors : 'ok';
}

/** Attente dans la page, bornée (une synchro manquée ne bloque jamais la passe). */
const waitInPage = (expression, timeoutMs = 10_000) => `new Promise((resolve) => {
  const start = Date.now();
  const tick = () => {
    let value = null;
    try { value = (${expression}); } catch { value = null; }
    if (value) resolve(Date.now());
    else if (Date.now() - start > ${timeoutMs}) resolve(null);
    else setTimeout(tick, 4);
  };
  tick();
})`;

const { session: firstTab, close } = await launch({ port: PORT });
let projectId = null;
const benchStart = new Date().toISOString();
/** Pages ouvertes (diagnostic final, même après une erreur). */
const pages = {};
out.diagnostics = { socketLog: {}, serverLogs: {} };
out.cleanupBefore = await cleanupTestAccounts();
try {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl);
  const A = await newPage(browser, 'A');
  const B = await newPage(browser, 'B');
  Object.assign(pages, { A, B });
  void firstTab;

  const health = await readHealth();
  check(health.ok === true, 'serveur temps réel en ligne (/multiplayer/health)');
  check(Object.keys(health).join() === 'ok', `santé publique minimale (${JSON.stringify(health)})`);
  const publicMetrics = await fetch(`${APP}/multiplayer/metrics`, { cache: 'no-store' });
  check(publicMetrics.status === 404, `mesures fermées au public (/multiplayer/metrics → ${publicMetrics.status})`);

  // ── Connexion des deux comptes ──────────────────────────────────────────
  await Promise.all([login(A, accounts.A), login(B, accounts.B)]);
  check(true, 'connexion des deux comptes de test');

  // ── A crée un projet et trace un itinéraire ────────────────────────────
  await A.evaluate(clickButton('/Créer un projet|Create a project/'));
  await waitFor(A, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.()`, { timeout: 120_000 });
  await sleep(1500);
  projectId = (await A.evaluate('location.pathname')).split('--').pop();
  note('projet', projectId);
  const projectName = `Test co-édition ${new Date().toISOString().slice(0, 16)}`;
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, name: ${JSON.stringify(projectName)} })), 0)`));
  const itineraryId = await A.evaluate(store('s.addItinerary()'));
  await sleep(500);
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => it.id !== ${JSON.stringify(itineraryId)} ? it : {
    ...it,
    timeline: it.timeline.map((row) => row.kind === 'start' ? { ...row, label: 'Chamonix', lat: 45.9237, lon: 6.8694 }
      : row.kind === 'end' ? { ...row, label: 'Argentière', lat: 45.9822, lon: 6.9277 } : row),
  }) })), 0)`));
  await waitFor(A, store('(s.project.itineraries[0]?.gpxRoute?.points?.length ?? 0) > 10'), { timeout: 90_000 });
  check(true, 'A : projet créé et itinéraire routé');
  await sleep(2500);

  // ── A partage avec B (bouton « Partager » de l'en-tête) ─────────────────
  await waitFor(A, `!!document.querySelector('.rvi-header__share')`, { timeout: 30_000 });
  await A.evaluate(click('.rvi-header__share'));
  await waitFor(A, `!!document.querySelector('.rv-share-dialog__input')`, { timeout: 15_000 });
  await A.evaluate(setInput('.rv-share-dialog__input', accounts.B.email));
  await sleep(200);
  const inviteStart = Date.now();
  await A.evaluate(click('.rv-share-dialog__invite button[type=submit]'));
  await waitFor(A, `[...document.querySelectorAll('.rv-share-dialog__person-email, .rv-share-dialog__person-name')].some((e) => e.textContent.includes(${JSON.stringify(accounts.B.email)}) || e.textContent.includes(${JSON.stringify(accounts.B.name)}))`, { timeout: 30_000 });
  note('invitation (ms)', Date.now() - inviteStart);
  check(true, 'A invite B par e-mail : B apparaît dans « Personnes ayant accès »');
  await A.evaluate(clickButton('/^Terminé$|^Done$/'));
  await waitFor(A, SESSION_ONLINE, { timeout: 30_000 });
  check(out.sockets.A.length > 0, 'A passe en session temps réel après la première invitation');

  // ── B ouvre le projet depuis « Partagés avec moi » ───────────────────────
  await B.send('Page.reload', {});
  await waitFor(B, projectsVisible, { timeout: 90_000 });
  await waitFor(B, `[...document.querySelectorAll('.rvpb-shared-section-title')].length > 0`, { timeout: 30_000 });
  check(true, 'B : section « Partagés avec moi » affichée');
  const openStart = Date.now();
  const opened = await B.evaluate(`(() => { const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label').includes(${JSON.stringify(projectName)})); if (!b) return false; b.click(); return true; })()`);
  check(opened, 'B : carte du projet partagé trouvée');
  await waitFor(B, `${EDITOR_READY} && ${SESSION_ONLINE}`, { timeout: 120_000 });
  note('ouverture du projet partagé par B (ms)', Date.now() - openStart);
  await waitFor(B, store('(s.project.itineraries[0]?.gpxRoute?.points?.length ?? 0) > 10'), { timeout: 30_000 });
  check(out.brouter.B.length === 0, `B à l'ouverture : aucun appel BRouter (${out.brouter.B.length})`);
  check(await B.evaluate(store(`s.project.name === ${JSON.stringify(projectName)}`)), 'B voit le projet de A (nom, itinéraire, tracé)');

  // ── Présence : pastilles des deux éditeurs ───────────────────────────────
  const avatars = `document.querySelectorAll('.rvi-header__people-full .rv-avatar').length`;
  await waitFor(A, `${avatars} >= 2`, { timeout: 15_000 }).catch(() => null);
  check((await A.evaluate(avatars)) >= 2 && (await B.evaluate(avatars)) >= 2, 'en-tête : pastilles des deux éditeurs chez A et chez B');

  // ── Latence de synchronisation A → B (10 renommages) ────────────────────
  const latencies = [];
  for (let index = 0; index < 10; index += 1) {
    const name = `lat-${index}-${Date.now()}`;
    const seen = B.evaluate(waitInPage(`window.__rvStore()?.project.itineraries[0].name === ${JSON.stringify(name)}`));
    const sentAt = await A.evaluate(`(() => { const s = window.__rvStore(); s.setItineraryName(${JSON.stringify(itineraryId)}, ${JSON.stringify(name)}); return Date.now(); })()`);
    const seenAt = await seen;
    if (seenAt === null) {
      check(false, `latence : renommage ${index} jamais reçu par B`);
      break;
    }
    latencies.push(seenAt - sentAt);
    await sleep(150);
  }
  if (latencies.length > 0) {
    note('latence A → B (ms)', { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) });
    check(latencies.length === 10 && percentile(latencies, 0.95) < 500, `latence de synchronisation p95 < 500 ms (${percentile(latencies, 0.95)} ms)`);
  }

  // ── Vue propre à chacun ─────────────────────────────────────────────────
  const modeB = await B.evaluate(store('s.project.activeMode'));
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, activeMode: 'poi' })), 0)`));
  await sleep(1500);
  check((await B.evaluate(store('s.project.activeMode'))) === modeB, 'vue : le mode de A ne change pas celui de B');

  // ── Seul l'auteur route ─────────────────────────────────────────────────
  const brouterB = out.brouter.B.length;
  const brouterA = out.brouter.A.length;
  const stampBefore = await A.evaluate(store('s.project.itineraries[0].gpxRoute.routedInputsKey'));
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => ({ ...it, timeline: it.timeline.map((row) => row.kind === 'end' ? { ...row, label: 'Le Tour', lat: 46.0024, lon: 6.9416 } : row) })) })), 0)`));
  const routeStart = Date.now();
  await waitFor(B, store(`s.project.itineraries[0].gpxRoute.routedInputsKey !== ${JSON.stringify(stampBefore)}`), { timeout: 60_000 });
  note('déplacement de A → tracé recalculé visible chez B (ms)', Date.now() - routeStart);
  await sleep(3000);
  const stampA = await A.evaluate(store('s.project.itineraries[0].gpxRoute.routedInputsKey'));
  const stampB = await B.evaluate(store('s.project.itineraries[0].gpxRoute.routedInputsKey'));
  check(out.brouter.A.length > brouterA, `A (auteur) route (${out.brouter.A.length - brouterA} appel(s))`);
  check(out.brouter.B.length === brouterB, `B ne route pas la modification de A (${out.brouter.B.length - brouterB} appel(s))`);
  check(stampA === stampB, 'B reçoit le tracé de A (même estampille)');

  // ── Annuler par utilisateur ─────────────────────────────────────────────
  await B.evaluate(store(`(s.setItineraryColor(${JSON.stringify(itineraryId)}, '#3d8bff'), 0)`));
  await waitFor(A, store(`s.project.itineraries[0].color === '#3d8bff'`), { timeout: 10_000 });
  const brouterBeforeUndo = out.brouter.A.length + out.brouter.B.length;
  await A.evaluate(store('(s.undoTraceEdit(), 0)'));
  await waitFor(B, store(`s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat === 45.9822`), { timeout: 10_000 }).catch(() => null);
  await sleep(2500);
  const undone = await B.evaluate(store(`({ end: s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat, stamp: s.project.itineraries[0].gpxRoute.routedInputsKey, color: s.project.itineraries[0].color })`));
  check(undone.end === 45.9822 && undone.stamp === stampBefore, 'A annule son déplacement : arrivée et ancien tracé reviennent chez B');
  check(undone.color === '#3d8bff', 'la couleur changée par B reste');
  check(out.brouter.A.length + out.brouter.B.length === brouterBeforeUndo, 'annuler : aucun appel BRouter');

  // ── Rechargement de A (propriétaire) en pleine session ──────────────────
  const rowBeforeReload = await databases.getDocument(DB, 'projects', projectId, [Query.select(['$id', 'collab'])]);
  const collabBeforeReload = rowBeforeReload.collab;
  // Connexion ralentie (état du serveur retardé de 6 s) : A renomme dès que l'éditeur est là.
  await A.evaluate(armSlowWelcome(6_000));
  await reloadPage(A);
  await waitFor(A, EDITOR_READY, { timeout: 120_000 });
  const statusAtEdit = await A.evaluate(SESSION_STATUS);
  const nameDuringConnect = `pendant-la-connexion-${Date.now()}`;
  const seenDuringConnect = B.evaluate(waitInPage(`window.__rvStore()?.project.itineraries[0].name === ${JSON.stringify(nameDuringConnect)}`, 30_000));
  await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, ${JSON.stringify(nameDuringConnect)}), 0)`));
  check(statusAtEdit === 'connecting', `A renomme pendant sa connexion (état de la session : ${statusAtEdit})`);
  check((await seenDuringConnect) !== null, 'modification de A faite pendant la connexion : reçue par B');
  await waitFor(A, SESSION_ONLINE, { timeout: 60_000 });
  check(await A.evaluate(store(`s.project.itineraries[0].name === ${JSON.stringify(nameDuringConnect)}`)), 'A garde sa modification une fois en ligne');
  check(true, 'A recharge : le projet rouvre en session temps réel');
  const nameAfterReload = `apres-rechargement-${Date.now()}`;
  const seenAfterReload = B.evaluate(waitInPage(`window.__rvStore()?.project.itineraries[0].name === ${JSON.stringify(nameAfterReload)}`, 15_000));
  await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, ${JSON.stringify(nameAfterReload)}), 0)`));
  check((await seenAfterReload) !== null, 'après son rechargement, les modifications de A arrivent chez B');
  const rowAfterReload = await databases.getDocument(DB, 'projects', projectId, [Query.select(['$id', 'collab', 'data'])]);
  const metaAfterReload = rowAfterReload.collab ? JSON.parse(rowAfterReload.collab) : null;
  const { createHash } = await import('node:crypto');
  check(!!metaAfterReload && createHash('sha256').update(String(rowAfterReload.data)).digest('hex') === metaAfterReload.dataHash,
    'aucune écriture cloud hors de la salle (projects.data = dernier point de sauvegarde)');
  void collabBeforeReload;
  check((await testAccountProjects()).length === 1, 'aucune copie de conflit créée (un seul projet de test)');

  // ── A ferme l'onglet avant l'état du serveur : la modification revient ──
  // État du serveur retardé de 60 s : le renommage reste en attente, gardé sur
  // l'appareil ; l'onglet est rechargé (fermé) avant ; la session suivante le
  // reprend et l'envoie.
  await A.evaluate(armSlowWelcome(60_000));
  await reloadPage(A);
  await waitFor(A, EDITOR_READY, { timeout: 120_000 });
  const nameBeforeClose = `onglet-ferme-${Date.now()}`;
  await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, ${JSON.stringify(nameBeforeClose)}), 0)`));
  await sleep(1_500);
  const seenAfterClose = B.evaluate(waitInPage(`window.__rvStore()?.project.itineraries[0].name === ${JSON.stringify(nameBeforeClose)}`, 60_000));
  check(await B.evaluate(store(`s.project.itineraries[0].name !== ${JSON.stringify(nameBeforeClose)}`)), 'onglet fermé avant l’état du serveur : rien n’est encore parti');
  await reloadPage(A);
  await waitFor(A, `${EDITOR_READY} && ${SESSION_ONLINE}`, { timeout: 120_000 });
  check((await seenAfterClose) !== null, 'modification faite avant la fermeture de l’onglet : reprise et reçue par B');

  // ── Rechargement de B : état du serveur ─────────────────────────────────
  const snapshotOf = `JSON.stringify(window.__rvStore().project.itineraries.map((it) => [it.id, it.name, it.color, it.gpxRoute?.routedInputsKey, it.timeline.length]))`;
  const beforeReload = await A.evaluate(snapshotOf);
  const brouterBeforeReload = out.brouter.B.length;
  await reloadPage(B);
  await waitFor(B, `${EDITOR_READY} && ${SESSION_ONLINE}`, { timeout: 120_000 });
  await waitFor(B, `${snapshotOf} === ${JSON.stringify(beforeReload)}`, { timeout: 15_000 }).catch(() => null);
  const afterReloadB = await B.evaluate(snapshotOf);
  const afterReloadA = await A.evaluate(snapshotOf);
  check(afterReloadB === afterReloadA, 'B recharge : même document que A');
  if (afterReloadB !== afterReloadA) note('écart après rechargement de B', { avant: beforeReload, A: afterReloadA, B: afterReloadB });
  check(out.brouter.B.length === brouterBeforeReload, 'B recharge : aucun appel BRouter');

  // ── Redéploiement du serveur temps réel en pleine édition ───────────────
  if (!skipRedeploy) {
    // Journal du conteneur qui va être remplacé (perdu sinon).
    try {
      out.diagnostics.serverLogs.beforeRedeploy = readServerLogs(benchStart);
    } catch (error) {
      out.diagnostics.serverLogs.beforeRedeploy = [`lecture impossible : ${error?.message ?? error}`];
    }
    const deployment = redeployMultiplayer();
    note('redéploiement du serveur temps réel', deployment);
    let status = 'queued';
    let lastName = null;
    const deployStart = Date.now();
    let leftEditor = null;
    for (let tick = 0; tick < 150 && !['finished', 'failed', 'cancelled'].includes(status); tick += 1) {
      // Carte rechargée (classe .mapboxgl-map absente un instant) ou A sorti de l'éditeur ?
      const editorReady = await A.evaluate(EDITOR_READY)
        || await waitFor(A, EDITOR_READY, { timeout: 15_000 }).then(() => true, () => false);
      if (!editorReady) {
        // A n'est plus dans l'éditeur : on note où il est et on poursuit sans lui.
        leftEditor = await A.evaluate(`({ tick: ${tick}, url: location.pathname, text: document.body.innerText.slice(0, 200) })`);
        break;
      }
      lastName = `pendant-redeploiement-${tick}`;
      await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, ${JSON.stringify(lastName)}), 0)`));
      await sleep(2000);
      if (tick % 3 === 0) status = deploymentStatus(deployment);
    }
    if (leftEditor) note('A hors de l’éditeur pendant le redéploiement', leftEditor);
    check(!leftEditor, 'A reste dans l’éditeur pendant le redéploiement');
    for (let wait = 0; wait < 60 && !['finished', 'failed', 'cancelled'].includes(status); wait += 1) {
      await sleep(3000);
      status = deploymentStatus(deployment);
    }
    note('redéploiement : statut / durée (s)', `${status} / ${Math.round((Date.now() - deployStart) / 1000)}`);
    check(status === 'finished', 'redéploiement du serveur temps réel terminé');
    await waitFor(B, store(`s.project.itineraries[0].name === ${JSON.stringify(lastName)}`), { timeout: 60_000 }).catch(() => null);
    await sleep(3000);
    const [afterA, afterB] = [await A.evaluate(snapshotOf), await B.evaluate(snapshotOf)];
    check(afterA === afterB, 'après le redéploiement : A et B convergent');
    check(afterB.includes(lastName), `la dernière modification de A pendant le redéploiement est chez B (${lastName})`);
  }

  // ── Persistance dans Appwrite (point de sauvegarde + journal) ───────────
  await sleep(2000);
  const row = await databases.getDocument(DB, 'projects', projectId);
  const meta = row.collab ? JSON.parse(row.collab) : null;
  check(!!meta && Number.isInteger(meta.seq), `projects.collab écrit par le serveur (séquence ${meta?.seq ?? '—'})`);
  const raw = String(row.data);
  const stored = raw.startsWith('gz:') ? JSON.parse(gunzipSync(Buffer.from(raw.slice(3), 'base64')).toString('utf8')) : raw.startsWith('file:') ? null : JSON.parse(raw);
  check(stored?.schema === 2 && stored.itineraries?.length >= 1, 'projects.data : document lisible par l’application (schéma 2)');
  const journal = await databases.listDocuments(DB, 'project_journal', [Query.equal('project_id', projectId), Query.limit(100)]);
  note('journal (paquets au-delà du point de sauvegarde)', journal.total);
  const metrics = readServerMetrics();
  note('serveur temps réel', {
    rooms: metrics.rooms,
    journalP50: metrics.journal_latency_p50_ms,
    journalP95: metrics.journal_latency_p95_ms,
    checkpointP95: metrics.checkpoint_p95_ms,
    journalErrors: metrics.journalErrors,
    checkpointErrors: metrics.checkpointErrors,
    shadowChecks: metrics.shadowChecks,
    shadowMismatches: metrics.shadowMismatches,
    fenced: metrics.fenced,
    eventLoopP99: metrics.event_loop_delay_p99_ms,
    heapMb: Math.round(metrics.heap_used_bytes / 1e6),
  });
  check(metrics.journalErrors === 0 && metrics.checkpointErrors === 0, 'serveur : aucune erreur de journal ni de point de sauvegarde');
  check(metrics.shadowMismatches === 0, `validation fantôme : aucun écart (${metrics.shadowChecks} contrôle(s))`);
  check((metrics.journal_latency_p95_ms ?? 0) < 600, `journal durable p95 < 600 ms (${metrics.journal_latency_p95_ms} ms)`);

  // ── B quitte le projet ──────────────────────────────────────────────────
  await B.evaluate(click('.rvi-header__share'));
  await waitFor(B, `!!document.querySelector('.rv-share-dialog__leave')`, { timeout: 15_000 });
  await B.evaluate(click('.rv-share-dialog__leave'));
  await waitFor(B, `${projectsVisible} && !document.querySelector('.mapboxgl-canvas')`, { timeout: 30_000 }).catch(() => null);
  const memberships = await teams.listMemberships(`p${projectId}`, [Query.limit(100)]);
  check(!memberships.memberships.some((membership) => membership.userId === accounts.B.userId), 'B a quitté le projet (retiré de l’équipe)');
  // ── Erreurs réseau / console : seules celles attendues sont tolérées ─────
  const EXPECTED = [
    /^HTTP 401 https:\/\/appwrite\.redview\.tech\/v1\/account(\/sessions\/current)?$/, // avant la connexion
    /^HTTP 404 https:\/\/appwrite\.redview\.tech\/v1\/databases\/[^/]+\/collections\/project_views\/documents\/[^/]+$/, // vue pas encore enregistrée
    /^HTTP 404 https:\/\/appwrite\.redview\.tech\/v1\/storage\/buckets\/project-thumbnails\/files\/[^/]+$/, // miniature pas encore créée
    /^HTTP 502 https:\/\/app\.redview\.tech\/multiplayer\/health$/, // conteneur remplacé pendant le redéploiement
  ];
  for (const name of ['A', 'B']) {
    const unexpected = out.errors[name].filter((entry) => !EXPECTED.some((pattern) => pattern.test(entry)));
    if (unexpected.length > 0) note(`erreurs inattendues ${name}`, unexpected.slice(0, 10));
    check(unexpected.length === 0, `${name} : aucune erreur inattendue (réseau, console, exceptions)`);
  }
  // Jamais renvoyé hors du projet (accès retiré, projet introuvable, version) pendant la passe.
  for (const name of ['A', 'B']) {
    const log = await pages[name].evaluate(READ_SOCKET_LOG).catch(() => []);
    const denials = log.filter((entry) => entry.event === 'close' && DENIAL_CODES.has(entry.code));
    check(denials.length === 0, `${name} : aucun refus du serveur temps réel (${denials.map((entry) => `${entry.code} ${entry.reason}`).join(', ') || 'aucun'})`);
  }
} catch (error) {
  out.fatal = String(error?.stack ?? error);
  console.error(`❌ ${out.fatal}`);
} finally {
  // Diagnostic avant le nettoyage (qui supprime le projet) : connexions de chaque page, journal du serveur.
  for (const [name, page] of Object.entries(pages)) {
    out.diagnostics.socketLog[name] = await page.evaluate(READ_SOCKET_LOG).catch((error) => [`illisible : ${error?.message ?? error}`]);
    const unusual = (out.diagnostics.socketLog[name] ?? []).filter((entry) => entry.event === 'toast' || entry.event === 'error'
      || (entry.event === 'close' && ![1000, 1005, 1012].includes(entry.code)));
    if (unusual.length > 0) console.error(`   ${name} — connexions : ${unusual.map((entry) => `${entry.at.slice(11, 23)} ${entry.event} ${entry.code ?? ''} ${entry.reason ?? entry.text ?? ''}`).join(' | ')}`);
  }
  try {
    out.diagnostics.serverLogs.end = readServerLogs(benchStart);
  } catch (error) {
    out.diagnostics.serverLogs.end = [`lecture impossible : ${error?.message ?? error}`];
  }
  const serverWarnings = [...(out.diagnostics.serverLogs.beforeRedeploy ?? []), ...out.diagnostics.serverLogs.end]
    .filter((line) => /"level":"(warn|error)"/.test(line));
  if (serverWarnings.length > 0) console.error(`   serveur — avertissements et erreurs :\n     ${serverWarnings.slice(0, 20).join('\n     ')}`);
  out.cleanup = await cleanupTestAccounts();
  await close();
}
out.failures = failures;
console.log(JSON.stringify(out, null, 2));
process.exitCode = failures.length > 0 || out.fatal ? 1 : 0;
