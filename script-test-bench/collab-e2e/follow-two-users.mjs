// Présence en direct à deux utilisateurs (vraie app, `?collab=server&devUser=…`) :
// suivre la vue d'un éditeur en cliquant sa pastille (mode observation de
// Figma), cadrage contain sur deux tailles d'écran, retard et fluidité du
// suivi pendant un mouvement continu, curseur sur la carte posé là où il
// pointe, survol de la trace partagé (point sur la carte, ligne sur le
// graphique), itinéraire actif suivi, arrêt par un geste ou Échap, Spotlight
// (« Pas maintenant », suivi automatique, fin de présentation).
//
// Deux FENÊTRES (pas deux onglets) : un onglet en arrière-plan n'a plus
// d'images (rAF) et ses minuteurs sont ralentis — ni l'émetteur ni le suivi
// ne tourneraient. Nécessite `npm run dev` avec un serveur temps réel à jour
// (APP_URL, défaut 5173).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', 'reports', 'follow-e2e');
mkdirSync(SHOTS, { recursive: true });
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const PORT = 9391;
const SIZES = { A: { width: 1600, height: 900 }, B: { width: 1280, height: 800 } };
const out = { steps: {}, errors: { A: [], B: [] }, metrics: {} };
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
  // Caméra de la carte : centre, zoom, cap, inclinaison (horodatage commun aux deux fenêtres).
  window.__rvCam = () => {
    const m = window.__rvMap();
    const c = m.getCenter();
    return { t: performance.timeOrigin + performance.now(), lng: c.lng, lat: c.lat, zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() };
  };
})()`;

const store = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;
const ONLINE = `!!document.querySelector('[data-rv-collab-status="online"]')`;
const BANNER_TEXT = `(document.querySelector('.rv-following-banner')?.textContent ?? '')`;

async function prepare(session, name) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  await session.send('Emulation.setDeviceMetricsOverride', { ...SIZES[name], deviceScaleFactor: 1, mobile: false });
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => null);
  session.on('Runtime.exceptionThrown', (p) => out.errors[name].push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  session.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
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

async function mouse(session, type, x, y, { button = 'left', deltaY = 0 } = {}) {
  await session.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, deltaX: 0, deltaY });
}
async function click(session, x, y) {
  await mouse(session, 'mouseMoved', x, y, { button: 'none' });
  await mouse(session, 'mousePressed', x, y);
  await mouse(session, 'mouseReleased', x, y);
}
async function center(session, selectorExpr) {
  return session.evaluate(`(() => { const e = ${selectorExpr}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
async function key(session, keyName, { code, text } = {}) {
  const params = { key: keyName, code: code ?? keyName, windowsVirtualKeyCode: keyName === 'Escape' ? 27 : keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0 };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  if (text) await session.send('Input.dispatchKeyEvent', { type: 'char', text, ...params });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}
async function shot(session, name) {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

/** Zones visibles et cadrage contain attendu (même calcul que livePresence/lib/followCamera.ts). */
const VIEW_PROBE = `(async () => {
  const { getMapOverlayInsets } = await import('/src/features/map3d/lib/mapOverlayInsets.ts');
  const m = window.__rvMap();
  const c = m.getContainer();
  return { width: c.clientWidth, height: c.clientHeight, insets: getMapOverlayInsets(m) };
})()`;
/** Centre de la zone visible de la carte (hors panneaux), en px de la page. */
function visibleCenter({ width, height, insets }) {
  return { x: insets.left + (width - insets.left - insets.right) / 2, y: insets.top + (height - insets.top - insets.bottom) / 2 };
}
function visibleRect({ width, height, insets }) {
  const w = width - insets.left - insets.right;
  const h = height - insets.top - insets.bottom;
  return { width: w >= width * 0.25 ? w : width, height: h >= height * 0.25 ? h : height };
}

/** Itinéraire de test : Chamonix → Argentière, 240 points, distances cumulées. */
function testRoute() {
  const from = [6.8694, 45.9237];
  const to = [6.9277, 45.9822];
  const points = [];
  let distanceM = 0;
  for (let index = 0; index < 240; index += 1) {
    const t = index / 239;
    const lon = from[0] + (to[0] - from[0]) * t + 0.004 * Math.sin(t * Math.PI * 6);
    const lat = from[1] + (to[1] - from[1]) * t;
    if (index > 0) {
      const previous = points[index - 1];
      const dx = (lon - previous.lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
      const dy = (lat - previous.lat) * 110_574;
      distanceM += Math.hypot(dx, dy);
    }
    points.push({ lat, lon, distanceM: Math.round(distanceM * 10) / 10, elevationM: 1035 + 220 * t });
  }
  return { name: 'Test suivi', source: 'gpx', points };
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
  const route = testRoute();
  // Un projet neuf n'a pas d'itinéraire : on en crée un, avec un tracé importé (sans BRouter).
  const firstId = await A.evaluate(store(`s.project.itineraries[0]?.id ?? s.addItinerary()`));
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, activeItineraryId: ${JSON.stringify(firstId)}, itineraries: p.itineraries.map((it) => it.id === ${JSON.stringify(firstId)} ? { ...it, gpxRoute: ${JSON.stringify(route)} } : it) })), 0)`));
  await sleep(1500);
  await A.evaluate(`(window.__rvMap().jumpTo({ center: [6.90, 45.95], zoom: 13, pitch: 50, bearing: 10 }), 0)`);
  await sleep(1500);
  const projectUrl = await A.evaluate(`location.pathname`);

  // B (bob) : une autre fenêtre, plus petite.
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  B = await connect(targets.find((t) => t.id === targetId).webSocketDebuggerUrl);
  await prepare(B, 'B');
  await B.send('Page.navigate', { url: `${APP}${projectUrl}?collab=server&devUser=bob` });
  await sleep(4000);
  await demoLogin(B);
  await waitFor(B, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore?.() && !!window.__rvMap?.()`, { timeout: 120000 });
  await waitFor(B, ONLINE, { timeout: 30000 });
  await sleep(2500);
  check(await B.evaluate(`document.visibilityState === 'visible'`) && await A.evaluate(`document.visibilityState === 'visible'`), 'deux fenêtres visibles');
  // Vue de départ de B ailleurs (même compte démo : même vue enregistrée).
  await B.evaluate(`(window.__rvMap().jumpTo({ center: [6.2, 45.5], zoom: 9, pitch: 0, bearing: 0 }), 0)`);
  await sleep(1500);

  // ── B clique la pastille d'alice : il suit sa vue.
  const aliceButton = `[...document.querySelectorAll('.rvi-header__people .rv-avatar-stack__person--button')].find((b) => b.getBoundingClientRect().width > 0 && /alice/.test(b.getAttribute('aria-label') ?? ''))`;
  await waitFor(B, `!!${aliceButton}`, { timeout: 15000 });
  const aliceAt = await center(B, aliceButton);
  await click(B, aliceAt.x, aliceAt.y);
  await waitFor(B, `${BANNER_TEXT}.includes('alice')`, { timeout: 5000 });
  check(true, 'B : bandeau « Vous suivez alice »');
  check(await B.evaluate(`!!document.querySelector('.rv-following-frame')`), 'B : cadre de la couleur d’alice autour de la carte');
  check(await B.evaluate(`${aliceButton}?.getAttribute('aria-pressed') === 'true'`), 'B : pastille d’alice marquée suivie');
  await waitFor(A, `[...document.querySelectorAll('.rvi-header__people [title]')].some((e) => /bob.*(vous suit|following you)/.test(e.title))`, { timeout: 5000 })
    .then(() => check(true, 'A : sait que bob la suit'), () => check(false, 'A : sait que bob la suit'));

  // Approche (vol) puis caméra d'alice : même centre, cap, inclinaison ; zoom contain.
  await sleep(3500);
  const camA = await A.evaluate(`window.__rvCam()`);
  const viewA = await A.evaluate(VIEW_PROBE);
  const viewB = await B.evaluate(VIEW_PROBE);
  const rectA = visibleRect(viewA);
  const rectB = visibleRect(viewB);
  const expectedZoom = camA.zoom + Math.log2(Math.min(rectB.width / rectA.width, rectB.height / rectA.height));
  const camB = await B.evaluate(`window.__rvCam()`);
  out.metrics.contain = { camA, camB, expectedZoom, rectA, rectB };
  check(Math.abs(camB.lng - camA.lng) < 1e-5 && Math.abs(camB.lat - camA.lat) < 1e-5, `B : même centre qu’alice (${camB.lng.toFixed(5)}, ${camB.lat.toFixed(5)})`);
  check(Math.abs(camB.bearing - camA.bearing) < 0.05 && Math.abs(camB.pitch - camA.pitch) < 0.05, 'B : même cap et même inclinaison');
  check(Math.abs(camB.zoom - expectedZoom) < 0.01, `B : zoom contain ${camB.zoom.toFixed(3)} (attendu ${expectedZoom.toFixed(3)})`);
  await shot(B, '01-bob-follows-alice');

  // ── Mouvement continu chez A (3 s, une caméra par image) ; trajectoire de B relevée à chaque image.
  await B.evaluate(`(() => { window.__trace = []; const tick = () => { window.__trace.push(window.__rvCam()); if (window.__trace.length < 600) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return 0; })()`);
  const pathA = await A.evaluate(`new Promise((resolve) => {
    const m = window.__rvMap();
    const start = performance.now();
    const trace = [];
    const step = () => {
      const t = (performance.now() - start) / 3000;
      m.jumpTo({ center: [6.90 + 0.05 * Math.min(1, t), 45.95 + 0.02 * Math.min(1, t)], bearing: 10 + 40 * Math.min(1, t), zoom: 13, pitch: 50 });
      trace.push(window.__rvCam());
      if (t < 1) requestAnimationFrame(step); else resolve(trace);
    };
    requestAnimationFrame(step);
  })`);
  await sleep(1500);
  const pathB = await B.evaluate(`window.__trace`);
  // Retard : le décalage qui aligne le mieux la trajectoire de B sur celle de A.
  const lngAt = (trace, t) => {
    if (t <= trace[0].t) return trace[0].lng;
    for (let i = 1; i < trace.length; i += 1) {
      if (trace[i].t >= t) {
        const a = trace[i - 1];
        const b = trace[i];
        return a.lng + (b.lng - a.lng) * ((t - a.t) / Math.max(1e-6, b.t - a.t));
      }
    }
    return trace[trace.length - 1].lng;
  };
  const moving = pathB.filter((p) => p.t > pathA[0].t + 400 && p.t < pathA[pathA.length - 1].t);
  let best = { lag: 0, error: Infinity };
  for (let lag = 0; lag <= 500; lag += 5) {
    let sum = 0;
    for (const p of moving) sum += (p.lng - lngAt(pathA, p.t - lag)) ** 2;
    const error = Math.sqrt(sum / Math.max(1, moving.length));
    if (error < best.error) best = { lag, error };
  }
  let backwards = 0;
  for (let i = 1; i < pathB.length; i += 1) if (pathB[i].lng < pathB[i - 1].lng - 1e-9) backwards += 1;
  const finalA = pathA[pathA.length - 1];
  const finalB = await B.evaluate(`window.__rvCam()`);
  // Écart résiduel exprimé en temps (vitesse du panoramique : 0,05° en 3 s) : la gigue du suivi.
  const jitterMs = best.error / (0.05 / 3000);
  out.metrics.motion = { frames: pathB.length, moving: moving.length, lagMs: best.lag, residualDeg: best.error, jitterMs, backwards };
  // Deux fenêtres d'un même Edge headless : images de l'émetteur irrégulières. Depuis le
  // 06/10/2026 la lecture couvre ces irrégularités (p99 de intervalle + gigue) au lieu de
  // s'affamer : 240–265 ms ici (gigue 12–30 ms), contre 145–215 ms (gigue 19–38 ms) avant.
  check(best.lag <= 300, `suivi : retard ${best.lag} ms (≤ 300)`);
  check(jitterMs < 50, `suivi : trajectoire fidèle (gigue ${jitterMs.toFixed(0)} ms, < 50)`);
  check(backwards === 0, `suivi : jamais de retour en arrière (${backwards})`);
  check(Math.abs(finalB.lng - finalA.lng) < 1e-6 && Math.abs(finalB.bearing - finalA.bearing) < 0.01, 'suivi : position finale exacte');

  // ── Curseur d'alice sur la carte de B, là où elle pointe (dans sa zone visible, hors panneaux).
  const viewA2 = await A.evaluate(VIEW_PROBE);
  const mapA = visibleCenter(viewA2);
  for (let i = 0; i <= 10; i += 1) {
    await mouse(A, 'mouseMoved', mapA.x - 100 + i * 12, mapA.y - 40 + i * 4, { button: 'none' });
    await sleep(30);
  }
  await sleep(600);
  const pointed = await A.evaluate(`(() => { const m = window.__rvMap(); const r = m.getCanvas().getBoundingClientRect(); const ll = m.unproject([${mapA.x + 20} - r.left, ${mapA.y} - r.top]); return [ll.lng, ll.lat]; })()`);
  const cursor = await B.evaluate(`(() => {
    const e = document.querySelector('.rv-peer-cursor.is-visible');
    if (!e) return null;
    const m = window.__rvMap();
    const p = m.project(${JSON.stringify(pointed)});
    const t = new DOMMatrixReadOnly(getComputedStyle(e).transform);
    return { label: e.textContent, x: t.m41, y: t.m42, expected: { x: p.x, y: p.y } };
  })()`);
  check(Boolean(cursor && /alice/.test(cursor.label)), 'B : curseur d’alice sur la carte, avec son nom');
  check(Boolean(cursor && Math.hypot(cursor.x - cursor.expected.x, cursor.y - cursor.expected.y) < 4), `B : curseur posé là où alice pointe (${cursor ? Math.hypot(cursor.x - cursor.expected.x, cursor.y - cursor.expected.y).toFixed(1) : '?'} px)`);
  await shot(B, '02-bob-sees-alice-cursor');

  // ── Survol du graphique d'analyse chez A : ligne sur le graphique de B, point sur la trace de B.
  await A.evaluate(`(window.__rvMap().jumpTo({ center: [${route.points[120].lon}, ${route.points[120].lat}], zoom: 13.2, pitch: 40, bearing: 0 }), 0)`);
  await sleep(1500);
  const plotA = await A.evaluate(`(() => { const r = document.querySelector('.rvchart__plotarea')?.getBoundingClientRect(); return r ? { x: r.left + r.width * 0.4, y: r.top + r.height * 0.5, left: r.left, width: r.width } : null; })()`);
  if (!plotA) throw new Error('graphique d’analyse absent chez alice');
  for (let i = 0; i <= 6; i += 1) {
    await mouse(A, 'mouseMoved', plotA.x - 60 + i * 10, plotA.y, { button: 'none' });
    await sleep(40);
  }
  await sleep(900);
  check(await A.evaluate(`!!document.querySelector('.rvi-analysis-hover-dot')`), 'A : survol du graphique (point sur sa trace)');
  check(await B.evaluate(`!!document.querySelector('.rv-peer-cursor-dot.is-visible')`), 'B : point survolé par alice sur la trace');
  // Même abscisse (mode distance des deux côtés, même trace) : la ligne de B à la même proportion du tracé.
  const lineB = await B.evaluate(`(() => { const e = document.querySelector('.rv-remote-chart-cursor.is-visible'); if (!e) return null; return { left: parseFloat(e.style.left), label: e.textContent }; })()`);
  const ratioA = (plotA.x - plotA.left) / plotA.width;
  check(Boolean(lineB && /alice/.test(lineB.label)), 'B : ligne d’alice sur le graphique d’analyse, avec son nom');
  check(Boolean(lineB && Math.abs(lineB.left / 100 - ratioA) < 0.01), `B : ligne à la même abscisse que le survol d’alice (${lineB ? (lineB.left / 100).toFixed(3) : '?'} / ${ratioA.toFixed(3)})`);
  await shot(B, '02c-bob-sees-alice-chart-cursor');
  // Fin du survol : la ligne disparaît chez B.
  await mouse(A, 'mouseMoved', plotA.left + plotA.width / 2, plotA.y - 400, { button: 'none' });
  await waitFor(B, `!document.querySelector('.rv-remote-chart-cursor.is-visible')`, { timeout: 3000 })
    .then(() => check(true, 'B : fin du survol d’alice → ligne retirée'), () => check(false, 'B : fin du survol d’alice → ligne retirée'));

  // ── Itinéraire actif : alice passe sur un autre itinéraire, bob aussi.
  const newId = await A.evaluate(store(`s.addItinerary()`));
  await A.evaluate(store(`(s.setProject((p) => ({ ...p, activeItineraryId: ${JSON.stringify(newId)} })), 0)`));
  await waitFor(B, store(`s.project.activeItineraryId === ${JSON.stringify(newId)}`), { timeout: 5000 })
    .then(() => check(true, 'B : passe sur l’itinéraire actif d’alice'), () => check(false, 'B : passe sur l’itinéraire actif d’alice'));
  check(await B.evaluate(`${BANNER_TEXT}.includes('alice')`), 'B : toujours en suivi après le changement d’itinéraire');

  // ── Un geste sur la carte arrête le suivi (comme Figma) : au centre de la zone visible (hors panneaux).
  const viewB2 = await B.evaluate(VIEW_PROBE);
  const mapB = {
    x: viewB2.insets.left + (viewB2.width - viewB2.insets.left - viewB2.insets.right) / 2,
    y: viewB2.insets.top + (viewB2.height - viewB2.insets.top - viewB2.insets.bottom) / 2,
  };
  await mouse(B, 'mouseWheel', mapB.x, mapB.y, { button: 'none', deltaY: -120 });
  await waitFor(B, `!document.querySelector('.rv-following-banner')`, { timeout: 3000 })
    .then(() => check(true, 'B : molette sur la carte → suivi arrêté'), () => check(false, 'B : molette sur la carte → suivi arrêté'));

  // ── Suivre à nouveau, puis Échap.
  const again = await center(B, aliceButton);
  await click(B, again.x, again.y);
  await waitFor(B, `${BANNER_TEXT}.includes('alice')`, { timeout: 5000 });
  await sleep(800);
  await key(B, 'Escape', { code: 'Escape' });
  await waitFor(B, `!document.querySelector('.rv-following-banner')`, { timeout: 3000 })
    .then(() => check(true, 'B : Échap → suivi arrêté'), () => check(false, 'B : Échap → suivi arrêté'));

  // ── Spotlight : alice présente sa vue ; bob reçoit « Pas maintenant », puis la suit.
  const selfButton = `[...document.querySelectorAll('.rvi-header__people .rv-avatar-stack__person--button')].find((b) => b.getBoundingClientRect().width > 0 && /présenter ma vue|present my view/i.test(b.getAttribute('aria-label') ?? ''))`;
  const selfAt = await center(A, selfButton);
  await click(A, selfAt.x, selfAt.y);
  await waitFor(A, `!!document.querySelector('.rvi-collaborator-menu')`, { timeout: 3000 });
  const presentAt = await center(A, `document.querySelector('.rvi-collaborator-menu .rv-dropdown__item')`);
  await click(A, presentAt.x, presentAt.y);
  await waitFor(A, `/présentez|presenting/i.test(${BANNER_TEXT})`, { timeout: 3000 })
    .then(() => check(true, 'A : bandeau « Vous présentez votre vue »'), () => check(false, 'A : bandeau « Vous présentez votre vue »'));
  await waitFor(B, `[...document.querySelectorAll('.rv-toast')].some((t) => /alice/.test(t.textContent) && !!t.querySelector('.rv-toast__action'))`, { timeout: 5000 })
    .then(() => check(true, 'B : proposition « alice présente sa vue » avec « Pas maintenant »'), () => check(false, 'B : proposition « alice présente sa vue » avec « Pas maintenant »'));
  await waitFor(B, `${BANNER_TEXT}.includes('alice')`, { timeout: 6000 })
    .then(() => check(true, 'B : suit alice au bout du compte à rebours'), () => check(false, 'B : suit alice au bout du compte à rebours'));
  await waitFor(A, `/1 personne|1 person/.test(${BANNER_TEXT})`, { timeout: 5000 })
    .then(() => check(true, 'A : « 1 personne vous suit »'), () => check(false, 'A : « 1 personne vous suit »'));
  await shot(A, '03-alice-presenting');
  await shot(B, '04-bob-follows-presenter');
  const stopAt = await center(A, `document.querySelector('.rv-following-banner__stop')`);
  await click(A, stopAt.x, stopAt.y);
  await waitFor(B, `!document.querySelector('.rv-following-banner')`, { timeout: 5000 })
    .then(() => check(true, 'fin de la présentation : bob ne suit plus'), () => check(false, 'fin de la présentation : bob ne suit plus'));
} catch (error) {
  console.error(error);
  out.errors.A.push(`script: ${error.stack ?? error}`);
  if (B) await shot(B, 'zz-error-B').catch(() => null);
  await shot(A, 'zz-error-A').catch(() => null);
} finally {
  await close();
  const errors = Object.values(out.errors).flat();
  console.log(JSON.stringify({ steps: out.steps, failures, errors, metrics: out.metrics }));
}

process.exitCode = failures.length > 0 ? 1 : 0;
