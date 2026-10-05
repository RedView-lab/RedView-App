// Commentaires dans la vraie application (compte démo, sans session) :
// mode commentaire (C), bulle posée au clic, réponse, réaction, survol qui
// déplie la bulle, zone (Maj + glisser), zone polygonale (sous-outil
// « zone » : un clic par sommet, clic sur un sommet = fermée sur lui,
// Échap abandonne le tracé sans quitter le mode), annuler sans effet sur les
// commentaires, Maj+C, liste du panneau droit (caméra amenée sur le fil),
// captures sombre / clair. Nécessite `npm run dev` (APP_URL, défaut 5173).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, waitFor } from '../screen-audit/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, '..', 'reports', 'comments-e2e');
mkdirSync(SHOTS, { recursive: true });
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const out = { steps: {}, errors: [] };
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

async function demoLogin(session) {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await session.evaluate(`!!document.querySelector('.mapboxgl-canvas') || [...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) return;
    if (await session.evaluate(`[...document.querySelectorAll('button')].some(b => /Demo account|compte démo/i.test(b.textContent))`)) {
      await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    }
    await sleep(5000);
  }
}

/** Centre d'un élément en px écran (CDP Input = px CSS de la fenêtre). */
async function centerOf(session, selector) {
  return session.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null; })()`);
}

async function mouse(session, type, x, y, { modifiers = 0, button = 'left', clickCount = 1 } = {}) {
  await session.send('Input.dispatchMouseEvent', { type, x, y, modifiers, button, buttons: type === 'mouseReleased' || type === 'mouseMoved' && button === 'none' ? 0 : 1, clickCount });
}

async function click(session, x, y, options) {
  await mouse(session, 'mouseMoved', x, y, { ...options, button: 'none' });
  await mouse(session, 'mousePressed', x, y, options);
  await mouse(session, 'mouseReleased', x, y, options);
}

async function key(session, keyName, { code, modifiers = 0, text } = {}) {
  const params = { key: keyName, code: code ?? keyName, modifiers, windowsVirtualKeyCode: keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : keyName === 'Enter' ? 13 : keyName === 'Escape' ? 27 : 0 };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  if (text) await session.send('Input.dispatchKeyEvent', { type: 'char', text, ...params });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function shot(session, name) {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

const { session, close } = await launch({ port: 9381 });
try {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  session.on('Runtime.exceptionThrown', (p) => out.errors.push(`exception: ${p.exceptionDetails?.exception?.description?.split('\n')[0] ?? p.exceptionDetails?.text}`));
  session.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (p.type === 'error' && !/Stripe|sprite-storm|SW %c|gpx-loader|appwrite|Appwrite|401|403|net::/.test(text)) out.errors.push(`console.error: ${text.slice(0, 300)}`);
  });

  await session.send('Page.navigate', { url: `${APP}/` });
  await waitFor(session, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(2500);
  await demoLogin(session);
  await waitFor(session, `[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`, { timeout: 90000 });
  await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!window.__rvStore() && !!window.__rvMap()`, { timeout: 90000 });
  await sleep(1500);
  // Le panneau central (et la barre d'outils) s'ouvre avec un premier tracé : on le révèle via un itinéraire.
  await session.evaluate(`(window.__rvMap().jumpTo({ center: [6.87, 45.92], zoom: 13.5, pitch: 55, bearing: 0 }), 0)`);
  await waitFor(session, `window.__rvMap().loaded() || window.__rvMap().areTilesLoaded()`, { timeout: 60000 }).catch(() => null);
  await sleep(2500);

  // Barre d'outils visible ? Sinon on ouvre le panneau central (premier tracé).
  if (!(await session.evaluate(`!!document.querySelector('.rv-comment-tool')`))) {
    await session.evaluate(store(`(s.setProject((p) => ({ ...p, itineraries: p.itineraries.map((it) => ({
      ...it,
      timeline: it.timeline.map((row) => row.kind === 'start' ? { ...row, label: 'Chamonix', lat: 45.9237, lon: 6.8694 }
        : row.kind === 'end' ? { ...row, label: 'Argentière', lat: 45.9822, lon: 6.9277 } : row),
    })) })), 0)`));
    await waitFor(session, `!!document.querySelector('.rv-comment-tool')`, { timeout: 30000 }).catch(() => null);
    await sleep(2000);
    await session.evaluate(`(window.__rvMap().jumpTo({ center: [6.89, 45.95], zoom: 13.2, pitch: 55, bearing: 0 }), 0)`);
    await sleep(2500);
  }
  check(await session.evaluate(`!!document.querySelector('.rv-comment-tool')`), 'bouton Commenter dans la barre d’outils');

  // ── Mode commentaire (touche C) ─────────────────────────────────────────
  await key(session, 'c', { code: 'KeyC', text: 'c' });
  await sleep(500);
  check(await session.evaluate(`document.querySelector('.rv-comment-tool__main')?.getAttribute('aria-pressed') === 'true'`), 'touche C : mode armé');
  check(await session.evaluate(`!!document.querySelector('.rv-comments-panel')`), 'liste à la place du panneau droit');
  check(await session.evaluate(`document.querySelector('[data-rv-region="right-panel"]')?.inert === true`), 'panneau droit inerte dessous');
  await shot(session, '01-mode');

  // ── Clic sur la carte : saisie ─────────────────────────────────────────
  const mapBox = await centerOf(session, '.mapboxgl-canvas');
  const clickX = Math.round(mapBox.x - 160);
  const clickY = Math.round(mapBox.y - 40);
  await click(session, clickX, clickY);
  await waitFor(session, `!!document.querySelector('[data-rv-comment-card="draft"] textarea')`, { timeout: 5000 }).catch(() => null);
  check(await session.evaluate(`!!document.querySelector('[data-rv-comment-card="draft"]')`), 'clic : saisie ouverte');
  check(await session.evaluate(`document.activeElement?.classList.contains('rv-comment-composer__input')`), 'saisie : focus');
  check(await session.evaluate(`!!document.querySelector('[data-rv-comment-pin="draft"]')`), 'bulle provisoire posée');
  check(await session.evaluate(`document.querySelector('.rv-comment-send')?.disabled === true`), 'envoi grisé tant que vide');
  await session.send('Input.insertText', { text: 'Col fermé l’hiver, attention au verglas' });
  await sleep(200);
  await shot(session, '02-draft');
  await key(session, 'Enter', { code: 'Enter' });
  await sleep(800);
  const thread = await session.evaluate(store(`s.project.comments?.[0] ?? null`));
  check(thread?.messages?.[0]?.text === 'Col fermé l’hiver, attention au verglas', 'Entrée : fil créé dans le document');
  check(Number.isFinite(thread?.anchor?.elevationM), `ancre sur le relief (altitude ${thread?.anchor?.elevationM})`);
  check(Boolean(thread?.camera?.pitch > 30), 'point de vue de l’auteur enregistré');
  check(await session.evaluate(`!!document.querySelector('[data-rv-comment-card]:not([data-rv-comment-card="draft"])')`), 'fil ouvert après l’envoi');
  check(await session.evaluate(`document.querySelectorAll('[data-rv-comment-pin]').length >= 1`), 'bulle sur la carte');

  // ── Réponse, réaction ───────────────────────────────────────────────────
  await session.evaluate(`document.querySelector('.rv-comment-card__reply textarea').focus()`);
  await session.send('Input.insertText', { text: 'Vu, on passe par le tunnel' });
  await key(session, 'Enter', { code: 'Enter' });
  await sleep(600);
  check(await session.evaluate(store(`s.project.comments[0].messages.length === 2`)), 'réponse ajoutée');
  await session.evaluate(`document.querySelector('.rv-comment-message .rv-comment-icon-button[aria-label="Réagir"], .rv-comment-message .rv-comment-icon-button[aria-label="React"]').click()`);
  await sleep(300);
  await session.evaluate(`[...document.querySelectorAll('.rv-comment-reactions__emoji')].find((b) => b.textContent === '👍')?.click()`);
  await sleep(400);
  check(await session.evaluate(store(`Object.keys(s.project.comments[0].messages[0].reactions ?? {}).length === 1`)), 'réaction 👍 posée');
  await shot(session, '03-thread');

  // ── Annuler : sans effet sur les commentaires ──────────────────────────
  await session.evaluate(`document.activeElement?.blur()`);
  await session.evaluate(store(`(s.undoTraceEdit(), 0)`));
  await sleep(400);
  check(await session.evaluate(store(`s.project.comments?.[0]?.messages.length === 2`)), 'annuler ne touche pas aux commentaires');

  // ── Échap ferme le fil, survol qui déplie ──────────────────────────────
  await key(session, 'Escape', { code: 'Escape' });
  await sleep(300);
  check(await session.evaluate(`!document.querySelector('[data-rv-comment-card]')`), 'Échap : fil fermé');
  const pin = await centerOf(session, `[data-rv-comment-pin="${thread.id}"]`);
  await mouse(session, 'mouseMoved', pin.x, pin.y, { button: 'none' });
  await sleep(450);
  const hovered = await centerOf(session, `[data-rv-comment-pin="${thread.id}"]`);
  check(hovered.w > pin.w + 100, `survol : la bulle se déplie (${Math.round(pin.w)} → ${Math.round(hovered.w)} px)`);
  await shot(session, '04-hover');
  await mouse(session, 'mouseMoved', mapBox.x + 300, mapBox.y + 200, { button: 'none' });
  await sleep(300);

  // ── Zone : Maj + glisser ────────────────────────────────────────────────
  const zx1 = Math.round(mapBox.x + 40);
  const zy1 = Math.round(mapBox.y - 120);
  const zx2 = Math.round(mapBox.x + 260);
  const zy2 = Math.round(mapBox.y + 20);
  const SHIFT = 8;
  await mouse(session, 'mouseMoved', zx1, zy1, { button: 'none', modifiers: SHIFT });
  await mouse(session, 'mousePressed', zx1, zy1, { modifiers: SHIFT });
  for (let step = 1; step <= 8; step++) {
    await mouse(session, 'mouseMoved', zx1 + ((zx2 - zx1) * step) / 8, zy1 + ((zy2 - zy1) * step) / 8, { modifiers: SHIFT });
    await sleep(30);
  }
  await sleep(120);
  check(await session.evaluate(`(() => { const src = window.__rvMap().getSource('rv-comment-zones'); return !!src; })()`), 'zone dessinée pendant le geste');
  await mouse(session, 'mouseReleased', zx2, zy2, { modifiers: SHIFT });
  await sleep(500);
  check(await session.evaluate(`!!document.querySelector('[data-rv-comment-card="draft"] .rv-comment-card__draft-context')`), 'Maj + glisser : saisie d’un commentaire de zone');
  await session.send('Input.insertText', { text: 'Zone d’avalanche au printemps' });
  await key(session, 'Enter', { code: 'Enter' });
  await sleep(700);
  const zoneThread = await session.evaluate(store(`s.project.comments?.[1] ?? null`));
  check((zoneThread?.zone?.ring?.length ?? 0) >= 3, `fil de zone (${zoneThread?.zone?.ring?.length ?? 0} sommets)`);
  await shot(session, '05-zone');
  await key(session, 'Escape', { code: 'Escape' });
  await sleep(200);

  // ── Liste : 2 fils, clic = caméra + fil ouvert ─────────────────────────
  check(await session.evaluate(`document.querySelectorAll('.rv-comments-panel__item').length === 2`), 'liste : 2 fils');
  const centerBefore = await session.evaluate(`window.__rvMap().getCenter().toArray()`);
  await session.evaluate(`(window.__rvMap().jumpTo({ center: [6.7, 45.85] }), 0)`);
  await sleep(300);
  await session.evaluate(`(() => { const m = window.__rvMap(); window.__moves = []; const log = (e) => window.__moves.push(e.type + ':' + m.getCenter().lng.toFixed(3) + (e.originalEvent ? ':user' : '')); m.on('movestart', log); m.on('moveend', log);
    for (const name of ['flyTo', 'easeTo', 'jumpTo', 'stop', 'setBearing', 'resize', 'panTo', 'fitBounds', 'setCenter', 'setPadding']) {
      const orig = m[name].bind(m);
      m[name] = (...args) => { window.__moves.push(name + ' <- ' + (new Error().stack.split(String.fromCharCode(10)).slice(2, 7).map((l) => l.trim().split('/src/').pop()).join(' | '))); return orig(...args); };
    }
    return 0; })()`);
  const lastItem = await session.evaluate(`(() => { const r = [...document.querySelectorAll('.rv-comments-panel__item')].at(-1).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(session, lastItem.x, lastItem.y);
  await sleep(500);
  await waitFor(session, `!window.__rvMap().isMoving()`, { timeout: 8000 }).catch(() => null);
  const centerAfter = await session.evaluate(`window.__rvMap().getCenter().toArray()`);
  console.error('moves', await session.evaluate(`JSON.stringify(window.__moves, null, 1)`), 'target', JSON.stringify((await session.evaluate(store(`s.project.comments.map((c) => [c.id, c.anchor.lng, c.camera])`)))));
  check(Math.abs(centerAfter[0] - 6.7) > 0.05, `clic dans la liste : caméra amenée (${centerBefore} → ${centerAfter})`);
  check(await session.evaluate(`!!document.querySelector('[data-rv-comment-card]:not([data-rv-comment-card="draft"])')`), 'clic dans la liste : fil ouvert');
  await key(session, 'Escape', { code: 'Escape' });
  await sleep(200);

  // ── Zone polygonale : clic par sommet, fermée sur un sommet ─────────────
  await session.evaluate(`(window.__rvMap().jumpTo({ center: [6.96, 45.975], zoom: 14, pitch: 50, bearing: 0 }), 0)`);
  await sleep(2500);
  const zoneFeatures = (filter) => session.evaluate(`(() => {
    const data = window.__rvMap().getSource('rv-comment-zones')?.serialize?.().data;
    return (data?.features ?? []).filter((f) => ${filter}).length;
  })()`);
  const chevron = await centerOf(session, '.rv-comment-tool__chevron');
  await click(session, chevron.x, chevron.y);
  await sleep(300);
  await session.evaluate(`[...document.querySelectorAll('.rv-dropdown__item')].find((b) => /Commentaire de zone|Area comment/.test(b.textContent))?.click()`);
  await sleep(300);
  const vertices = [[-220, 110], [-40, -90], [170, 10], [30, 190]].map(([dx, dy]) => ({ x: Math.round(mapBox.x + dx), y: Math.round(mapBox.y + dy) }));
  for (const vertex of vertices) {
    await click(session, vertex.x, vertex.y);
    await sleep(450);
  }
  check(await zoneFeatures(`f.properties?.vertex === 1`) === 4, 'zone polygonale : 4 sommets posés au clic');
  check(await session.evaluate(`!document.querySelector('[data-rv-comment-card="draft"]')`), 'zone polygonale : pas de saisie avant la fermeture');
  await mouse(session, 'mouseMoved', vertices[1].x + 2, vertices[1].y + 1, { button: 'none' });
  await sleep(300);
  check(await zoneFeatures(`f.properties?.close === 1`) === 1, 'survol d’un sommet : fermeture prévisualisée');
  await shot(session, '05b-polygon-close');
  await click(session, vertices[1].x + 2, vertices[1].y + 1);
  await sleep(500);
  check(await session.evaluate(`!!document.querySelector('[data-rv-comment-card="draft"] .rv-comment-card__draft-context')`), 'clic sur un sommet : saisie d’un commentaire de zone');
  check(await zoneFeatures(`f.properties?.vertex === 1`) === 0, 'tracé terminé : plus de sommets');
  await session.send('Input.insertText', { text: 'Pierrier instable' });
  await key(session, 'Enter', { code: 'Enter' });
  await sleep(700);
  const polygonThread = await session.evaluate(store(`s.project.comments?.find((c) => c.messages[0]?.text === 'Pierrier instable') ?? null`));
  check(polygonThread?.zone?.ring?.length === 3, `fermée sur le 2e sommet : boucle 2-3-4 (${polygonThread?.zone?.ring?.length ?? 0} sommets)`);
  await key(session, 'Escape', { code: 'Escape' });
  await sleep(200);
  for (const vertex of vertices.slice(0, 2)) {
    await click(session, vertex.x, vertex.y);
    await sleep(450);
  }
  check(await zoneFeatures(`f.properties?.vertex === 1`) === 2, 'nouveau tracé : 2 sommets');
  await key(session, 'Escape', { code: 'Escape' });
  await sleep(300);
  check(await zoneFeatures(`f.properties?.vertex === 1`) === 0, 'Échap : tracé abandonné');
  check(await session.evaluate(`!!document.querySelector('.rv-comments-panel')`), 'Échap sur un tracé : le mode reste armé');

  // ── Sortie du mode, Maj+C ──────────────────────────────────────────────
  await key(session, 'Escape', { code: 'Escape' });
  await sleep(400);
  check(await session.evaluate(`!document.querySelector('.rv-comments-panel')`), 'Échap : sortie du mode, panneau droit revenu');
  check(await session.evaluate(`document.querySelectorAll('[data-rv-comment-pin]').length >= 1`), 'hors du mode : bulles visibles');
  await key(session, 'C', { code: 'KeyC', modifiers: SHIFT, text: 'C' });
  await sleep(400);
  check(await session.evaluate(`document.querySelectorAll('[data-rv-comment-pin]').length === 0`), 'Maj+C : bulles masquées');
  await key(session, 'C', { code: 'KeyC', modifiers: SHIFT, text: 'C' });
  await sleep(400);
  check(await session.evaluate(`document.querySelectorAll('[data-rv-comment-pin]').length >= 1`), 'Maj+C : bulles revenues');

  // ── Thème clair : fil ouvert et liste ───────────────────────────────────
  await key(session, 'c', { code: 'KeyC', text: 'c' });
  await sleep(300);
  await session.evaluate(`[...document.querySelectorAll('.rv-comments-panel__item')][0]?.click()`);
  await sleep(2200);
  await shot(session, '06-dark');
  await session.evaluate(`(document.documentElement.dataset.rvTheme = 'light', 0)`);
  await sleep(500);
  await shot(session, '07-light');
} catch (error) {
  out.errors.push(`script: ${error.stack ?? error}`);
  console.error(error);
  await shot(session, 'zz-error').catch(() => null);
} finally {
  await close();
  // Rapport lu par run.mjs (sortie standard : JSON seulement).
  console.log(JSON.stringify({ steps: out.steps, failures, errors: out.errors }));
}

process.exitCode = failures.length > 0 ? 1 : 0;
