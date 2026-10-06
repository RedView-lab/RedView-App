// E2E co-édition entre deux onglets (vraie app, `npm run dev`, compte démo,
// `?collab=server` : session sur le serveur temps réel de dev, port 17790,
// servi par Vite sous /multiplayer). Compte les appels BRouter de chaque
// onglet : seul l'auteur d'une modification doit router.
import { launch, connect, sleep, waitFor } from '../screen-audit/cdp.mjs';
import { armSlowWelcome, SLOW_WELCOME_SCRIPT } from './slowWelcome.mjs';

/** Session temps réel en ligne (état du serveur reçu) : attribut de l'en-tête du panneau. */
const SESSION_ONLINE = `!!document.querySelector('[data-rv-collab-status="online"]')`;

const PORT = 9371;
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const out = { steps: {}, errors: { A: [], B: [] }, brouter: { A: [], B: [] }, collabLogs: { A: [], B: [] }, sockets: { A: [], B: [] }, jwt: {}, failedRequests: {} };
const failures = [];
const check = (condition, label) => {
  out.steps[label] = condition ? 'ok' : 'FAILED';
  if (!condition) failures.push(label);
};

const HMR_PATCH = `(() => {
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

async function preparePage(session, name) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Network.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: HMR_PATCH });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  session.on('Network.requestWillBeSent', (p) => {
    if (new URL(p.request.url).pathname.startsWith('/api/brouter')) out.brouter[name].push(`${Date.now()} ${p.request.method} ${p.request.url.slice(0, 120)}`);
  });
  session.on('Network.requestWillBeSent', (p) => {
    if (/\/account\/jwts?\b/.test(p.request.url)) (out.jwt[name] ??= []).push(`${Date.now()} ${p.request.method} ${p.requestId}`);
  });
  session.on('Network.loadingFailed', (p) => {
    (out.failedRequests[name] ??= []).push(`${p.requestId} ${p.errorText}`);
  });
  session.on('Network.webSocketCreated', (p) => {
    if (new URL(p.url).pathname === '/multiplayer') out.sockets[name].push(p.url);
  });
  session.on('Runtime.exceptionThrown', (p) => out.errors[name].push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  session.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (text.includes('[collab]')) out.collabLogs[name].push(text.slice(0, 200));
    if (p.type === 'error' && !/Stripe|sprite-storm|SW %c|gpx-loader/.test(text)) out.errors[name].push(`console.error: ${text.slice(0, 300)}`);
  });
}

async function loginDemoAndCreateProject(session) {
  await waitFor(session, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(3000);
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitFor(session, `[...document.querySelectorAll('button')].some(b => /Demo account|compte démo|Créer un projet|Create a project/i.test(b.textContent))`, { timeout: 90000 });
    if (await session.evaluate(`[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) break;
    await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    await sleep(8000);
  }
  await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore()`, { timeout: 90000 });
}

/** Onglet ouvert sur l'URL d'un projet : connexion au compte démo (pas partagée entre onglets) puis carte prête. */
async function openWithDemoAccount(session) {
  await sleep(4000);
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await session.evaluate(`!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.()`)) break;
    if (await session.evaluate(`[...document.querySelectorAll('button')].some(b => /Demo account|compte démo/i.test(b.textContent))`)) {
      await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    }
    await sleep(6000);
  }
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.()`, { timeout: 120000 });
}

const store = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;

const { session: A, close } = await launch({ port: PORT });
let B = null;
try {
  await preparePage(A, 'A');
  await A.send('Page.navigate', { url: `${APP}/?collab=server` });
  await loginDemoAndCreateProject(A);
  await waitFor(A, `true`);
  await sleep(1500);

  // Itinéraire routé par BRouter : départ et arrivée posés dans la feuille de route.
  const itineraryId = await A.evaluate(store(`s.addItinerary()`));
  await sleep(500);
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => it.id !== ${JSON.stringify(itineraryId)} ? it : {
    ...it,
    timeline: it.timeline.map((row) => row.kind === 'start' ? { ...row, label: 'Chamonix', lat: 45.9237, lon: 6.8694 }
      : row.kind === 'end' ? { ...row, label: 'Argentière', lat: 45.9822, lon: 6.9277 } : row),
  }) })), 0)`));
  await waitFor(A, store(`(s.project.itineraries[0]?.gpxRoute?.points?.length ?? 0) > 10`), { timeout: 60000 });
  out.steps.initialRoutePointsA = await A.evaluate(store(`s.project.itineraries[0].gpxRoute.points.length`));
  const projectUrl = await A.evaluate(`location.pathname`);
  await sleep(2000);
  const brouterAfterSetupA = out.brouter.A.length;

  // Onglet B : même navigateur, même projet, rejoint la session.
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  B = await connect(target.webSocketDebuggerUrl);
  await preparePage(B, 'B');
  await B.send('Page.navigate', { url: `${APP}${projectUrl}?collab=server` });
  await openWithDemoAccount(B);
  out.steps.screenB = await B.evaluate(`({ url: location.pathname + location.search, text: document.body.innerText.slice(0, 160) })`);
  await waitFor(B, SESSION_ONLINE, { timeout: 30000 });
  await waitFor(A, SESSION_ONLINE, { timeout: 30000 });
  await sleep(4000);
  out.steps.multiplayerSockets = { A: out.sockets.A.length, B: out.sockets.B.length };
  check(out.sockets.A.length > 0 && out.sockets.B.length > 0, 'les deux onglets sont connectés au serveur temps réel');
  // Même compte dans deux onglets : une seule personne (comme Figma), donc pas de pastilles d'éditeurs.
  const noAvatars = `!document.querySelector('.rvi-header__people')`;
  check(await A.evaluate(noAvatars) && await B.evaluate(noAvatars), 'en-tête : même compte dans deux onglets, une seule personne (pas de pastilles)');
  check(
    await B.evaluate(store(`(s.project.itineraries[0]?.gpxRoute?.points?.length ?? 0) > 10`)),
    'B ouvre le projet : itinéraire et tracé présents',
  );
  check(out.brouter.B.length === 0, `B à l'ouverture : aucun appel BRouter (${out.brouter.B.length})`);

  // 1. Renommage par A → B.
  await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, 'Renommé par A'), 0)`));
  await waitFor(B, store(`s.project.itineraries[0].name === 'Renommé par A'`), { timeout: 10000 }).catch(() => null);
  check(await B.evaluate(store(`s.project.itineraries[0].name === 'Renommé par A'`)), 'renommage de A reçu par B');

  // 1 bis. Latence A → B sans réseau (serveur local) : toute la chaîne de l'application.
  const latencies = [];
  for (let index = 0; index < 40; index += 1) {
    const name = `lat-${index}-${Date.now()}`;
    const seen = B.evaluate(`new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const s = window.__rvStore?.();
        if (s && s.project.itineraries[0].name === ${JSON.stringify(name)}) resolve(Date.now());
        else if (Date.now() - start > 10000) resolve(null);
        else setTimeout(tick, 4);
      };
      tick();
    })`);
    const sentAt = await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, ${JSON.stringify(name)}), Date.now())`));
    const seenAt = await seen;
    if (seenAt === null) break;
    latencies.push(seenAt - sentAt);
    await sleep(150);
  }
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  out.steps.localLatencyMs = {
    p50: sortedLatencies[Math.floor(sortedLatencies.length * 0.5)],
    p95: sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))],
    max: sortedLatencies[sortedLatencies.length - 1],
  };
  check(latencies.length === 40, `latence locale : 40 renommages reçus (${latencies.length})`);
  check(out.steps.localLatencyMs.p95 < 500, `latence locale A → B p95 < 500 ms (${out.steps.localLatencyMs.p95} ms)`);
  // Nom d'avant la mesure : les étapes suivantes le vérifient.
  await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, 'Renommé par A'), 0)`));
  await waitFor(B, store(`s.project.itineraries[0].name === 'Renommé par A'`), { timeout: 10000 }).catch(() => null);

  // 2. Vue propre à chacun : le mode de A ne change pas celui de B.
  const modeB = await B.evaluate(store(`s.project.activeMode`));
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, activeMode: 'poi' })), 0)`));
  await sleep(1500);
  check(await B.evaluate(store(`s.project.activeMode`)) === modeB, 'vue : le mode du panneau de A ne change pas celui de B');

  // 3. A déplace l'arrivée : A route, B n'appelle jamais BRouter et reçoit le tracé.
  const brouterBBefore = out.brouter.B.length;
  const brouterABefore = out.brouter.A.length;
  const stampBefore = await A.evaluate(store(`s.project.itineraries[0].gpxRoute.routedInputsKey`));
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => ({
    ...it,
    timeline: it.timeline.map((row) => row.kind === 'end' ? { ...row, label: 'Le Tour', lat: 46.0024, lon: 6.9416 } : row),
  })) })), 0)`));
  await waitFor(A, store(`s.project.itineraries[0].gpxRoute.routedInputsKey !== ${JSON.stringify(stampBefore)}`), { timeout: 60000 });
  await waitFor(B, store(`s.project.itineraries[0].gpxRoute.routedInputsKey !== ${JSON.stringify(stampBefore)}`), { timeout: 20000 }).catch(() => null);
  await sleep(4000);
  const stampA = await A.evaluate(store(`s.project.itineraries[0].gpxRoute.routedInputsKey`));
  const stampB = await B.evaluate(store(`s.project.itineraries[0].gpxRoute.routedInputsKey`));
  check(out.brouter.A.length > brouterABefore, `A (auteur) route (${out.brouter.A.length - brouterABefore} appel(s))`);
  check(out.brouter.B.length === brouterBBefore, `B ne route pas la modification de A (${out.brouter.B.length - brouterBBefore} appel(s))`);
  check(stampA === stampB, 'B reçoit le tracé de A (même estampille)');
  const endB = await B.evaluate(store(`s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat`));
  check(endB === 46.0024, 'B voit le nouveau point d’arrivée');

  // 4. B change la couleur ; A annule : seul le déplacement de A est annulé, tracé compris, sans routage.
  await B.evaluate(store(`(s.setItineraryColor(${JSON.stringify(itineraryId)}, '#3d8bff'), 0)`));
  await waitFor(A, store(`s.project.itineraries[0].color === '#3d8bff'`), { timeout: 10000 }).catch(() => null);
  const brouterAllBeforeUndo = out.brouter.A.length + out.brouter.B.length;
  await A.evaluate(store(`(s.undoTraceEdit(), 0)`));
  await sleep(4000);
  const afterUndoA = await A.evaluate(store(`({ end: s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat, stamp: s.project.itineraries[0].gpxRoute.routedInputsKey, color: s.project.itineraries[0].color, name: s.project.itineraries[0].name })`));
  const afterUndoB = await B.evaluate(store(`({ end: s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat, stamp: s.project.itineraries[0].gpxRoute.routedInputsKey, color: s.project.itineraries[0].color })`));
  out.steps.afterUndo = { A: afterUndoA, B: afterUndoB };
  check(afterUndoA.end === 45.9822 && afterUndoB.end === 45.9822, 'A annule : l’arrivée revient chez A et chez B');
  check(afterUndoA.stamp === stampBefore && afterUndoB.stamp === stampBefore, 'A annule : l’ancien tracé revient (même estampille) chez les deux');
  check(afterUndoA.color === '#3d8bff' && afterUndoB.color === '#3d8bff', 'la couleur de B reste');
  check(out.brouter.A.length + out.brouter.B.length === brouterAllBeforeUndo, 'annuler : aucun appel BRouter');

  // 5. Rétablir.
  await A.evaluate(store(`(s.redoTraceEdit(), 0)`));
  await sleep(3000);
  const afterRedoB = await B.evaluate(store(`({ end: s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat, stamp: s.project.itineraries[0].gpxRoute.routedInputsKey })`));
  check(afterRedoB.end === 46.0024 && afterRedoB.stamp === stampA, 'A rétablit : point et tracé reviennent chez B');
  check(out.brouter.A.length + out.brouter.B.length === brouterAllBeforeUndo, 'rétablir : aucun appel BRouter');

  // 6. B annule sa couleur (ses actions seulement).
  await B.evaluate(store(`(s.undoTraceEdit(), 0)`));
  await sleep(2000);
  const afterUndoBColor = await A.evaluate(store(`({ color: s.project.itineraries[0].color, end: s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat, name: s.project.itineraries[0].name })`));
  check(afterUndoBColor.color !== '#3d8bff' && afterUndoBColor.end === 46.0024 && afterUndoBColor.name === 'Renommé par A', 'B annule : sa couleur seule, les actions de A restent');
  // 7. B recharge la page : l'état revient du serveur (sans BRouter, sans recalcul).
  const beforeReload = await A.evaluate(store(`JSON.stringify(s.project.itineraries.map((it) => [it.id, it.name, it.color, it.gpxRoute?.routedInputsKey]))`));
  const brouterBeforeReload = out.brouter.B.length;
  await B.evaluate(`window.__rvBeforeReload = true`);
  await B.send('Page.reload', {});
  await waitFor(B, `!window.__rvBeforeReload`, { timeout: 30000 });
  await openWithDemoAccount(B);
  out.steps.reloadB = await B.evaluate(`({ url: location.pathname + location.search, flag: sessionStorage.getItem('redview:dev-collab'), text: document.body.innerText.slice(0, 120) })`);
  await waitFor(B, SESSION_ONLINE, { timeout: 30000 });
  const docOf = `JSON.stringify(window.__rvStore().project.itineraries.map((it) => [it.id, it.name, it.color, it.gpxRoute?.routedInputsKey]))`;
  await waitFor(B, `${docOf} === ${JSON.stringify(beforeReload)}`, { timeout: 10000 }).catch(() => null);
  const afterReload = await B.evaluate(docOf);
  check(afterReload === beforeReload, 'B recharge : même document que A (état du serveur)');
  check(out.brouter.B.length === brouterBeforeReload, 'B recharge : aucun appel BRouter');

  // 8. B recharge et renomme pendant la connexion (état du serveur retardé de 8 s) : rien n'est perdu.
  await B.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_WELCOME_SCRIPT });
  await B.evaluate(armSlowWelcome(8000));
  await B.evaluate(`window.__rvBeforeReload = true`);
  await B.send('Page.reload', {});
  await waitFor(B, `!window.__rvBeforeReload`, { timeout: 30000 });
  await openWithDemoAccount(B);
  await waitFor(B, `!!window.__rvStore?.()`, { timeout: 120000 });
  const statusAtEdit = await B.evaluate(`document.querySelector('[data-rv-collab-status]')?.dataset.rvCollabStatus ?? 'aucun'`);
  await B.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, 'Renommé pendant la connexion'), 0)`));
  out.steps.statusAtEditDuringConnect = statusAtEdit;
  await waitFor(A, store(`s.project.itineraries[0].name === 'Renommé pendant la connexion'`), { timeout: 15000 }).catch(() => null);
  check(statusAtEdit === 'connecting', `B renomme pendant la connexion (état de la session : ${statusAtEdit})`);
  check(await A.evaluate(store(`s.project.itineraries[0].name === 'Renommé pendant la connexion'`)), 'modification de B faite pendant sa connexion : reçue par A');
  await waitFor(B, SESSION_ONLINE, { timeout: 30000 });
  check(await B.evaluate(store(`s.project.itineraries[0].name === 'Renommé pendant la connexion'`)), 'B garde sa modification une fois en ligne');
  out.steps.brouterSetupA = brouterAfterSetupA;
} catch (error) {
  out.fatal = String(error?.stack ?? error);
} finally {
  try { B?.ws.close(); } catch { /* ignore */ }
  await close();
}
out.failures = failures;
console.log(JSON.stringify(out, null, 2));

process.exitCode = failures.length > 0 || out.fatal ? 1 : 0;
