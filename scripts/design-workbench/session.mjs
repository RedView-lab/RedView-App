/**
 * Ouvre le vrai dashboard (serveur dev, compte démo) dans Edge headless avec
 * un projet tracé : même recette que script-test-bench/screen-audit/run.mjs
 * (WebSocket HMR neutralisé, rechargement du Service Worker au premier
 * lancement), avec un GPX plus riche (points de passage et POI → lignes dans
 * la feuille de route).
 */
import fs from 'node:fs';
import { waitFor } from '../../script-test-bench/screen-audit/cdp.mjs';

export const APP_URL = process.env.RV_URL || 'http://localhost:5173/';

const WAYPOINTS = [
  { t: 0.12, name: 'Col des Saisies', type: 'checkpoint' },
  { t: 0.24, name: 'Fontaine du village', type: 'fountains' },
  { t: 0.37, name: 'Beaufort', type: 'checkpoint' },
  { t: 0.5, name: 'Boulangerie du Col', type: 'bakeries' },
  { t: 0.63, name: 'Cormet de Roselend', type: 'checkpoint' },
  { t: 0.76, name: 'Source des Chapieux', type: 'fountains' },
  { t: 0.88, name: 'Bourg-Saint-Maurice', type: 'checkpoint' },
];

function routePoint(t) {
  return {
    lat: 45.9 + 0.5 * t + 0.05 * Math.sin(t * 20),
    lon: 6.85 - 0.9 * t + 0.04 * Math.cos(t * 17),
    ele: 1000 + 800 * Math.sin(t * Math.PI * 3) ** 2 + 200 * Math.sin(t * 40),
  };
}

export function writeGpx(file) {
  const pts = [];
  for (let i = 0; i < 400; i++) {
    const p = routePoint(i / 399);
    pts.push(`<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele></trkpt>`);
  }
  const wpts = WAYPOINTS.map(({ t, name, type }) => {
    const p = routePoint(t);
    return `<wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele><name>${name}</name><type>${type}</type></wpt>`;
  });
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="rv-design-workbench" xmlns="http://www.topografix.com/GPX/1/1">${wpts.join('')}<trk><name>Tour du Beaufortain</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`,
  );
}

export async function openEditorWithRoute(session, gpxFile, { width, height, dpr = 1, settleMs = 900 }) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('DOM.enable');
  // Vite rechargerait la page à chaque modif faite entre-temps dans le dépôt
  // (et perdrait la session démo) : son socket HMR ne se connecte pas.
  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
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
    })()`,
  });
  await setViewport(session, { width, height, dpr });
  await session.send('Page.navigate', { url: APP_URL });
  // Profil neuf : le Service Worker carte s'installe et recharge la page une
  // fois ; un clic avant ce rechargement est perdu. On attend ce rechargement
  // (marqueur effacé) plutôt qu'un délai fixe.
  await waitFor(session, `!!navigator.serviceWorker?.controller`, { timeout: 90000, interval: 100 });
  await session.evaluate('window.__wbBeforeReload = 1, 0');
  try {
    await waitFor(session, `!window.__wbBeforeReload && document.readyState === 'complete'`, { timeout: 5000, interval: 100 });
  } catch {
    /* pas de rechargement */
  }
  const hasCreate = `[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`;
  for (let attempt = 0; attempt < 6; attempt++) {
    await waitFor(session, `[...document.querySelectorAll('button')].some(b => /Demo account|compte démo|Créer un projet|Create a project/i.test(b.textContent))`, { timeout: 90000, interval: 100 });
    if (await session.evaluate(hasCreate)) break;
    await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    try {
      await waitFor(session, hasCreate, { timeout: 8000, interval: 100 });
      break;
    } catch {
      /* clic perdu dans un rechargement : on recommence */
    }
  }
  await waitFor(session, hasCreate, { timeout: 90000, interval: 100 });
  await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas') && !!document.querySelector('input[type=file][accept*=".gpx"]')`, { timeout: 90000, interval: 100 });
  const { root } = await session.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file][accept*=".gpx"]' });
  if (!nodeIds.length) throw new Error('champ d’import GPX introuvable');
  await session.send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: [gpxFile] });
  // Tracé importé, feuille de route remplie (POI ajoutés par le serveur), puis calme.
  await waitFor(session, `document.querySelectorAll('.rvi-tl-row').length > 2 && !!document.querySelector('[data-rv-region="center-panel"]')`, { timeout: 60000, interval: 100 });
  await waitQuiet(session, { quiet: settleMs, max: 12000 });
  // Panneau droit ouvert aussi (un nouveau projet démarre replié).
  await session.evaluate(`document.querySelector('.rvmvc-map-tools__button--panel.is-panel-hidden')?.click(), 0`);
  await waitQuiet(session, { quiet: 400, max: 4000 });
}

/**
 * Attend que l'interface ne bouge plus : aucune mutation du DOM (hors carte)
 * pendant `quiet` ms et aucune animation finie en cours, au plus `max` ms.
 */
export async function waitQuiet(session, { quiet = 250, max = 1500 } = {}) {
  return session.evaluate(`new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    const relevant = (m) => {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return n && !n.closest('.mapboxgl-map, .rv-cursor-loader') && !(m.type === 'attributes' && /^data-wb/.test(m.attributeName));
    };
    const mo = new MutationObserver((list) => { if (list.some(relevant)) last = performance.now(); });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const busy = () => document.getAnimations().some((a) => a.playState === 'running'
      && a.effect?.getComputedTiming?.().iterations !== Infinity
      && !a.effect?.target?.closest?.('.mapboxgl-map'));
    const tick = () => {
      const now = performance.now();
      if (now - t0 > ${max} || (now - last >= ${quiet} && !busy())) {
        mo.disconnect();
        resolve(Math.round(now - t0));
      } else setTimeout(tick, 25);
    };
    setTimeout(tick, 25);
  })`);
}

export async function setViewport(session, { width, height, dpr = 1 }) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: false, screenWidth: width, screenHeight: height,
  });
}
