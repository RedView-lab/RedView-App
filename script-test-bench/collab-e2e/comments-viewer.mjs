// Commentaires dans le viewer LiDAR WebGPU : onglet app (projet solo) + onglet
// viewer sur la tuile IGN 0965_6500 (téléchargée dans l'OPFS, 113 Mo) — bulle
// sur le MNT, fil, réponse écrite dans le viewer et reçue par l'app,
// « Commenter ici », « Commenter une zone », lecture seule quand le projet est
// fermé dans l'app. Nécessite `npm run dev` (APP_URL, défaut 5173) et un GPU.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', 'reports', 'comments-e2e');
mkdirSync(SHOTS, { recursive: true });
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const PORT = 9385;
const TILE = 'LHD_FXX_0965_6500_PTS_LAMB93_IGN69.copc.laz';
const TILE_URL = `https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/NUALHD_1-0__LAZ_LAMB93_QL_2025-03-26/${TILE}`;
const CENTER = { lng: 6.4033740, lat: 45.5434855 };
const failures = [];
const steps = {};
const errors = { app: [], viewer: [] };
const check = (condition, label) => {
  steps[label] = condition ? 'ok' : 'FAILED';
  if (!condition) failures.push(label);
  console.error(`${condition ? 'ok    ' : 'FAILED'} ${label}`);
};

const PATCH = `(() => {
  const Real = window.WebSocket;
  function Patched(url, protocols) {
    const p = Array.isArray(protocols) ? protocols : [protocols];
    if (p.includes('vite-hmr') || p.includes('vite-ping')) {
      return { readyState: 0, send() {}, close() {}, addEventListener() {}, removeEventListener() {} };
    }
    return new Real(url, protocols);
  }
  Patched.prototype = Real.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
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

async function prepare(session, name) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  session.on('Runtime.exceptionThrown', (p) => errors[name].push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  session.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error' && !/Stripe|sprite-storm|SW %c|gpx-loader|appwrite|Appwrite|401|403|net::/.test(text)) errors[name].push(`console.error: ${text.slice(0, 300)}`);
  });
}
async function mouse(session, type, x, y, button = 'left') {
  await session.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0, clickCount: 1 });
}
async function click(session, x, y, button = 'left') {
  await mouse(session, 'mouseMoved', x, y, 'none');
  await mouse(session, 'mousePressed', x, y, button);
  await sleep(60);
  await mouse(session, 'mouseReleased', x, y, button);
}
async function rectOf(session, selector) {
  return session.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null; })()`);
}
async function key(session, keyName) {
  const params = { key: keyName, code: keyName, windowsVirtualKeyCode: keyName === 'Enter' ? 13 : keyName === 'Escape' ? 27 : 0 };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}
async function shot(session, name) {
  await session.send('Page.bringToFront').catch(() => null);
  await sleep(300);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

const { session: A, close } = await launch({ port: PORT, extraArgs: ['--enable-unsafe-webgpu'] });
let V = null;
try {
  // ── Onglet app : projet solo, une bulle au centre de la tuile ────────────
  await prepare(A, 'app');
  await A.send('Page.navigate', { url: `${APP}/` });
  await waitFor(A, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(2500);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await A.evaluate(`[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) break;
    await A.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    await sleep(5000);
  }
  await A.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(A, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore()`, { timeout: 90000 });
  await sleep(1500);
  await A.evaluate(store(`(s.commitComments(() => [{
    id: 'cm-e2e-1', anchor: { lng: ${CENTER.lng}, lat: ${CENTER.lat}, elevationM: null }, createdBy: 'dev-user-001', createdAt: new Date().toISOString(),
    messages: [{ id: 'cmm-e2e-1', authorId: 'dev-user-001', authorName: 'Victor', text: 'Couloir à éviter après 14 h', createdAt: new Date().toISOString() }],
  }]), 0)`));
  check(await A.evaluate(store(`s.project.comments?.length === 1`)), 'app : bulle posée sur la tuile');

  // ── Onglet viewer : tuile dans l'OPFS, scène ────────────────────────────
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  V = await connect(target.webSocketDebuggerUrl);
  await prepare(V, 'viewer');
  await V.send('Page.navigate', { url: `${APP}/favicon.ico` });
  await sleep(800);
  const stored = await V.evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('lidar-hd', { create: true });
    const buf = await (await fetch(${JSON.stringify(TILE_URL)})).arrayBuffer();
    const fh = await dir.getFileHandle(${JSON.stringify(TILE)}, { create: true });
    const w = await fh.createWritable(); await w.write(buf); await w.close();
    return buf.byteLength;
  })()`);
  console.error(`tuile : ${stored} octets dans l'OPFS`);
  await V.send('Page.navigate', { url: `${APP}/viewer.html?x=965&y=6500&crs=LAMB93&alt=IGN69` });
  await waitFor(V, `document.getElementById('overlay')?.classList.contains('hidden') === true`, { timeout: 600000, interval: 1000 });
  await sleep(4000);
  check(await V.evaluate(`!!document.querySelector('.rv-lidar-comment-pin [data-rv-comment-pin="cm-e2e-1"]')`), 'viewer : la bulle du projet est là');
  const pin = await rectOf(V, '[data-rv-comment-pin="cm-e2e-1"]');
  check(Boolean(pin) && await V.evaluate(`getComputedStyle(document.querySelector('.rv-lidar-comment-pin')).visibility === 'visible'`), `viewer : bulle posée sur le MNT, à l'écran (${pin ? `${Math.round(pin.x)},${Math.round(pin.y)}` : 'hors champ'})`);
  await shot(V, '20-viewer-pin');

  // Ouvrir le fil, répondre depuis le viewer.
  if (pin) {
    await click(V, pin.x, pin.y);
    await waitFor(V, `!!document.querySelector('.rv-lidar-comment-card [data-rv-comment-card="cm-e2e-1"]')`, { timeout: 5000 }).catch(() => null);
    check(await V.evaluate(`!!document.querySelector('.rv-lidar-comment-card [data-rv-comment-card="cm-e2e-1"] .rv-comment-card__reply textarea')`), 'viewer : fil ouvert, réponse possible (app ouverte)');
    await V.evaluate(`document.querySelector('.rv-comment-card__reply textarea').focus()`);
    await V.send('Input.insertText', { text: 'Vu depuis le LiDAR : le couloir est raide' });
    await key(V, 'Enter');
    await sleep(1500);
    check(await A.evaluate(store(`s.project.comments[0].messages.length === 2 && s.project.comments[0].messages[1].text.startsWith('Vu depuis le LiDAR')`)), 'app : reçoit la réponse écrite dans le viewer');
    check(await V.evaluate(`document.querySelectorAll('.rv-lidar-comment-card .rv-comment-message').length === 2`), 'viewer : la réponse revient de l’app');
    await shot(V, '21-viewer-thread');
    await key(V, 'Escape');
    await sleep(300);
  }

  // Clic droit au centre : « Commenter ici ».
  const canvas = await rectOf(V, '#canvas');
  await click(V, canvas.x + 120, canvas.y + 60, 'right');
  await waitFor(V, `[...document.querySelectorAll('button')].some((b) => /Commenter ici|Comment here/.test(b.textContent))`, { timeout: 8000 }).catch(() => null);
  check(await V.evaluate(`[...document.querySelectorAll('button')].some((b) => /Commenter une zone|Comment on an area/.test(b.textContent))`), 'viewer : menu clic droit avec Commenter ici / une zone');
  await V.evaluate(`[...document.querySelectorAll('button')].find((b) => /Commenter ici|Comment here/.test(b.textContent))?.click()`);
  await waitFor(V, `!!document.querySelector('[data-rv-comment-card="draft"] textarea')`, { timeout: 5000 }).catch(() => null);
  check(await V.evaluate(`!!document.querySelector('[data-rv-comment-card="draft"]')`), 'viewer : saisie d’un nouveau commentaire');
  await V.send('Input.insertText', { text: 'Replat pour la pause' });
  await key(V, 'Enter');
  await waitFor(A, store(`(s.project.comments?.length ?? 0) >= 2`), { timeout: 15000 }).catch(() => null);
  console.error('after create', await A.evaluate(store(`JSON.stringify({ n: s.project.comments?.length, vis: document.visibilityState })`)), await V.evaluate(`JSON.stringify({ draft: !!document.querySelector('[data-rv-comment-card="draft"]'), text: document.querySelector('[data-rv-comment-card="draft"] textarea')?.value ?? null })`));
  const created = await A.evaluate(store(`s.project.comments?.[1] ?? null`));
  check(created?.messages?.[0]?.text === 'Replat pour la pause' && Number.isFinite(created?.anchor?.elevationM), `app : bulle créée depuis le viewer (altitude ${created?.anchor?.elevationM})`);
  await shot(V, '22-viewer-new');
  await key(V, 'Escape');
  await sleep(300);

  // « Commenter une zone » : sommets au clic, clic droit pour fermer.
  await click(V, canvas.x - 160, canvas.y + 40, 'right');
  await waitFor(V, `[...document.querySelectorAll('button')].some((b) => /Commenter une zone|Comment on an area/.test(b.textContent))`, { timeout: 8000 }).catch(() => null);
  await V.evaluate(`[...document.querySelectorAll('button')].find((b) => /Commenter une zone|Comment on an area/.test(b.textContent))?.click()`);
  await sleep(400);
  check(await V.evaluate(`document.querySelector('.rv-lidar-tool-hint__name')?.textContent?.includes('zone') ?? false`), 'viewer : outil « Commentaire de zone » armé');
  for (const [dx, dy] of [[-60, 120], [40, 140], [20, 210]]) {
    await click(V, canvas.x - 160 + dx, canvas.y + dy);
    await sleep(500);
  }
  await click(V, canvas.x - 140, canvas.y + 200, 'right');
  await waitFor(V, `!!document.querySelector('[data-rv-comment-card="draft"] .rv-comment-card__draft-context')`, { timeout: 5000 }).catch(() => null);
  check(await V.evaluate(`!!document.querySelector('[data-rv-comment-card="draft"] .rv-comment-card__draft-context')`), 'viewer : zone fermée → saisie d’un commentaire de zone');
  await V.send('Input.insertText', { text: 'Zone de chutes de pierres' });
  await key(V, 'Enter');
  await waitFor(A, store(`(s.project.comments?.length ?? 0) >= 3`), { timeout: 15000 }).catch(() => null);
  const zoneThread = await A.evaluate(store(`s.project.comments?.[2] ?? null`));
  check((zoneThread?.zone?.ring?.length ?? 0) >= 3, `app : commentaire de zone créé depuis le viewer (${zoneThread?.zone?.ring?.length ?? 0} sommets)`);
  await waitFor(V, `!!document.querySelector('.rv-lidar-comment-card [data-rv-comment-card="${zoneThread?.id}"]')`, { timeout: 4000 }).catch(() => null);
  check(await V.evaluate(`!!document.querySelector('.rv-lidar-comment-card [data-rv-comment-card="${zoneThread?.id}"]')`), 'viewer : le fil de zone revient de l’app et s’ouvre (app en arrière-plan)');
  await shot(V, '23-viewer-zone');

  // Projet fermé dans l'app : le viewer passe en lecture seule.
  await A.send('Page.bringToFront');
  await sleep(800);
  await A.evaluate(`[...document.querySelectorAll('button')].find((b) => /Retour au gestionnaire de projet|Back to project manager/.test(b.getAttribute('aria-label') ?? ''))?.click()`);
  await waitFor(A, `!document.querySelector('.mapboxgl-canvas')`, { timeout: 15000 }).catch(() => null);
  await V.send('Page.bringToFront');
  await sleep(1500);
  console.error('app after back', await A.evaluate(`JSON.stringify({ path: location.pathname, map: !!document.querySelector('.mapboxgl-canvas'), dialog: document.querySelector('[role=dialog], .rv-dialog')?.textContent?.slice(0, 120) ?? null })`));
  const pin2 = await rectOf(V, '[data-rv-comment-pin="cm-e2e-1"]');
  console.error('pin2', JSON.stringify(pin2));
  if (pin2) {
    await click(V, pin2.x, pin2.y);
    await sleep(600);
    console.error('viewer card', await V.evaluate(`JSON.stringify({ card: document.querySelector('.rv-lidar-comment-card [data-rv-comment-card]')?.getAttribute('data-rv-comment-card') ?? null, textarea: !!document.querySelector('.rv-lidar-comment-card textarea') })`));
    check(await V.evaluate(`!!document.querySelector('.rv-comment-card__readonly')`), 'viewer : projet fermé dans l’app → lecture seule');
  }
} catch (error) {
  console.error(error);
  errors.app.push(`script: ${error.stack ?? error}`);
  if (V) await shot(V, 'zz-viewer-error').catch(() => null);
} finally {
  await close();
  console.log(JSON.stringify({ steps, failures, errors }));
}

process.exitCode = failures.length > 0 ? 1 : 0;
