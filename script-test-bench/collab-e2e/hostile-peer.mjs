// Pair hostile : un éditeur malveillant (client WebSocket brut, jeton de dev
// `dev:mallory`) envoie à la salle ce qu'aucun client honnête n'enverrait.
// Le serveur doit refuser ce qui est dangereux (racine, clés détournées,
// `__proto__`, segments forgés, mauvais types) et rester debout ; ce qu'il
// accepte encore (valeurs bizarres mais bien formées) ne doit pas faire
// planter l'onglet de la victime (vraie app, `?collab=server&devUser=alice`).
//
//   APP_URL=http://localhost:5173 node script-test-bench/collab-e2e/hostile-peer.mjs
import { createRequire } from 'node:module';

import { launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

const SESSION_ONLINE = `!!document.querySelector('[data-rv-collab-status="online"]')`;
const PORT = 9375;
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const out = { steps: {}, errors: [], accepted: [], rejected: [], fatal: null };
const failures = [];
const check = (condition, label) => {
  out.steps[label] = condition ? 'ok' : 'FAILED';
  if (!condition) failures.push(label);
};

const STORE_PATCH = `(() => {
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

/** Base64url d'un texte (sous-protocole `auth.`, comme src/features/collab/protocol.ts). */
const authProtocol = (token) => `auth.${Buffer.from(token, 'utf8').toString('base64url')}`;

/** Client brut de Mallory : connexion, `hello`, et envoi de lots avec attente de la réponse du serveur. */
async function mallory(projectId) {
  const wsUrl = `${APP.replace(/^http/, 'ws')}/multiplayer?project=${encodeURIComponent(projectId)}`;
  const socket = new WebSocket(wsUrl, ['redview.v4', authProtocol('dev:mallory')]);
  const inbox = [];
  socket.on('message', (data) => inbox.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('close', (code) => reject(new Error(`Mallory refusée (${code})`)));
  });
  socket.send(JSON.stringify({ type: 'hello', v: 4, clientId: 'mallory-1', epoch: null, lastSeq: null, presence: { name: 'Alice (propriétaire)' } }));
  const deadline = Date.now() + 15_000;
  while (!inbox.some((m) => m.type === 'welcome')) {
    if (Date.now() > deadline) throw new Error('pas de welcome pour Mallory');
    await sleep(50);
  }
  let clientSeq = 0;
  return {
    welcome: inbox.find((m) => m.type === 'welcome'),
    inbox,
    socket,
    /** Envoie un lot ; 'accepted' | 'rejected:<raison>'. */
    async batch(label, ops, blobs = {}) {
      clientSeq += 1;
      const seq = clientSeq;
      socket.send(JSON.stringify({ type: 'batch', clientSeq: seq, ops, blobs }));
      const until = Date.now() + 5_000;
      for (;;) {
        const answer = inbox.find((m) => (m.type === 'reject' && m.clientSeq === seq) || (m.type === 'batch' && m.batch.clientId === 'mallory-1' && m.batch.clientSeq === seq));
        if (answer) {
          const result = answer.type === 'reject' ? `rejected:${answer.reason}` : 'accepted';
          (answer.type === 'reject' ? out.rejected : out.accepted).push(`${label} → ${result}`);
          return result;
        }
        if (Date.now() > until) return 'no-answer';
        await sleep(25);
      }
    },
  };
}

const { session: A, close } = await launch({ port: PORT });
try {
  await A.send('Page.enable');
  await A.send('Runtime.enable');
  await A.send('Page.addScriptToEvaluateOnNewDocument', { source: STORE_PATCH });
  await A.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  A.on('Runtime.exceptionThrown', (p) => out.errors.push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  A.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error' && !/Stripe|sprite-storm|SW %c|gpx-loader|lot refusé/.test(text)) out.errors.push(`console.error: ${text.slice(0, 300)}`);
  });

  await A.send('Page.navigate', { url: `${APP}/?collab=server&devUser=alice` });
  await waitFor(A, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(3000);
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitFor(A, `[...document.querySelectorAll('button')].some(b => /Demo account|compte démo|Créer un projet|Create a project/i.test(b.textContent))`, { timeout: 90000 });
    if (await A.evaluate(`[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) break;
    await A.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    await sleep(8000);
  }
  await A.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(A, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore()`, { timeout: 90000 });
  await waitFor(A, SESSION_ONLINE, { timeout: 30000 });
  await sleep(2000);
  const projectId = (await A.evaluate(`location.pathname`)).split('--').pop();
  if (!(await A.evaluate(`window.__rvStore().project.itineraries.length > 0`))) await A.evaluate(`(window.__rvStore().addItinerary(), 0)`);
  await waitFor(A, `window.__rvStore().project.itineraries.length > 0`, { timeout: 10000 });
  await sleep(1500);
  const itineraryId = await A.evaluate(`window.__rvStore().project.itineraries[0].id`);
  const IT = `p/itineraries:${itineraryId}`;
  const rowId = await A.evaluate(`window.__rvStore().project.itineraries[0].timeline[0]?.id ?? null`);
  out.steps.project = { projectId, itineraryId, rowId };

  const m = await mallory(projectId);
  const alive = async () => A.evaluate(`!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.() && !document.body.innerText.includes('Something went wrong')`);

  // ── Refusé : dangereux pour le serveur ou les règles.
  const json = '[{"lat":1,"lon":2}],"injecte":{"x":1},"y":[{"lat":3,"lon":4}]';
  const chunkId = 'cforged1';
  for (const [label, ops, blobs] of [
    ['suppression de la racine', [{ t: 'd', id: 'p' }]],
    ['clé __proto__', [{ t: 's', id: 'p', k: '__proto__', v: { polluted: true } }]],
    ['clé non canonique nam%65', [{ t: 's', id: IT, k: 'nam%65', v: 'x' }]],
    ['nom d’itinéraire objet', [{ t: 's', id: IT, k: 'name', v: { toString: 1 } }]],
    ['couleur CSS piégée', [{ t: 's', id: IT, k: 'color', v: 'red;background:url(https://evil.example)' }]],
    ['segment de tracé forgé', [{ t: 's', id: IT, k: 'gpxRoute', v: { v: 1, meta: {}, points: [chunkId] } }], { [chunkId]: json }],
    ['valeur à 200 niveaux', [{ t: 's', id: IT, k: 'metrics', v: JSON.parse('['.repeat(200) + ']'.repeat(200)) }]],
    ['liste des itinéraires en texte', [{ t: 's', id: 'p', k: 'itineraries', v: 'pas une liste' }]],
    ['tracé qui n’en est pas un', [{ t: 's', id: IT, k: 'gpxRoute', v: { points: 5 } }]],
  ]) {
    const result = await m.batch(label, ops, blobs);
    check(result.startsWith('rejected'), `refusé : ${label} (${result})`);
  }

  // ── Accepté (bien formé) mais inattendu : l'onglet d'Alice ne doit pas planter.
  for (const [label, ops] of [
    ['itinéraire nu (id + nom)', [{ t: 'c', id: 'p/itineraries:evil', parent: 'p', field: 'itineraries', pos: 'a5', props: [['id', 'evil'], ['name', 'Piège']] }]],
    ['priorité en objet', [{ t: 's', id: IT, k: 'priorities.elevation', v: { nested: [1, 2, 3] } }]],
    ['heure de départ en objet', [{ t: 's', id: IT, k: 'rhythm.startTime', v: { h: 9 } }]],
    ['métriques profondes', [{ t: 's', id: IT, k: 'metrics', v: JSON.parse('['.repeat(50) + '1' + ']'.repeat(50)) }]],
    ['profils de tracé embarqués illisibles', [{ t: 's', id: 'p', k: 'routingProfiles', v: { not: 'a list' } }]],
    ['libellé de 100 000 caractères', [{ t: 's', id: `${IT}/timeline:${encodeURIComponent(rowId ?? 'start')}`, k: 'label', v: 'x'.repeat(100_000) }]],
    ['commentaire de Mallory', [{
      t: 'c', id: 'p/comments:evil-thread', parent: 'p', field: 'comments', pos: 'a0',
      props: [['id', 'evil-thread'], ['anchor', { lng: 6.87, lat: 45.92, elevationM: null }], ['createdBy', 'mallory'], ['createdAt', new Date().toISOString()]],
    }, {
      t: 'c', id: 'p/comments:evil-thread/messages:m1', parent: 'p/comments:evil-thread', field: 'messages', pos: 'a0',
      props: [['id', 'm1'], ['authorId', 'mallory'], ['authorName', 'Alice'], ['text', '<img src=x onerror=alert(1)> @Alice'], ['createdAt', new Date().toISOString()]],
    }]],
  ]) {
    const result = await m.batch(label, ops);
    await sleep(1500);
    out.steps[`accepté : ${label}`] = result;
    check(await alive(), `onglet de la victime toujours vivant après : ${label} (${result})`);
  }

  // Le nom affiché de Mallory est celui de son compte, pas « Alice (propriétaire) ».
  await sleep(500);
  const peers = [...m.inbox].reverse().find((message) => message.type === 'peers');
  const malloryName = peers?.peers.find((peer) => peer.clientId === 'mallory-1')?.presence?.name ?? null;
  check(malloryName !== 'Alice (propriétaire)', `nom de présence non usurpé (${malloryName})`);
  // Aucun script injecté par un commentaire.
  check(!(await A.evaluate(`document.querySelectorAll('img[src="x"]').length > 0`)), 'texte de commentaire jamais interprété en HTML');
  // Le serveur sert toujours : un renommage honnête d'Alice arrive chez Mallory.
  await A.evaluate(`(window.__rvStore().setProject((p) => ({ ...p, itineraries: p.itineraries.map((it, i) => i === 0 ? { ...it, name: 'Après l’attaque' } : it) })), 0)`);
  const until = Date.now() + 10_000;
  while (!m.inbox.some((message) => message.type === 'batch' && JSON.stringify(message.batch.ops).includes('Après l’attaque')) && Date.now() < until) await sleep(100);
  check(m.inbox.some((message) => message.type === 'batch' && JSON.stringify(message.batch.ops).includes('Après l’attaque')), 'la salle sert toujours (modification honnête relayée)');
  check(({}).polluted === undefined, 'aucune pollution de prototype côté client de test');
  m.socket.close();
} catch (error) {
  out.fatal = String(error?.stack ?? error);
} finally {
  await close();
}
out.failures = failures;
console.log(JSON.stringify(out, null, 2));
process.exitCode = failures.length > 0 || out.fatal ? 1 : 0;
