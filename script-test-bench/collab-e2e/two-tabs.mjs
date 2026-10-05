// E2E co-édition entre deux onglets (vraie app, `npm run dev`, compte démo,
// transport BroadcastChannel `?collab=local`). Compte les appels BRouter de
// chaque onglet : seul l'auteur d'une modification doit router.
import { launch, connect, sleep, waitFor } from '../screen-audit/cdp.mjs';

const PORT = 9371;
const APP = 'http://localhost:5173';
const out = { steps: {}, errors: { A: [], B: [] }, brouter: { A: [], B: [] }, collabLogs: { A: [], B: [] } };
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

const store = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;

const { session: A, close } = await launch({ port: PORT });
let B = null;
try {
  await preparePage(A, 'A');
  await A.send('Page.navigate', { url: `${APP}/?collab=local` });
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
  await B.send('Page.navigate', { url: `${APP}${projectUrl}?collab=local` });
  await sleep(4000);
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await B.evaluate(`!!document.querySelector('.mapboxgl-canvas')`)) break;
    if (await B.evaluate(`[...document.querySelectorAll('button')].some(b => /Demo account|compte démo/i.test(b.textContent))`)) {
      await B.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    }
    await sleep(6000);
  }
  out.steps.screenB = await B.evaluate(`({ url: location.pathname + location.search, text: document.body.innerText.slice(0, 160) })`);
  await waitFor(B, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore()`, { timeout: 120000 });
  await waitFor(B, store(`s.collabActive === true`), { timeout: 30000 });
  await waitFor(A, store(`s.collabActive === true`), { timeout: 30000 });
  await sleep(4000);
  check(out.collabLogs.A.length > 0 && out.collabLogs.B.length > 0, 'les deux onglets ont une session');
  check(
    await B.evaluate(store(`(s.project.itineraries[0]?.gpxRoute?.points?.length ?? 0) > 10`)),
    'B ouvre le projet : itinéraire et tracé présents',
  );
  check(out.brouter.B.length === 0, `B à l'ouverture : aucun appel BRouter (${out.brouter.B.length})`);

  // 1. Renommage par A → B.
  await A.evaluate(store(`(s.setItineraryName(${JSON.stringify(itineraryId)}, 'Renommé par A'), 0)`));
  await waitFor(B, store(`s.project.itineraries[0].name === 'Renommé par A'`), { timeout: 10000 }).catch(() => null);
  check(await B.evaluate(store(`s.project.itineraries[0].name === 'Renommé par A'`)), 'renommage de A reçu par B');

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
