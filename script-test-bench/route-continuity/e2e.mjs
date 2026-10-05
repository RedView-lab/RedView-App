// Aucune ligne droite dans la vraie application (Edge headless + CDP, compte démo).
// Nécessite `npm run dev` (port 5173) et BRouter joignable par /api/brouter.
//
//   node script-test-bench/route-continuity/e2e.mjs
//
// Vrai clic droit sur la carte → « Démarrer ici » / « Finir ici » sur le tracé
// (rognage : aucun appel BRouter, coupe exacte), puis hors du tracé (patch
// routé), annuler / rétablir et réouverture (aucun recalcul). Après chaque
// étape, chaque pas du tracé stocké doit suivre une géométrie réelle — le
// tracé précédent ou une réponse de /api/brouter — à 20 m près, sauf des
// jonctions de moins de 25 m.
import { launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const APP = 'http://localhost:5173';
const out = { steps: {}, errors: [], brouter: 0 };
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
  const fiberOf = () => {
    const el = document.querySelector('.mapboxgl-map');
    const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber'));
    return key ? el[key] : null;
  };
  window.__rvStore = () => {
    for (let f = fiberOf(); f; f = f.return) {
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && typeof v.setProject === 'function' && v.project && 'derivedComputeGate' in v) return v;
    }
    return null;
  };
  window.__rvMap = () => {
    for (let f = fiberOf(); f; f = f.return) {
      for (let h = f.memoizedState; h && typeof h === 'object'; h = h.next) {
        const v = h.memoizedState;
        if (v && v.current && typeof v.current.getCanvas === 'function') return v.current;
      }
    }
    return null;
  };
})()`;

const store = (expr) => `(() => { const s = window.__rvStore(); return ${expr}; })()`;
const routePoints = () => store(`s.project.itineraries.find((it) => it.id === s.project.activeItineraryId).gpxRoute.points.map((p) => ({ lat: p.lat, lon: p.lon }))`);
const activeRow = (kind) => store(`(() => { const r = s.project.itineraries.find((it) => it.id === s.project.activeItineraryId).timeline.find((row) => row.kind === '${kind}'); return { lat: r.lat, lon: r.lon, label: r.label }; })()`);

const R = 6_371_008.8;
function hav(a, b) {
  const t = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * t) / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(((b.lon - a.lon) * t) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function distToSegmentM(p, a, b) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * k;
  const dy = b.lat - a.lat;
  const px = (p.lon - a.lon) * k;
  const py = p.lat - a.lat;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len)) : 0;
  return Math.hypot(px - t * dx, py - t * dy) * 111_195;
}
/** Pas de `points` qui s'écartent de plus de 20 m de toute géométrie `sources`. */
function inventedLines(points, sources) {
  const segments = sources.flatMap((line) => line.slice(1).map((b, i) => [line[i], b]));
  const near = (p) => segments.some(([a, b]) => distToSegmentM(p, a, b) <= 20);
  const bad = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const stepM = hav(a, b);
    if (stepM <= 25) continue;
    const samples = Math.ceil(stepM / 20);
    for (let s = 0; s <= samples; s += 1) {
      const f = s / samples;
      if (!near({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f })) {
        bad.push({ index: i, stepM: Math.round(stepM) });
        break;
      }
    }
  }
  return bad;
}
function pointAlong(points, fraction) {
  let total = 0;
  const cumulative = points.map((p, i) => (total += i ? hav(points[i - 1], p) : 0));
  const target = total * fraction;
  const i = Math.max(1, cumulative.findIndex((d) => d >= target));
  const f = (target - cumulative[i - 1]) / Math.max(1e-9, cumulative[i] - cumulative[i - 1]);
  return { lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * f, lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * f };
}

const { session, close } = await launch({ port: 9383 });
/** Géométries renvoyées par /api/brouter (sources légitimes d'un tracé). */
const brouterGeometries = [];
try {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Network.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const brouterRequests = new Set();
  session.on('Network.requestWillBeSent', (p) => {
    const url = new URL(p.request.url);
    if (url.pathname.startsWith('/api/brouter') && p.request.method === 'GET') {
      out.brouter += 1;
      brouterRequests.add(p.requestId);
    }
  });
  session.on('Network.loadingFinished', async (p) => {
    if (!brouterRequests.has(p.requestId)) return;
    try {
      const { body, base64Encoded } = await session.send('Network.getResponseBody', { requestId: p.requestId });
      const json = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body);
      const coordinates = json?.features?.[0]?.geometry?.coordinates;
      if (Array.isArray(coordinates)) brouterGeometries.push(coordinates.map(([lon, lat]) => ({ lat, lon })));
    } catch {
      /* corps indisponible : requête annulée */
    }
  });
  session.on('Runtime.exceptionThrown', (p) => out.errors.push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  session.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error' && !/Stripe|sprite-storm|SW %c|gpx-loader|not authorized|appwrite/i.test(text)) out.errors.push(`console.error: ${text.slice(0, 300)}`);
  });

  const demoLogin = async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (await session.evaluate(`!!document.querySelector('.mapboxgl-canvas') || [...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) return;
      await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
      await sleep(6000);
    }
  };

  /** Vrai clic droit au point `at` puis clic sur l'action `label` du menu. */
  const contextAction = async (at, label) => {
    // Point amené sous une zone de carte libre (la carte passe sous les panneaux).
    await session.evaluate(`(() => {
      const map = window.__rvMap();
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      let free = null;
      for (let fy = 0.3; fy <= 0.7 && !free; fy += 0.05) {
        for (let fx = 0.35; fx <= 0.65 && !free; fx += 0.05) {
          const x = rect.left + rect.width * fx;
          const y = rect.top + rect.height * fy;
          if (document.elementFromPoint(x, y) === canvas) free = { x, y };
        }
      }
      map.jumpTo({ center: [${at.lon}, ${at.lat}], zoom: 15, pitch: 0, bearing: 0 });
      const c = map.project([${at.lon}, ${at.lat}]);
      if (free) map.panBy([c.x - (free.x - rect.left), c.y - (free.y - rect.top)], { animate: false });
      return 0;
    })()`);
    await waitFor(session, `window.__rvMap().loaded() && !window.__rvMap().isMoving()`, { timeout: 30000 }).catch(() => null);
    await sleep(1200);
    const screen = await session.evaluate(`(() => {
      const map = window.__rvMap();
      const rect = map.getCanvas().getBoundingClientRect();
      const px = map.project([${at.lon}, ${at.lat}]);
      return { x: rect.left + px.x, y: rect.top + px.y, free: document.elementFromPoint(rect.left + px.x, rect.top + px.y) === map.getCanvas() };
    })()`);
    if (!screen.free) throw new Error(`no free map area to right-click (${label})`);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: screen.x, y: screen.y });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: screen.x, y: screen.y, button: 'right', clickCount: 1 });
    await sleep(60);
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: screen.x, y: screen.y, button: 'right', clickCount: 1 });
    await waitFor(session, `[...document.querySelectorAll('button, [role=menuitem]')].some((b) => b.textContent.trim().includes(${JSON.stringify(label)}))`, { timeout: 8000 });
    await session.evaluate(`[...document.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent.trim().includes(${JSON.stringify(label)})).click()`);
  };

  await session.send('Page.navigate', { url: `${APP}/` });
  await waitFor(session, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(3000);
  await demoLogin();
  await waitFor(session, `[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`, { timeout: 90000 });
  await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore() && !!window.__rvMap()`, { timeout: 90000 });
  await sleep(1500);

  // Tracé BRouter Grenoble → Chambéry.
  await session.evaluate(store(`s.addItinerary()`));
  await sleep(400);
  await session.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => ({
    ...it,
    timeline: it.timeline.map((row) => row.kind === 'start' ? { ...row, label: 'Grenoble', lat: 45.1885, lon: 5.7245 }
      : row.kind === 'end' ? { ...row, label: 'Chambéry', lat: 45.5646, lon: 5.9178 } : row),
  })) })), 0)`));
  await waitFor(session, store(`(s.project.itineraries[0]?.gpxRoute?.points?.length ?? 0) > 50`), { timeout: 90000 });
  await sleep(4000); // affinage altimétrique éventuel
  const base = await session.evaluate(routePoints());
  check(base.length > 50, `tracé initial routé (${base.length} points, ${out.brouter} appel(s))`);

  // 1. « Démarrer ici » sur le tracé : rognage, sans BRouter.
  let calls = out.brouter;
  const cut = pointAlong(base, 0.35);
  await contextAction(cut, 'Démarrer ici');
  await sleep(4000);
  let points = await session.evaluate(routePoints());
  let start = await session.evaluate(activeRow('start'));
  check(out.brouter === calls, `Démarrer ici sur le tracé : aucun appel BRouter (${out.brouter - calls})`);
  check(hav(points[0], cut) < 30 && hav(start, points[0]) < 1, `Démarrer ici : le tracé part du point (${Math.round(hav(points[0], cut))} m)`);
  check(inventedLines(points, [base]).length === 0, 'Démarrer ici : aucune ligne droite');
  check(points.length < base.length, `Démarrer ici : tracé rogné (${base.length} → ${points.length} points)`);

  // Annuler / rétablir : aucun recalcul.
  calls = out.brouter;
  await session.evaluate(store(`(s.undoTraceEdit(), 0)`));
  await sleep(3000);
  const undone = await session.evaluate(routePoints());
  await session.evaluate(store(`(s.redoTraceEdit(), 0)`));
  await sleep(3000);
  const redone = await session.evaluate(routePoints());
  check(undone.length === base.length && redone.length === points.length, 'annuler / rétablir le rognage');
  check(out.brouter === calls, `annuler / rétablir : aucun appel BRouter (${out.brouter - calls})`);

  // 2. « Démarrer ici » hors du tracé (1,5 km) : patch routé, sans ligne droite.
  const cropped = points;
  const geometriesBefore = brouterGeometries.length;
  const off = pointAlong(cropped, 0.15);
  off.lon += 1_500 / (111_320 * Math.cos((off.lat * Math.PI) / 180));
  calls = out.brouter;
  await contextAction(off, 'Démarrer ici');
  await waitFor(session, store(`(() => { const it = s.project.itineraries[0]; return !it.pendingRoutePatch && it.gpxRoute.points.length !== ${cropped.length}; })()`), { timeout: 90000 }).catch(() => null);
  await sleep(3000);
  points = await session.evaluate(routePoints());
  start = await session.evaluate(activeRow('start'));
  const lines = inventedLines(points, [cropped, ...brouterGeometries.slice(geometriesBefore)]);
  check(out.brouter > calls, `Démarrer ici hors du tracé : routé (${out.brouter - calls} appel(s))`);
  check(lines.length === 0, `Démarrer ici hors du tracé : aucune ligne droite${lines.length ? ` ${JSON.stringify(lines.slice(0, 3))}` : ''}`);
  check(hav(points[0], start) < 300, `Démarrer ici hors du tracé : le tracé part du nouveau départ (${Math.round(hav(points[0], start))} m)`);

  // 3. « Finir ici » sur le tracé : rognage.
  const beforeEnd = points;
  calls = out.brouter;
  const endCut = pointAlong(beforeEnd, 0.6);
  await contextAction(endCut, 'Finir ici');
  await sleep(4000);
  points = await session.evaluate(routePoints());
  const end = await session.evaluate(activeRow('end'));
  check(out.brouter === calls, `Finir ici sur le tracé : aucun appel BRouter (${out.brouter - calls})`);
  check(hav(points[points.length - 1], endCut) < 30 && hav(end, points[points.length - 1]) < 1, 'Finir ici : le tracé finit au point');
  check(inventedLines(points, [beforeEnd]).length === 0, 'Finir ici : aucune ligne droite');

  // 4. Viewer LiDAR : point du tracé déplacé de 800 m (son éditeur à main
  // levée y dessine deux segments droits). Message identique à celui du viewer.
  const beforeViewer = points;
  const viewerGeometries = brouterGeometries.length;
  calls = out.brouter;
  const routeId = await session.evaluate(store(`s.project.activeItineraryId`));
  const moved = Math.floor(beforeViewer.length / 2);
  const dragged = beforeViewer.map((p, i) => (i === moved
    ? { lat: p.lat, lon: p.lon + 800 / (111_320 * Math.cos((p.lat * Math.PI) / 180)) }
    : p));
  await session.evaluate(`(() => {
    const channel = new BroadcastChannel('redview:lidar:route_overlay');
    channel.postMessage({ type: 'UPDATE_ROUTE_POINTS', version: 1, updatedAt: new Date().toISOString(), source: 'lidar_viewer',
      routeId: ${JSON.stringify(routeId)}, points: ${JSON.stringify(dragged)}, actionName: 'move_point' });
    channel.close();
    return 0;
  })()`);
  await waitFor(session, store(`(() => { const it = s.project.itineraries[0]; return !it.pendingRoutePatch && it.gpxRoute.points.length !== ${beforeViewer.length}; })()`), { timeout: 90000 }).catch(() => null);
  await sleep(3000);
  points = await session.evaluate(routePoints());
  const viewerLines = inventedLines(points, [beforeViewer, ...brouterGeometries.slice(viewerGeometries)]);
  check(out.brouter > calls, `viewer LiDAR, point déplacé : recalcul local (${out.brouter - calls} appel(s))`);
  check(viewerLines.length === 0, `viewer LiDAR, point déplacé : aucune ligne droite${viewerLines.length ? ` ${JSON.stringify(viewerLines.slice(0, 3))}` : ''}`);
  check(
    await session.evaluate(store(`s.project.itineraries[0].gpxRoute.source === 'brouter' && s.project.itineraries[0].timeline.some((row) => row.kind === 'waypoint' && !row.onRoute)`)),
    'viewer LiDAR, point déplacé : étape ajoutée, tracé routé',
  );

  // 5. Réouverture : le tracé rogné fait foi.
  await sleep(6000); // sauvegarde locale
  calls = out.brouter;
  await session.send('Page.reload');
  await sleep(4000);
  await demoLogin();
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore()`, { timeout: 120000 });
  await sleep(8000);
  const reopened = await session.evaluate(routePoints());
  check(reopened.length === points.length, 'réouverture : tracé rogné enregistré');
  check(out.brouter === calls, `réouverture : aucun appel BRouter (${out.brouter - calls})`);
} catch (error) {
  out.fatal = String(error?.stack ?? error);
} finally {
  await close();
}
out.failures = failures;
console.log(JSON.stringify(out, null, 2));
process.exitCode = failures.length > 0 || out.fatal ? 1 : 0;
