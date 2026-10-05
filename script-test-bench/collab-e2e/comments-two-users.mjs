// Commentaires à deux utilisateurs : deux onglets `?collab=server&devUser=…`
// sur le serveur temps réel de dev — bulle reçue non lue, @mention, réponse,
// lu / non lu par utilisateur, annuler sans effet, écriture sur le message
// d'un autre refusée par le serveur, résolu. Nécessite `npm run dev` avec un
// serveur temps réel à jour (APP_URL, défaut 5173).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', 'reports', 'comments-e2e');
mkdirSync(SHOTS, { recursive: true });
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const PORT = 9383;
const out = { steps: {}, errors: { A: [], B: [] }, collab: { A: [], B: [] } };
const failures = [];
const check = (condition, label) => {
  out.steps[label] = condition ? 'ok' : 'FAILED';
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
  window.__rvMap = () => {
    const el = document.querySelector('.mapboxgl-map');
    const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    for (let f = key ? el[key] : null; f; f = f.return) {
      for (let h = f.memoizedState; h; h = h.next) {
        const c = h.memoizedState && h.memoizedState.current;
        if (c && typeof c.getCanvas === 'function') return c;
      }
    }
    return null;
  };
})()`;

const store = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;
const ONLINE = `!!document.querySelector('[data-rv-collab-status="online"]')`;

async function prepare(session, name) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  session.on('Runtime.exceptionThrown', (p) => out.errors[name].push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  session.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (text.includes('[collab]')) out.collab[name].push(text.slice(0, 240));
    if (p.type === 'error' && !/Stripe|sprite-storm|SW %c|gpx-loader|appwrite|Appwrite|401|403|net::/.test(text)) out.errors[name].push(`console.error: ${text.slice(0, 300)}`);
  });
}

async function demoLogin(session) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await session.evaluate(`!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.() || [...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) return;
    if (await session.evaluate(`[...document.querySelectorAll('button')].some(b => /Demo account|compte démo/i.test(b.textContent))`)) {
      await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    }
    await sleep(5000);
  }
}

async function mouse(session, type, x, y, { modifiers = 0, button = 'left' } = {}) {
  await session.send('Input.dispatchMouseEvent', { type, x, y, modifiers, button, buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
}
async function click(session, x, y) {
  await mouse(session, 'mouseMoved', x, y, { button: 'none' });
  await mouse(session, 'mousePressed', x, y);
  await mouse(session, 'mouseReleased', x, y);
}
async function clickSelector(session, selector) {
  const r = await session.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  if (!r) throw new Error(`absent : ${selector}`);
  await click(session, r.x, r.y);
}
async function key(session, keyName, { code, modifiers = 0, text } = {}) {
  const params = { key: keyName, code: code ?? keyName, modifiers, windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : keyName === 'Enter' ? 13 : keyName === 'Escape' ? 27 : 0 };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  if (text) await session.send('Input.dispatchKeyEvent', { type: 'char', text, ...params });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}
async function shot(session, name) {
  await session.send('Page.bringToFront').catch(() => null);
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

const { session: A, close } = await launch({ port: PORT });
let B = null;
try {
  await prepare(A, 'A');
  await A.send('Page.navigate', { url: `${APP}/?collab=server&devUser=alice` });
  await waitFor(A, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(2500);
  await demoLogin(A);
  await waitFor(A, `[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`, { timeout: 90000 });
  await A.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(A, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore() && !!window.__rvMap()`, { timeout: 90000 });
  await waitFor(A, ONLINE, { timeout: 30000 });
  check(true, 'A (alice) : session en ligne');
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => ({
    ...it,
    timeline: it.timeline.map((row) => row.kind === 'start' ? { ...row, label: 'Chamonix', lat: 45.9237, lon: 6.8694 }
      : row.kind === 'end' ? { ...row, label: 'Argentière', lat: 45.9822, lon: 6.9277 } : row),
  })) })), 0)`));
  await waitFor(A, `!!document.querySelector('.rv-comment-tool')`, { timeout: 30000 });
  await sleep(1500);
  await A.evaluate(`(window.__rvMap().jumpTo({ center: [6.89, 45.95], zoom: 13.2, pitch: 55, bearing: 0 }), 0)`);
  await sleep(2500);

  // A pose une bulle (mode commentaire, clic, texte, Entrée).
  await key(A, 'c', { code: 'KeyC', text: 'c' });
  await sleep(400);
  const mapA = await A.evaluate(`(() => { const r = document.querySelector('.mapboxgl-canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(A, mapA.x - 120, mapA.y - 60);
  await waitFor(A, `!!document.querySelector('[data-rv-comment-card="draft"] textarea')`, { timeout: 5000 });
  await A.send('Input.insertText', { text: 'Ravito possible ici ?' });
  await key(A, 'Enter', { code: 'Enter' });
  await sleep(800);
  const threadId = await A.evaluate(store(`s.project.comments?.[0]?.id ?? null`));
  check(Boolean(threadId), 'A : fil créé');
  await key(A, 'Escape', { code: 'Escape' });
  await key(A, 'Escape', { code: 'Escape' });
  await sleep(300);
  const projectUrl = await A.evaluate(`location.pathname`);

  // B (bob) rejoint le projet.
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  B = await connect(target.webSocketDebuggerUrl);
  await prepare(B, 'B');
  await B.send('Page.navigate', { url: `${APP}${projectUrl}?collab=server&devUser=bob` });
  await sleep(4000);
  await demoLogin(B);
  await waitFor(B, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.()`, { timeout: 120000 });
  await waitFor(B, ONLINE, { timeout: 30000 });
  await sleep(2000);
  check(await B.evaluate(store(`s.project.comments?.[0]?.messages?.[0]?.text === 'Ravito possible ici ?'`)), 'B : reçoit le fil de A');
  check(await A.evaluate(`!!document.querySelector('.rvi-header__people')`), 'deux personnes : pastilles d’éditeurs dans l’en-tête');
  // Même compte démo dans les deux onglets = même vue enregistrée (lu / non lu d'Alice) :
  // Bob part d'une vue neuve, comme un autre compte.
  await B.evaluate(store(`(s.setProject((p) => ({ ...p, commentsView: { ...p.commentsView, reads: {} } })), 0)`));
  await sleep(3000);
  await B.evaluate(`(window.__rvMap().jumpTo({ center: [6.89, 45.95], zoom: 13.2, pitch: 55, bearing: 0 }), 0)`);
  await sleep(2500);
  console.error('B pins', await B.evaluate(`JSON.stringify([...document.querySelectorAll('[data-rv-comment-pin]')].map((e) => [e.dataset.rvCommentPin, e.className]))`), 'devUser', await B.evaluate(`sessionStorage.getItem('redview:dev-user')`));
  check(await B.evaluate(`!!document.querySelector('[data-rv-comment-pin="${threadId}"].is-unread')`), 'B : bulle de A non lue (point rouge)');
  check(await B.evaluate(`!!document.querySelector('.rv-comment-tool__dot')`), 'B : point rouge sur l’outil Commenter');

  // B ouvre la bulle, répond en mentionnant alice.
  await B.send('Page.bringToFront');
  await sleep(800);
  console.error('B pin probe', await B.evaluate(`(() => { const e = document.querySelector('[data-rv-comment-pin="${threadId}"]'); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return JSON.stringify({ r: [r.left, r.top, r.width, r.height], hit: hit ? hit.tagName + '.' + hit.className : null, vis: document.visibilityState }); })()`));
  await key(B, 'c', { code: 'KeyC', text: 'c' });
  await sleep(600);
  check(await B.evaluate(`!!document.querySelector('.rv-comments-panel__item.is-unread')`), 'B : fil non lu dans la liste');
  await clickSelector(B, '.rv-comments-panel__item');
  await waitFor(B, `!!document.querySelector('[data-rv-comment-card="${threadId}"]')`, { timeout: 5000 });
  await sleep(500);
  check(await B.evaluate(`!document.querySelector('[data-rv-comment-pin="${threadId}"].is-unread')`), 'B : ouvrir le fil le marque lu');
  check(await B.evaluate(`!document.querySelector('.rv-comment-message .rv-comment-icon-button[aria-haspopup="menu"]')`), 'B : pas de Modifier / Supprimer sur le message de A');
  await B.evaluate(`document.querySelector('.rv-comment-card__reply textarea').focus()`);
  await B.send('Input.insertText', { text: '@ali' });
  await sleep(300);
  check(await B.evaluate(`[...document.querySelectorAll('.rv-comment-mentions__item')].some((i) => i.textContent.includes('alice'))`), 'B : @ propose alice (éditrice présente)');
  await key(B, 'Enter', { code: 'Enter' });
  await B.send('Input.insertText', { text: 'oui, fontaine au col' });
  await key(B, 'Enter', { code: 'Enter' });
  await sleep(1200);
  const reply = await A.evaluate(store(`s.project.comments?.[0]?.messages?.[1] ?? null`));
  check(reply?.authorId === 'bob' && reply?.text === '@alice oui, fontaine au col', `A : reçoit la réponse de bob (${reply?.text})`);
  check(JSON.stringify(reply?.mentions) === '["alice"]', 'mention de alice enregistrée');
  await A.evaluate(`(window.__rvMap().jumpTo({ center: [6.89, 45.95], zoom: 13.2, pitch: 55, bearing: 0 }), 0)`);
  await sleep(800);
  check(await A.evaluate(`!!document.querySelector('[data-rv-comment-pin="${threadId}"].is-unread')`), 'A : la réponse de bob rend le fil non lu');
  await shot(B, '10-bob-thread');
  await key(A, 'c', { code: 'KeyC', text: 'c' });
  await sleep(500);
  check(await A.evaluate(`[...document.querySelectorAll('.rv-comments-panel__tag--mention')].length === 1`), 'A : « @ vous » dans la liste');
  await shot(A, '11-alice-unread');
  await key(A, 'Escape', { code: 'Escape' });

  // Annuler (B) : sans effet sur les commentaires.
  await B.evaluate(`document.activeElement?.blur()`);
  await B.evaluate(store(`(s.undoTraceEdit(), 0)`));
  await sleep(800);
  check(await A.evaluate(store(`s.project.comments?.[0]?.messages?.length === 2`)), 'annuler chez B ne retire pas sa réponse');

  // Écriture forgée (client modifié) : B réécrit le message de A → refusée par le serveur.
  await B.evaluate(store(`(s.commitComments((threads) => threads.map((t) => ({ ...t, messages: t.messages.map((m) => m.authorId === 'alice' ? { ...m, text: 'Réécrit par bob' } : m) }))), 0)`));
  await sleep(1500);
  check(await A.evaluate(store(`s.project.comments[0].messages[0].text === 'Ravito possible ici ?'`)), 'écriture sur le message de A : refusée, A garde son texte');
  check(await B.evaluate(store(`s.project.comments[0].messages[0].text === 'Ravito possible ici ?'`)), 'B revient à l’état du serveur');
  check(out.collab.B.some((line) => line.includes('lot refusé')), 'refus journalisé côté B');

  // B résout le fil : chez A il disparaît de la carte (résolus masqués).
  await B.evaluate(`document.querySelector('[data-rv-comment-card] .rv-comment-icon-button[aria-pressed]')?.click()`);
  await sleep(1200);
  check(await A.evaluate(store(`s.project.comments[0].resolvedBy === 'bob'`)), 'B résout : résolu par bob chez A');
  check(await A.evaluate(`!document.querySelector('[data-rv-comment-pin="${threadId}"]')`), 'A : fil résolu masqué sur la carte');
} catch (error) {
  console.error(error);
  out.errors.A.push(`script: ${error.stack ?? error}`);
  if (B) await shot(B, 'zz-error-B').catch(() => null);
  await shot(A, 'zz-error-A').catch(() => null);
} finally {
  await close();
  // Le refus du lot forgé est attendu (vérifié plus haut) : pas une erreur console.
  const errors = Object.values(out.errors).flat().filter((line) => !line.includes('lot refusé par le serveur'));
  console.log(JSON.stringify({ steps: out.steps, failures, errors }));
}

process.exitCode = failures.length > 0 ? 1 : 0;
