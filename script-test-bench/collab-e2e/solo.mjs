// E2E sans session (comportement de production aujourd'hui) : routage,
// annuler/rétablir par instantanés, réouverture sans recalcul (estampilles du
// tracé et de la prédiction).
import { launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const APP = process.env.APP_URL ?? 'http://localhost:5173';
const out = { steps: {}, errors: [], brouter: [] };
const failures = [];
const check = (condition, label) => {
  out.steps[label] = condition ? 'ok' : 'FAILED';
  if (!condition) failures.push(label);
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
  // Calculs de prédiction : messages envoyés au worker du moteur.
  window.__rvPredictionRuns = 0;
  const RealWorker = window.Worker;
  window.Worker = function (url, options) {
    const worker = new RealWorker(url, options);
    if (String(url).includes('fitPredictor')) {
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => {
        if (message && /predict/i.test(String(message.type ?? ''))) window.__rvPredictionRuns += 1;
        return post(message, transfer);
      };
    }
    return worker;
  };
  window.Worker.prototype = RealWorker.prototype;
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
const brouterCount = () => out.brouter.length;

async function demoLogin(session) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await session.evaluate(`!!document.querySelector('.mapboxgl-canvas') || [...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) return;
    if (await session.evaluate(`[...document.querySelectorAll('button')].some(b => /Demo account|compte démo/i.test(b.textContent))`)) {
      await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    }
    await sleep(6000);
  }
}

const { session, close } = await launch({ port: 9373 });
try {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Network.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  session.on('Network.requestWillBeSent', (p) => {
    if (new URL(p.request.url).pathname.startsWith('/api/brouter')) out.brouter.push(`${p.request.method} ${p.request.url.slice(0, 100)}`);
  });
  session.on('Runtime.exceptionThrown', (p) => out.errors.push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  session.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error' && !/Stripe|sprite-storm|SW %c|gpx-loader/.test(text)) out.errors.push(`console.error: ${text.slice(0, 300)}`);
  });

  await session.send('Page.navigate', { url: `${APP}/` });
  await waitFor(session, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(3000);
  await demoLogin(session);
  await waitFor(session, `[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`, { timeout: 90000 });
  await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore()`, { timeout: 90000 });
  await sleep(1500);
  check(await session.evaluate(store(`s.collabActive === false`)), 'sans ?collab : pas de session');

  const id = await session.evaluate(store(`s.addItinerary()`));
  await sleep(400);
  await session.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => ({
    ...it,
    rhythmConfigured: true,
    timeline: it.timeline.map((row) => row.kind === 'start' ? { ...row, label: 'Chamonix', lat: 45.9237, lon: 6.8694 }
      : row.kind === 'end' ? { ...row, label: 'Argentière', lat: 45.9822, lon: 6.9277 } : row),
  })) })), 0)`));
  await waitFor(session, store(`(s.project.itineraries[0]?.gpxRoute?.points?.length ?? 0) > 10`), { timeout: 60000 });
  const stamp1 = await session.evaluate(store(`s.project.itineraries[0].gpxRoute.routedInputsKey`));
  check(brouterCount() >= 1, `tracé initial routé (${brouterCount()} appel(s))`);

  // Prédiction automatique, estampillée.
  await waitFor(session, store(`!!s.project.itineraries[0].prediction && !!s.project.itineraries[0].predictionInputsKey`), { timeout: 90000 }).catch(() => null);
  const prediction1 = await session.evaluate(store(`({ key: s.project.itineraries[0].predictionInputsKey ?? null, time: s.project.itineraries[0].prediction?.total_time_s ?? null })`));
  check(prediction1.key !== null && prediction1.time !== null, 'prédiction automatique calculée et estampillée');

  // Déplacement de l'arrivée, annuler, rétablir (instantanés).
  let before = brouterCount();
  await session.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => ({
    ...it,
    timeline: it.timeline.map((row) => row.kind === 'end' ? { ...row, label: 'Le Tour', lat: 46.0024, lon: 6.9416 } : row),
  })) })), 0)`));
  await waitFor(session, store(`s.project.itineraries[0].gpxRoute.routedInputsKey !== ${JSON.stringify(stamp1)}`), { timeout: 60000 });
  const stamp2 = await session.evaluate(store(`s.project.itineraries[0].gpxRoute.routedInputsKey`));
  check(brouterCount() > before, 'déplacement : routé');
  await sleep(2500);
  before = brouterCount();
  await session.evaluate(store(`(s.undoTraceEdit(), 0)`));
  await sleep(3500);
  check(
    await session.evaluate(store(`s.project.itineraries[0].gpxRoute.routedInputsKey === ${JSON.stringify(stamp1)} && s.project.itineraries[0].timeline.find((r) => r.kind === 'end').lat === 45.9822`)),
    'annuler : point et tracé d’avant',
  );
  await session.evaluate(store(`(s.redoTraceEdit(), 0)`));
  await sleep(3500);
  check(
    await session.evaluate(store(`s.project.itineraries[0].gpxRoute.routedInputsKey === ${JSON.stringify(stamp2)}`)),
    'rétablir : nouveau tracé',
  );
  check(brouterCount() === before, `annuler / rétablir : aucun appel BRouter (${brouterCount() - before})`);

  // Prédiction recalculée pour le nouveau tracé, puis réouverture.
  await waitFor(session, store(`s.project.itineraries[0].predictionInputsKey !== ${JSON.stringify(prediction1.key)}`), { timeout: 90000 }).catch(() => null);
  const prediction2 = await session.evaluate(store(`({ key: s.project.itineraries[0].predictionInputsKey ?? null, time: s.project.itineraries[0].prediction?.total_time_s ?? null })`));
  check(prediction2.key !== prediction1.key, 'tracé changé : prédiction recalculée (nouvelle estampille)');
  await sleep(6000); // sauvegarde locale
  const runsBeforeReload = await session.evaluate(`window.__rvPredictionRuns`);
  out.steps.predictionRunsBeforeReload = runsBeforeReload;
  before = brouterCount();
  await session.send('Page.reload');
  await sleep(4000);
  await demoLogin(session);
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore()`, { timeout: 120000 });
  await sleep(10000);
  const reopened = await session.evaluate(store(`({
    stamp: s.project.itineraries[0]?.gpxRoute?.routedInputsKey ?? null,
    predictionKey: s.project.itineraries[0]?.predictionInputsKey ?? null,
    time: s.project.itineraries[0]?.prediction?.total_time_s ?? null,
  })`));
  out.steps.reopened = reopened;
  check(reopened.stamp === stamp2, 'réouverture : tracé enregistré');
  check(brouterCount() === before, `réouverture : aucun appel BRouter (${brouterCount() - before})`);
  check(
    reopened.predictionKey === prediction2.key && reopened.time === prediction2.time,
    'réouverture : prédiction enregistrée',
  );
  check(await session.evaluate(`window.__rvPredictionRuns === 0`), 'réouverture : prédiction non recalculée (estampille à jour)');
  out.steps.itineraryId = id;
} catch (error) {
  out.fatal = String(error?.stack ?? error);
} finally {
  await close();
}
out.failures = failures;
console.log(JSON.stringify(out, null, 2));

process.exitCode = failures.length > 0 || out.fatal ? 1 : 0;
