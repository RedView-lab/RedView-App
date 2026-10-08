// Calibrage du banc de charge du VPS : un vrai Edge sans interface fait le
// parcours d'un utilisateur EN PRODUCTION avec le compte sonde loadtest-000
// (accounts.ts) et enregistre chaque requête vers le VPS (app.redview.tech,
// appwrite.redview.tech), celles du Service Worker comprises : méthode,
// chemin, statut, octets envoyés / reçus, durée. Le modèle des utilisateurs
// virtuels (vu.ts) rejoue ces séquences ; ce relevé est sa référence.
//
//   node --env-file=.env script-test-bench/vps-load/calibrate.mjs
//
// Sorties (reports/, ignoré par git) : reports/vps-load/calibration-<date>.json
// (requêtes par étape) et reports/vps-load/fixtures/project-*.json (le champ
// `data` brut des projets créés : documents produits par l'app elle-même,
// réutilisés comme projets des comptes virtuels). Le projet de test reste sur
// le compte sonde : `accounts.ts teardown` purge tout.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, Databases, Query } from 'node-appwrite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'script-test-bench', 'reports', 'vps-load');
const APP = process.env.RV_APP_URL ?? 'https://app.redview.tech';
const VPS_HOSTS = new Set(['app.redview.tech', 'appwrite.redview.tech']);
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9391;

const store = JSON.parse(readFileSync(path.join(os.homedir(), '.redview', 'load-test-accounts.json'), 'utf8'));
const probe = store['loadtest-000@redview.tech'];
if (!probe) throw new Error('compte sonde absent : accounts.ts ensure --count 1');

const admin = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const DB = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const databases = new Databases(admin);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── CDP avec sessions aplaties (pour suivre aussi le Service Worker) ─────────
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg.method, msg.params, msg.sessionId);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, onEvent: (fn) => listeners.push(fn), close: () => ws.close() };
}

const userDir = mkdtempSync(path.join(os.tmpdir(), 'rv-vps-load-calib-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });
let version;
for (let attempt = 0; attempt < 100 && !version; attempt += 1) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    await sleep(150);
  }
}
if (!version) throw new Error('Edge ne démarre pas');
const cdp = await cdpConnect(version.webSocketDebuggerUrl);

// ── Journal des requêtes, découpé en étapes ─────────────────────────────────
let segment = 'boot';
const requests = new Map();
const done = [];
const pageErrors = [];
cdp.onEvent((method, params, sessionId) => {
  if (method === 'Target.attachedToTarget') {
    const child = params.sessionId;
    void cdp.send('Network.enable', { maxPostDataSize: 64 * 1024 * 1024 }, child).catch(() => undefined);
    void cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => undefined);
    return;
  }
  const key = `${sessionId}:${params?.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    let url;
    try {
      url = new URL(params.request.url);
    } catch {
      return;
    }
    if (!VPS_HOSTS.has(url.host)) return;
    requests.set(key, {
      segment,
      t: Date.now(),
      start: params.timestamp,
      method: params.request.method,
      host: url.host,
      path: url.pathname,
      query: url.search.slice(0, 400),
      reqBytes: params.request.postData?.length ?? (params.request.hasPostData ? -1 : 0),
      body: params.request.postData && params.request.postData.length < 4000 ? params.request.postData : undefined,
      type: params.type,
      sw: sessionId !== pageSession,
    });
  } else if (method === 'Network.responseReceived') {
    const entry = requests.get(key);
    if (!entry) return;
    entry.status = params.response.status;
    entry.fromCache = params.response.fromDiskCache || params.response.fromServiceWorker || params.response.fromPrefetchCache;
    entry.ttfbMs = Math.round((params.timestamp - entry.start) * 1000);
    entry.encoding = params.response.headers?.['content-encoding'] ?? params.response.headers?.['Content-Encoding'];
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    const entry = requests.get(key);
    if (!entry) return;
    requests.delete(key);
    entry.ms = Math.round((params.timestamp - entry.start) * 1000);
    entry.respBytes = params.encodedDataLength ?? 0;
    if (method === 'Network.loadingFailed') entry.failed = params.errorText;
    done.push(entry);
  } else if (method === 'Runtime.exceptionThrown' && sessionId === pageSession) {
    pageErrors.push((params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? '').split('\n')[0]);
  }
});

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
const page = {
  send: (method, params) => cdp.send(method, params, pageSession),
  async evaluate(expression) {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, pageSession);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  },
};
await page.send('Page.enable');
await page.send('Runtime.enable');
// Corps d'envoi jusqu'à 64 Mio : au-delà de maxPostDataSize, Chrome omet postData (sauvegardes de projet).
await page.send('Network.enable', { maxPostDataSize: 64 * 1024 * 1024 });
await page.send('Network.setCacheDisabled', { cacheDisabled: false });
await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await cdp.send('Target.setDiscoverTargets', { discover: true });
// Le Service Worker est une autre cible : rattachée au niveau du navigateur.
cdp.onEvent((method, params) => {
  if (method === 'Target.targetCreated' && params.targetInfo.type === 'service_worker') {
    void cdp.send('Target.attachToTarget', { targetId: params.targetInfo.targetId, flatten: true }).catch(() => undefined);
  }
});
await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const isStore = (v) => v && typeof v.setProject === 'function' && v.project && 'derivedComputeGate' in v;
  const fromElement = (el) => {
    const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    if (!key) return null;
    for (const start of [el[key], el[key].alternate]) {
      for (let f = start; f; f = f.return) {
        const v = f.memoizedProps && f.memoizedProps.value;
        if (isStore(v)) return v;
      }
    }
    return null;
  };
  window.__rvStore = () => {
    for (const selector of ['.rvi-header', '[data-rv-region="left-panel"]', '.mapboxgl-map']) {
      for (const el of document.querySelectorAll(selector)) {
        const s = fromElement(el);
        if (s) return s;
      }
    }
    return null;
  };
})()` });

async function waitFor(expression, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await page.evaluate(expression);
      if (value) return value;
    } catch {
      /* navigation en cours */
    }
    await sleep(250);
  }
  throw new Error(`délai dépassé : ${expression.slice(0, 160)}`);
}

const marks = [];
async function step(name, fn) {
  segment = name;
  const t0 = Date.now();
  await fn();
  // Les requêtes de queue (sauvegarde auto, POI…) restent dans l'étape.
  marks.push({ name, ms: Date.now() - t0 });
  console.error(`✓ ${name} (${Date.now() - t0} ms)`);
}

const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
const projectsVisible = `[...document.querySelectorAll('button')].some((b) => /Créer un projet|Create a project/.test(b.textContent))`;
const editorReady = `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.()`;
const storeEval = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;
const setEndpoints = (index, start, end) => storeEval(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it, i) => i !== ${index} ? it : {
  ...it,
  timeline: it.timeline.map((row) => row.kind === 'start' ? { ...row, label: ${JSON.stringify(start.label)}, lat: ${start.lat}, lon: ${start.lon} }
    : row.kind === 'end' ? { ...row, label: ${JSON.stringify(end.label)}, lat: ${end.lat}, lon: ${end.lon} } : row),
}) })), 0)`);
const routed = (index) => storeEval(`(s.project.itineraries[${index}]?.gpxRoute?.points?.length ?? 0) > 10 && !document.querySelector('[data-rv-routing="busy"]')`);

const createdProjects = [];
let projectId = null;
try {
  await step('premiere-visite-connexion', async () => {
    await page.send('Page.navigate', { url: APP });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitFor(`!!document.querySelector('input[type=email]') || ${projectsVisible}`, 90_000);
      if (await page.evaluate(projectsVisible)) return;
      await page.evaluate(setInput('input[type=email]', probe.email));
      await page.evaluate(setInput('input[type=password]', probe.password));
      await sleep(200);
      await page.evaluate(`document.querySelector('.rv-login-submit-btn')?.click()`);
      try {
        await waitFor(projectsVisible, 30_000);
        return;
      } catch {
        /* rechargement du Service Worker au premier passage */
      }
    }
    throw new Error('connexion impossible');
  });
  await sleep(3000);

  await step('retour-tableau-de-bord', async () => {
    await page.send('Page.reload', {});
    await sleep(500);
    await waitFor(projectsVisible, 90_000);
    await sleep(3000);
  });

  await step('creation-projet-editeur', async () => {
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => /Créer un projet|Create a project/.test(b.textContent))?.click()`);
    await waitFor(editorReady, 120_000);
    // Rechargement unique du Service Worker sur un profil neuf (map3d/hooks/useMap/serviceWorker.ts).
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await page.evaluate(`sessionStorage.getItem('redview:map-cache-auto-reload') !== null`).catch(() => false)) break;
      await sleep(250);
    }
    await waitFor(editorReady, 120_000);
    projectId = (await page.evaluate('location.pathname')).split('--').pop();
    createdProjects.push(projectId);
    await sleep(4000);
  });

  await step('trace-30km', async () => {
    const itineraryCount = await page.evaluate(storeEval('s.project.itineraries.length'));
    if (itineraryCount === 0) await page.evaluate(storeEval('s.addItinerary()'));
    await sleep(500);
    await page.evaluate(setEndpoints(0, { label: 'Annecy', lat: 45.8992, lon: 6.1294 }, { label: 'Faverges', lat: 45.7489, lon: 6.2953 }));
    await waitFor(routed(0), 120_000);
    await sleep(6000);
  });

  await step('sauvegarde-auto-edition', async () => {
    for (let index = 0; index < 5; index += 1) {
      await page.evaluate(storeEval(`(s.setProject((p) => ({ ...p, name: 'Calibrage ' + ${index} })), 0)`));
      await sleep(3000);
    }
    await sleep(6000);
  });

  await step('trace-150km', async () => {
    await page.evaluate(storeEval('s.addItinerary()'));
    await sleep(800);
    await page.evaluate(setEndpoints(1, { label: 'Grenoble', lat: 45.1885, lon: 5.7245 }, { label: 'Briançon', lat: 44.8986, lon: 6.6435 }));
    await waitFor(routed(1), 180_000);
    await sleep(8000);
  });

  for (const mode of ['rythme', 'poi', 'nutrition', 'tracage']) {
    await step(`mode-${mode}`, async () => {
      await page.evaluate(storeEval(`(s.setProject((p) => ({ ...p, activeMode: ${JSON.stringify(mode)} })), 0)`));
      await sleep(10_000);
    });
  }

  await step('trace-550km', async () => {
    await page.evaluate(storeEval('s.addItinerary()'));
    await sleep(800);
    await page.evaluate(setEndpoints(2, { label: 'Lyon', lat: 45.764, lon: 4.8357 }, { label: 'Toulouse', lat: 43.6047, lon: 1.4442 }));
    await waitFor(routed(2), 300_000);
    await sleep(10_000);
  });

  await step('reouverture-projet', async () => {
    await page.send('Page.navigate', { url: APP });
    await waitFor(projectsVisible, 90_000);
    // Bouton « Ouvrir <nom> » de la carte (ProjectCard), une fois la liste chargée.
    const openButton = `[...document.querySelectorAll('[data-rv-project-card] button[aria-label]')].find((b) => /^(Ouvrir|Open) .*Calibrage/.test(b.getAttribute('aria-label')))`;
    await waitFor(`!!${openButton}`, 60_000);
    await page.evaluate(`${openButton}.click()`);
    await waitFor(`${editorReady} && (window.__rvStore()?.project.itineraries.length ?? 0) >= 3`, 120_000);
    await sleep(8000);
  });
} catch (error) {
  console.error(`✗ étape « ${segment} » : ${error.message}`);
  process.exitCode = 1;
} finally {
  await sleep(1000);
  // Fixtures : le champ `data` brut de chaque projet créé, tel que l'app l'a écrit.
  mkdirSync(path.join(OUT_DIR, 'fixtures'), { recursive: true });
  for (const id of createdProjects) {
    try {
      const doc = await databases.getDocument(DB, 'projects', id, [Query.select(['$id', 'name', 'data', 'size_bytes'])]);
      const file = path.join(OUT_DIR, 'fixtures', `project-calibration.json`);
      writeFileSync(file, JSON.stringify({ name: doc.name, size_bytes: doc.size_bytes, data: doc.data }));
      console.error(`fixture : ${path.relative(ROOT, file)} (data ${doc.data.length} caractères, ${doc.size_bytes} o)`);
    } catch (error) {
      console.error(`fixture ${id} : ${error.message}`);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(OUT_DIR, `calibration-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ app: APP, at: new Date().toISOString(), marks, pageErrors, requests: done }, null, 2));
  console.error(`relevé : ${path.relative(ROOT, file)} (${done.length} requêtes vers le VPS)`);
  // Résumé : par étape, requêtes groupées par point d'accès.
  for (const mark of marks) {
    const rows = done.filter((entry) => entry.segment === mark.name);
    const groups = new Map();
    for (const entry of rows) {
      const route = entry.host === 'appwrite.redview.tech'
        ? `${entry.method} aw:${entry.path.replace(/\/v1\/databases\/[^/]+\/collections\/([^/]+)\/documents(\/[^/]+)?/, '/db/$1$2').replace(/\/documents\/[A-Za-z0-9._-]+/, '/:id').replace(/\/files\/[^/]+/, '/files/:id')}`
        : `${entry.method} ${entry.path.startsWith('/assets/') ? '/assets/*' : entry.path}${entry.sw ? ' [SW]' : ''}`;
      const group = groups.get(route) ?? { n: 0, req: 0, resp: 0, ms: [], status: new Set() };
      group.n += 1;
      group.req += Math.max(0, entry.reqBytes);
      group.resp += entry.respBytes ?? 0;
      group.ms.push(entry.ms ?? 0);
      group.status.add(entry.fromCache ? `${entry.status}c` : entry.status ?? entry.failed);
      groups.set(route, group);
    }
    console.error(`\n── ${mark.name} (${mark.ms} ms) : ${rows.length} requêtes`);
    for (const [route, group] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
      const sorted = group.ms.sort((a, b) => a - b);
      console.error(`  ${String(group.n).padStart(3)} × ${route.slice(0, 110)}  ↑${(group.req / 1024).toFixed(1)} Kio ↓${(group.resp / 1024).toFixed(1)} Kio  méd ${sorted[Math.floor(sorted.length / 2)]} ms  [${[...group.status].join(',')}]`);
    }
  }
  if (pageErrors.length) console.error(`\nerreurs de page : ${pageErrors.slice(0, 5).join(' | ')}`);
  try {
    await Promise.race([cdp.send('Browser.close'), sleep(3000)]);
  } catch {
    /* déjà fermé */
  }
  cdp.close();
  spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(userDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(300);
    }
  }
}
