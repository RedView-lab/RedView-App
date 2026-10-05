// Trace (production) de la réouverture d'un projet partagé : A crée, partage
// et renomme en session ; B ouvre le projet (puis le recharge), A recharge et
// renomme aussitôt ; on relève, toutes les 100 ms, le nom vu par chacun, l'état
// de la session (en-tête) et les messages du serveur temps réel. Outil de
// diagnostic d'un document de session écrasé ou d'une modification perdue à
// l'ouverture (cf. bench:collab-prod pour les vérifications).
//
//   node --env-file=.env script-test-bench/collab-e2e/prod-reopen-trace.mjs
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client, Databases, Query, Storage, Teams } from 'node-appwrite';

import { connect, launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const APP = 'https://app.redview.tech';
const PORT = 9385;
const accounts = JSON.parse(readFileSync(path.join(os.homedir(), '.redview', 'collab-test-accounts.json'), 'utf8'));
const admin = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const DB = process.env.APPWRITE_DATABASE_ID || 'redview-db';
const databases = new Databases(admin);

const TRACE = `(() => {
  window.__rvTrace = [];
  const t0 = performance.now();
  const log = (kind, value) => window.__rvTrace.push([Math.round(performance.now() - t0), kind, value]);
  window.__rvLog = log;
  const Real = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = new Real(url, protocols);
    if (String(url).includes('/multiplayer')) {
      log('ws', 'open ' + String(url).slice(-12));
      ws.addEventListener('message', (event) => {
        try {
          const m = JSON.parse(event.data);
          if (m.type === 'pong' || m.type === 'durable') return;
          log('ws<', m.type + (m.seq !== undefined ? ' seq=' + m.seq : '') + (m.batch ? ' seq=' + m.batch.seq : '') + (m.snapshot ? ' snapshot' : '') + (m.catchUp ? ' catchUp=' + m.catchUp.length : ''));
        } catch { /* ignore */ }
      });
      ws.addEventListener('close', (event) => log('ws', 'close ' + event.code));
    }
    return ws;
  };
  window.WebSocket.prototype = Real.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.__rvStore = () => {
    const el = document.querySelector('.mapboxgl-map');
    const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    for (let f = key ? el[key] : null; f; f = f.return) {
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && typeof v.setProject === 'function' && v.project && 'derivedComputeGate' in v) return v;
    }
    return null;
  };
  let lastName = null;
  let lastProject = null;
  setInterval(() => {
    const s = window.__rvStore?.();
    if (!s) return;
    const status = document.querySelector('[data-rv-collab-status]')?.dataset.rvCollabStatus;
    const name = s.project.itineraries[0]?.name + ' / ' + s.project.itineraries[0]?.color + (status ? ' [' + status + ']' : '');
    if (name !== lastName || s.project !== lastProject) {
      if (name !== lastName) log('store', name);
      lastName = name;
      lastProject = s.project;
    }
  }, 100);
})()`;

const setInput = (selector, value) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
const projectsVisible = `[...document.querySelectorAll('button')].some((b) => /Créer un projet|Create a project/.test(b.textContent))`;
const store = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;
const SESSION_ONLINE = `!!document.querySelector('[data-rv-collab-status="online"]')`;
async function reloadPage(page) {
  await page.evaluate(`window.__rvBeforeReload = true`);
  await page.send('Page.reload', {});
  await waitFor(page, `!window.__rvBeforeReload`, { timeout: 60_000 });
}

async function newPage(browser) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', {});
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const page = await connect(`ws://127.0.0.1:${PORT}/devtools/page/${targetId}`);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACE });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  page.on('Page.javascriptDialogOpening', () => void page.send('Page.handleJavaScriptDialog', { accept: true }));
  return page;
}

async function login(page, account) {
  await page.send('Page.navigate', { url: APP });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitFor(page, `!!document.querySelector('input[type=email]') || ${projectsVisible}`, { timeout: 90_000 });
    if (await page.evaluate(projectsVisible)) return;
    await page.evaluate(setInput('input[type=email]', account.email));
    await page.evaluate(setInput('input[type=password]', account.password));
    await sleep(200);
    await page.evaluate(`document.querySelector('.rv-login-submit-btn').click()`);
    try {
      await waitFor(page, projectsVisible, { timeout: 30_000 });
      return;
    } catch { /* recommence */ }
  }
}

const { close } = await launch({ port: PORT });
let projectId = null;
try {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl);
  const A = await newPage(browser);
  const B = await newPage(browser);
  await Promise.all([login(A, accounts.A), login(B, accounts.B)]);
  // Laisse passer le rechargement du Service Worker au premier passage.
  await sleep(8000);
  await Promise.all([waitFor(A, projectsVisible, { timeout: 90_000 }), waitFor(B, projectsVisible, { timeout: 90_000 })]);

  await A.evaluate(`[...document.querySelectorAll('button')].find((b) => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(A, `!!document.querySelector('.rvi-header__share') && !!window.__rvStore?.()`, { timeout: 120_000 });
  projectId = (await A.evaluate('location.pathname')).split('--').pop();
  const itineraryId = await A.evaluate(store('s.project.itineraries[0]?.id ?? s.addItinerary()'));
  await sleep(1500);
  await A.evaluate(`document.querySelector('.rvi-header__share').click()`);
  await waitFor(A, `!!document.querySelector('.rv-share-dialog__input')`, { timeout: 15_000 });
  await A.evaluate(setInput('.rv-share-dialog__input', accounts.B.email));
  await sleep(200);
  await A.evaluate(`document.querySelector('.rv-share-dialog__invite button[type=submit]').click()`);
  await waitFor(A, SESSION_ONLINE, { timeout: 30_000 });
  await A.evaluate(`[...document.querySelectorAll('button')].find((b) => /^Terminé$/.test(b.textContent))?.click()`);
  await sleep(1500);
  await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, 'X1-session'), s.setItineraryColor(${JSON.stringify(itineraryId)}, '#3d8bff'), 0)`));
  await sleep(2500);

  const projectPath = await A.evaluate('location.pathname');
  await B.evaluate(`window.__rvLog('nav', 'ouverture')`);
  await B.send('Page.navigate', { url: `${APP}${projectPath}` });
  await waitFor(B, `!!window.__rvStore?.() && ${SESSION_ONLINE}`, { timeout: 120_000 });
  await sleep(8000);
  const firstOpen = await B.evaluate('window.__rvTrace');

  await reloadPage(B);
  await waitFor(B, `!!window.__rvStore?.() && ${SESSION_ONLINE}`, { timeout: 120_000 });
  await sleep(8000);
  const afterReload = await B.evaluate('window.__rvTrace');

  // A recharge et renomme dès que l'éditeur est là (pendant la connexion).
  await reloadPage(A);
  await waitFor(A, `!!window.__rvStore?.()`, { timeout: 120_000 });
  await A.evaluate(store(`(window.__rvLog('test', 'renomme X2'), s.setItineraryName(${JSON.stringify(itineraryId)}, 'X2-apres-rechargement'), 0)`));
  await sleep(6000);
  const aAfterReload = await A.evaluate('window.__rvTrace');
  const bSeesX2 = await B.evaluate(store('s.project.itineraries[0]?.name'));

  console.log(JSON.stringify({ projectId, firstOpen, afterReload, aAfterReload, bSeesX2 }, null, 1));
} finally {
  if (projectId) {
    const storage = new Storage(admin);
    await new Teams(admin).delete(`p${projectId}`).catch(() => undefined);
    for (const collection of ['project_journal', 'project_views']) {
      const rows = await databases.listDocuments(DB, collection, [Query.equal('project_id', projectId), Query.limit(100)]).catch(() => ({ documents: [] }));
      for (const row of rows.documents) await databases.deleteDocument(DB, collection, row.$id).catch(() => undefined);
    }
    for (const name of [`${projectId}.collab.gz`, `${projectId}.json.gz`]) {
      const list = await storage.listFiles('project-payloads', [Query.equal('name', name)]).catch(() => ({ files: [] }));
      for (const file of list.files) await storage.deleteFile('project-payloads', file.$id).catch(() => undefined);
    }
    await storage.deleteFile('project-thumbnails', projectId).catch(() => undefined);
    await databases.deleteDocument(DB, 'projects', projectId).catch(() => undefined);
  }
  await close();
}
