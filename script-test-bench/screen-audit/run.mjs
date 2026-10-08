/**
 * RedView Test-Bench : tailles d'écran, densité et netteté du dashboard
 * (Edge headless + CDP, vrai dashboard avec une trace GPX importée).
 *
 * Pour chaque écran de la matrice (CSS px × devicePixelRatio : demi-écran
 * 1080p, laptops 1366×768 / 1080p à 125–150 %, MacBook, 1440p, 4K,
 * ultrawide…) :
 *  - échelle du canevas ≥ 1 (≥ 0,85 sur Retina, DPR ≥ 2) et appliquée en CSS
 *    `zoom` (jamais un `transform: scale()`, qui rééchantillonne et floute le
 *    texte) ;
 *  - taille réellement affichée de chaque texte visible (font-size × échelle
 *    effective) : aucun texte d'interface sous 11 px (11 × 0,85 sur Retina,
 *    soit ≥ 18,7 px physiques) ;
 *  - mise en page : panneaux, barre d'outils, outils carte, recherche sans
 *    chevauchement ni débordement, panneau central présent, pas de scroll
 *    horizontal (sous 820×500, l'avertissement « fenêtre trop petite » doit
 *    s'afficher à la place) ; barre d'analyse et recherche + filtres de la
 *    carte chacune sur une ligne (aussi en 1080p, panneau gauche élargi à
 *    ~800 px : fhd-wide-left) ;
 *  - carte 3D : le canvas Mapbox couvre exactement sa zone (échelle ≠ 1
 *    comprise) et, au repos, la carte n'émet pas de `styledata` en boucle
 *    (un handler qui mute le style à chaque `styledata` la re-stylait à
 *    chaque image) ;
 * puis, à l'échelle 1 et 1,117 : menus portés (Colonnes, liste du panneau
 * droit), menu contextuel de la carte, redimensionnement du panneau gauche et
 * timeline plein écran alignés au pixel sur le pointeur / leur ancre ; en
 * plein écran, colonnes ajoutées, les lignes de la feuille de route couvrent
 * toute la largeur du tableau d'un fond uniforme.
 *
 * Le compte démo n'existe qu'en dev : lancer `npm run dev` avant (ou
 * RV_URL=<url du serveur de dev>). Captures + rapport JSON dans
 * script-test-bench/reports/screen-audit/<label>/. Code de sortie ≠ 0 si un
 * critère échoue.
 *
 * Usage : npm run bench:screens -- [--label apres] [--only fhd-half,hd-1366]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, waitFor } from './cdp.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const APP_URL = process.env.RV_URL || 'http://localhost:5173/';
const argValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const LABEL = argValue('label') ?? 'latest';
const ONLY = argValue('only')?.split(',');
const OUT = path.join(ROOT, 'script-test-bench', 'reports', 'screen-audit', LABEL);
const MEASURE = fs.readFileSync(new URL('./measure.js', import.meta.url), 'utf8');

/** Plus petite fenêtre que le tableau de bord prend en charge (shared/hooks/useIsMobileDevice.ts). */
const MIN_W = 820;
const MIN_H = 500;
/** Plancher de texte (shared/styles/typography.css) ; ±2 % de bruit d'arrondi des boîtes. */
const MIN_TEXT_PX = 11 - 0.25;
/** Plancher Retina de l'échelle du canvas (APP_SCALE_HIDPI_MIN, HIDPI_QUERY dans shared/lib/appScale.ts). */
const HIDPI_MIN_SCALE = 0.85;
const minScaleFor = (dpr) => (dpr >= 1.95 ? HIDPI_MIN_SCALE : 1);

// Fenêtres en px CSS telles que les laisse une fenêtre de navigateur maximisée / ancrée.
const SCREENS = [
  { id: 'fhd-full', label: '1080p plein écran (100 %)', w: 1920, h: 950, dpr: 1 },
  { id: 'fhd-half', label: '1080p demi-écran (100 %)', w: 958, h: 950, dpr: 1 },
  { id: 'fhd125-full', label: 'Laptop 1080p à 125 %', w: 1536, h: 730, dpr: 1.25 },
  { id: 'fhd150-full', label: 'Laptop 1080p à 150 %', w: 1280, h: 600, dpr: 1.5 },
  { id: 'hd-1366', label: 'Laptop 1366×768', w: 1366, h: 640, dpr: 1 },
  { id: 'wxga-1280', label: 'Laptop 1280×800', w: 1280, h: 690, dpr: 1 },
  { id: 'hdplus-1600', label: '1600×900', w: 1600, h: 790, dpr: 1 },
  { id: 'mba-13', label: 'MacBook Air 13" (1440×900 @2x)', w: 1440, h: 790, dpr: 2 },
  { id: 'mbp-14', label: 'MacBook Pro 14" (1512×982 @2x)', w: 1512, h: 870, dpr: 2 },
  { id: 'qhd-full', label: '1440p 27" (100 %)', w: 2560, h: 1310, dpr: 1 },
  { id: 'qhd-half', label: '1440p demi-écran (100 %)', w: 1278, h: 1310, dpr: 1 },
  { id: '4k150-full', label: '4K à 150 %', w: 2560, h: 1310, dpr: 1.5 },
  { id: '4k100-full', label: '4K à 100 %', w: 3840, h: 2030, dpr: 1 },
  { id: 'uw-3440', label: 'Ultrawide 3440×1440', w: 3440, h: 1310, dpr: 1 },
  { id: 'fhd-quarter', label: "1080p quart d'écran", w: 958, h: 470, dpr: 1 },
];
const INTERACTION_SCREENS = ['fhd-full', 'qhd-full', 'hd-1366'];

const results = [];
const check = (screen, name, ok, detail = '') => {
  results.push({ screen, name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} [${screen}] ${name}${detail ? ` — ${detail}` : ''}`);
};
const near = (a, b, tol = 2.5) => Math.abs(a - b) <= tol;

function writeGpx(file) {
  const pts = [];
  for (let i = 0; i < 400; i++) {
    const t = i / 399;
    const lat = 45.9 + 0.5 * t + 0.05 * Math.sin(t * 20);
    const lon = 6.85 - 0.9 * t + 0.04 * Math.cos(t * 17);
    const ele = 1000 + 800 * Math.sin(t * Math.PI * 3) ** 2 + 200 * Math.sin(t * 40);
    pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${ele.toFixed(1)}</ele></trkpt>`);
  }
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="rv-screen-audit" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Test Alpes</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`,
  );
}

async function openEditorWithRoute(session, gpxFile) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  // Vite rechargerait toute la page à chaque modification faite entre-temps
  // dans le dépôt (et perdrait la session de démo de dev) : on empêche sa
  // socket HMR de se connecter.
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
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 950, deviceScaleFactor: 1, mobile: false });
  await session.send('Page.navigate', { url: APP_URL });
  // Sur un profil neuf, le Service Worker de la carte s'installe et recharge
  // la page une fois (époque du cache de carte) : un clic avant ce rechargement
  // est perdu. On attend le contrôleur, puis on clique jusqu'à ce que le
  // gestionnaire de projets apparaisse.
  await waitFor(session, `!!navigator.serviceWorker?.controller`, { timeout: 90000 });
  await sleep(3000);
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitFor(session, `[...document.querySelectorAll('button')].some(b => /Demo account|compte démo|Créer un projet|Create a project/i.test(b.textContent))`, { timeout: 90000 });
    if (await session.evaluate(`[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`)) break;
    await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Demo account|compte démo/i.test(b.textContent))?.click()`);
    await sleep(8000);
  }
  await waitFor(session, `[...document.querySelectorAll('button')].some(b => /Créer un projet|Create a project/.test(b.textContent))`, { timeout: 90000 });
  await session.evaluate(`[...document.querySelectorAll('button')].find(b => /Créer un projet|Create a project/.test(b.textContent)).click()`);
  await waitFor(session, `!!document.querySelector('.mapboxgl-canvas')`, { timeout: 90000 });
  await sleep(2500);
  const { root } = await session.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file][accept*=".gpx"]' });
  await session.send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: [gpxFile] });
  await sleep(6000);
  // Panneau de droite ouvert aussi (un nouveau projet démarre avec lui replié).
  await session.evaluate(`document.querySelector('.rvmvc-map-tools__button--panel.is-panel-hidden')?.click()`);
  await sleep(1200);
}

/**
 * Événements `styledata` émis par la carte pendant que rien ne se passe. Un
 * gestionnaire qui modifie le style à chaque `styledata` le relance à chaque
 * image — la carte n'est jamais au repos et Mapbox vide son cache de drapé du
 * terrain à chaque image. L'instance de carte est atteinte par la fibre React
 * de son conteneur (pas de globale de l'application).
 */
const STYLE_REST_WINDOW_MS = 2500;
const MAX_STYLE_EVENTS_AT_REST = 2;
const STYLE_EVENTS_AT_REST = `(async () => {
  const el = document.querySelector('.mapboxgl-map');
  const fiberKey = el && Object.keys(el).find((k) => k.startsWith('__reactFiber'));
  let map = null;
  for (let f = fiberKey ? el[fiberKey] : null, depth = 0; f && !map && depth < 60; f = f.return, depth++) {
    for (let h = f.memoizedState, i = 0; h && i < 80; h = h.next, i++) {
      const v = h.memoizedState && h.memoizedState.current;
      if (v && typeof v.getCanvas === 'function' && typeof v.getStyle === 'function') { map = v; break; }
    }
  }
  if (!map) return null;
  let n = 0;
  const count = () => { n++; };
  map.on('styledata', count);
  await new Promise((resolve) => setTimeout(resolve, ${STYLE_REST_WINDOW_MS}));
  map.off('styledata', count);
  return n;
})()`;

function overlapArea(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 1 && h > 1 ? Math.round(w * h) : 0;
}

async function auditScreen(session, screen) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: screen.w, height: screen.h, deviceScaleFactor: screen.dpr, mobile: false, screenWidth: screen.w, screenHeight: screen.h,
  });
  await sleep(1800);
  const supported = screen.w >= MIN_W && screen.h >= MIN_H;
  const overlay = await session.evaluate(`!!document.querySelector('.rv-mobile-block-overlay--dismissible')`);
  check(screen.id, supported ? 'pas d’avertissement « fenêtre trop petite »' : 'avertissement « fenêtre trop petite » affiché', overlay === !supported);
  if (overlay) {
    await session.evaluate(`document.querySelector('.rv-mobile-block-overlay--dismissible .rv-mobile-block-button')?.click()`);
    await sleep(500);
  }
  const m = await session.evaluate(MEASURE);
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${screen.id}.png`), Buffer.from(shot.data, 'base64'));

  const scale = Number(m.appScale) || 1;
  const zoomed = !m.canvasStyle?.transform;
  const minScale = minScaleFor(screen.dpr);
  check(screen.id, `échelle ≥ ${minScale}, appliquée en CSS zoom`, scale >= minScale && zoomed, `échelle ${scale}${m.canvasStyle?.transform ? `, ${m.canvasStyle.transform}` : ''}`);

  const minText = MIN_TEXT_PX * minScale;
  const small = m.texts.filter((t) => t.eff < minText).sort((a, b) => a.eff - b.eff);
  const effs = m.texts.map((t) => t.eff).sort((a, b) => a - b);
  check(
    screen.id,
    `aucun texte sous ${+(11 * minScale).toFixed(2)} px (${m.texts.length} textes, min ${effs[0]} px, médiane ${effs[Math.floor(effs.length / 2)]} px)`,
    small.length === 0,
    small.slice(0, 5).map((t) => `${t.eff}px «${t.text}» (${t.cls.split(' ')[0]})`).join(', '),
  );

  if (!supported) return { screen, scale, texts: effs.length };
  const mf = m.mapFill;
  check(
    screen.id,
    'carte 3D : le canvas couvre toute sa zone',
    !!mf && near(mf.cw, mf.w, 1.5) && near(mf.ch, mf.h, 1.5) && near(mf.dx, 0, 1) && near(mf.dy, 0, 1),
    mf ? `zone ${mf.w}×${mf.h}, canvas ${mf.cw}×${mf.ch} @${mf.dx},${mf.dy}` : 'carte absente',
  );
  const styleEvents = await session.evaluate(STYLE_EVENTS_AT_REST);
  check(
    screen.id,
    'carte au repos : style stable (pas de boucle styledata)',
    styleEvents != null && styleEvents <= MAX_STYLE_EVENTS_AT_REST,
    styleEvents == null ? 'carte introuvable' : `${styleEvents} styledata en ${STYLE_REST_WINDOW_MS / 1000} s`,
  );
  const R = m.regions;
  const pairs = [
    ['mapTools', 'toolbar'], ['mapTools', 'center'], ['mapTools', 'right'], ['search', 'right'],
    ['search', 'mapTools'], ['left', 'center'], ['left', 'toolbar'], ['right', 'center'],
    ['right', 'toolbar'], ['search', 'left'],
  ];
  const overlaps = pairs.map(([a, b]) => [a, b, overlapArea(R[a], R[b])]).filter(([, , o]) => o > 0);
  check(screen.id, 'panneaux et outils sans chevauchement', overlaps.length === 0, overlaps.map(([a, b, o]) => `${a}/${b} ${o} px²`).join(', '));
  const outside = Object.entries(R).filter(([, r]) => r && (r.x < -1 || r.y < -1 || r.x + r.w > screen.w + 1 || r.y + r.h > screen.h + 1));
  check(screen.id, 'rien ne déborde de la fenêtre', outside.length === 0 && m.docOverflow.sw <= screen.w + 1, outside.map(([k]) => k).join(', '));
  check(screen.id, 'panneau central et barre d’outils présents', !!R.center && !!R.toolbar);
  const bar = m.analysisToolbar;
  check(screen.id, 'barre d’analyse sur une ligne', !!bar && !bar.wraps, bar ? `${bar.w} px, palier ${bar.density.split(' ').pop() || 0}` : 'absente');
  const ps = m.placeSearch;
  check(screen.id, 'recherche et filtres carte sur une ligne', !!ps && !ps.wraps && !ps.overflows, ps ? `${ps.w} px${ps.density ? `, ${ps.density}` : ''}${ps.overflows ? ', déborde' : ''}` : 'absente');
  return { screen, scale, texts: effs.length, minText: effs[0], regions: R };
}

/** Tire la poignée de redimensionnement du panneau de gauche de `dx` px (événements DOM, comme `interactions`). */
async function dragLeftPanel(session, dx) {
  return session.evaluate(`(async () => {
    const region = document.querySelector('[data-rv-region="left-panel"]');
    const handle = document.querySelector('.rvi-panel__resize-handle');
    if (!region || !handle) return null;
    const hr = handle.getBoundingClientRect();
    const x = hr.left + hr.width / 2, y = hr.top + hr.height / 2;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
    for (let k = 1; k <= 8; k++) {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + (${dx} * k) / 8, clientY: y, buttons: 1 }));
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + ${dx}, clientY: y }));
    await new Promise((r) => setTimeout(r, 800));
    return region.getBoundingClientRect().width;
  })()`);
}

/** Fenêtre 1080p avec le panneau de gauche tiré au maximum (~800 px) : colonne centrale étroite. */
async function auditWideLeftPanel(session) {
  const id = 'fhd-wide-left';
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 945, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);
  const before = await session.evaluate(`document.querySelector('[data-rv-region="left-panel"]')?.getBoundingClientRect().width ?? 0`);
  const wide = await dragLeftPanel(session, 800 - before);
  const m = await session.evaluate(MEASURE);
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${id}.png`), Buffer.from(shot.data, 'base64'));
  const bar = m.analysisToolbar;
  check(id, `barre d’analyse sur une ligne (panneau gauche ${Math.round(wide ?? 0)} px)`, !!bar && !bar.wraps, bar ? `${bar.w} px, palier ${bar.density.split(' ').pop() || 0}` : 'absente');
  const ps = m.placeSearch;
  check(id, 'recherche et filtres carte sur une ligne', !!ps && !ps.wraps && !ps.overflows, ps ? `${ps.w} px${ps.density ? `, ${ps.density}` : ''}${ps.overflows ? ', déborde' : ''}` : 'absente');
  await dragLeftPanel(session, before - (wide ?? before));
}

async function rectOf(session, js) {
  return session.evaluate(`(() => { const el = ${js}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; })()`);
}
async function click(session, x, y, button = 'left') {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}
async function escape(session) {
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

/** Menu des colonnes : aligné à droite sur son déclencheur, 6 px logiques dessous (ou dessus quand la place manque). */
function columnsMenuAligned(menu, anchor, s) {
  if (!menu) return false;
  const above = menu.b <= anchor.y + 1;
  return (above ? near(menu.b, anchor.y - 6 * s, 3) : near(menu.y, anchor.b + 6 * s, 3)) && near(menu.r, anchor.r, 3);
}

async function interactions(session, screen) {
  await session.send('Emulation.setDeviceMetricsOverride', { width: screen.w, height: screen.h, deviceScaleFactor: screen.dpr, mobile: false });
  await sleep(1800);
  const s = Number(await session.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--app-scale')`)) || 1;
  const id = `${screen.id} ×${s}`;

  const anchor = await rectOf(session, `[...document.querySelectorAll('[data-rv-region="left-panel"] button')].find(b => /Colonnes|Columns/.test(b.textContent))`);
  if (anchor) {
    await click(session, anchor.x + anchor.w / 2, anchor.y + anchor.h / 2);
    await sleep(400);
    const menu = await rectOf(session, `document.querySelector('.rvi-tl-columns-menu')`);
    check(id, 'menu « Colonnes » collé à son bouton', columnsMenuAligned(menu, anchor, s), menu ? `bouton ${anchor.r.toFixed(1)},${anchor.b.toFixed(1)} → menu ${menu.r.toFixed(1)},${menu.y.toFixed(1)}` : 'menu absent');
    await escape(session);
    await sleep(300);
  }

  const sel = await rectOf(session, `[...document.querySelectorAll('.rvc-select')].find(e => /GPX/.test(e.textContent))`);
  if (sel) {
    await click(session, sel.x + sel.w / 2, sel.y + sel.h / 2);
    await sleep(400);
    const dd = await rectOf(session, `document.querySelector('.rvc-select__dropdown')`);
    const above = dd && dd.b <= sel.y + 1;
    check(id, 'liste déroulante collée à son champ', !!dd && near(dd.x, sel.x, 3) && (above ? near(dd.b, sel.y - 4 * s, 4) : near(dd.y, sel.b + 4 * s, 3)), dd ? `champ ${sel.x.toFixed(1)},${sel.b.toFixed(1)} → liste ${dd.x.toFixed(1)},${dd.y.toFixed(1)}` : 'liste absente');
    await click(session, 5, screen.h - 5);
    await sleep(300);
  }

  const bar = await rectOf(session, `document.querySelector('[data-rv-region="center-toolbar"]')`);
  const px = Math.round(bar ? bar.x + bar.w / 2 : screen.w / 2);
  const py = Math.round(bar ? Math.max(120 * s, bar.y - 120 * s) : screen.h / 3);
  await click(session, px, py, 'right');
  await sleep(700);
  const cm = await rectOf(session, `document.querySelector('[role="menu"][aria-label="Menu contextuel de la carte"], [role="menu"][aria-label="Map context menu"]')`);
  check(id, 'menu contextuel de la carte au point cliqué', !!cm && (near(cm.x, px, 14) || near(cm.r, px, 14)) && (near(cm.y, py, 14) || near(cm.b, py, 14)), cm ? `clic ${px},${py} → menu ${cm.x.toFixed(1)},${cm.y.toFixed(1)}–${cm.r.toFixed(1)},${cm.b.toFixed(1)}` : 'menu absent');
  if (cm) {
    await escape(session);
    await click(session, px + 40, py + 20);
    await sleep(400);
  }

  // Événements DOM : le centre de la poignée est sous le conteneur défilant du panneau pour le test de clic.
  const resize = await session.evaluate(`(async () => {
    const region = document.querySelector('[data-rv-region="left-panel"]');
    const handle = document.querySelector('.rvi-panel__resize-handle');
    if (!region || !handle || !region.checkVisibility({ opacityProperty: true })) return null;
    const width = () => region.getBoundingClientRect().width;
    const hr = handle.getBoundingClientRect();
    const x = hr.left + hr.width / 2, y = hr.top + hr.height / 2;
    const drag = async (dx) => {
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
      for (let k = 1; k <= 6; k++) {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + (dx * k) / 6, clientY: y, buttons: 1 }));
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + dx, clientY: y }));
      await new Promise((r) => setTimeout(r, 500));
    };
    const w0 = width();
    await drag(60);
    const w1 = width();
    await drag(-(w1 - w0));
    return { w0, w1 };
  })()`);
  if (resize) check(id, 'redimensionnement du panneau gauche suit la souris', near(resize.w1 - resize.w0, 60, 2.5), `Δ ${(resize.w1 - resize.w0).toFixed(1)} px pour 60 px`);

  const fsBtn = await rectOf(session, `document.querySelector('[aria-label="Ouvrir en plein écran"], [aria-label="Open in full screen"]')`);
  if (fsBtn) {
    await click(session, fsBtn.x + fsBtn.w / 2, fsBtn.y + fsBtn.h / 2);
    await sleep(900);
    const layer = await rectOf(session, `document.querySelector('.rvi-panel-fullscreen-root')`);
    check(id, 'timeline plein écran couvre la fenêtre', !!layer && near(layer.x, 0) && near(layer.y, 0) && near(layer.w, screen.w, 3) && near(layer.h, screen.h, 3), layer ? `${layer.w.toFixed(1)}×${layer.h.toFixed(1)}` : 'absente');
    const a2 = await rectOf(session, `[...document.querySelectorAll('.rvi-panel-fullscreen-root button')].find(b => /Colonnes|Columns/.test(b.textContent))`);
    if (a2) {
      await click(session, a2.x + a2.w / 2, a2.y + a2.h / 2);
      await sleep(400);
      const m2 = await rectOf(session, `document.querySelector('.rvi-tl-columns-menu')`);
      check(id, 'menu « Colonnes » aligné en plein écran', columnsMenuAligned(m2, a2, s));
      // Colonnes ajoutées (grille) : chaque ligne couvre toute la largeur du
      // tableau, d'un même fond, cases à cocher et actions comprises. Les
      // colonnes sont retirées ensuite (retour à la liste compacte).
      // Un clic par rendu : une bascule part des colonnes du dernier rendu.
      const toggleColumns = async () => {
        let toggled = 0;
        for (const label of ['Altitude', 'Temp(é|e)rature']) {
          toggled += await session.evaluate(`(() => {
            const item = [...document.querySelectorAll('.rvi-tl-columns-menu [role=menuitemcheckbox]')]
              .find((b) => /^${label}$/.test(b.textContent.trim()));
            item?.click();
            return item ? 1 : 0;
          })()`);
          await sleep(250);
        }
        return toggled;
      };
      if (await toggleColumns()) {
        await sleep(500);
        const row = await session.evaluate(`(() => {
          const grid = document.querySelector('.rvi-panel-fullscreen-root .rvi-tl-table-grid');
          const tr = grid?.querySelector('.rvi-tl-tr');
          if (!tr) return null;
          const g = grid.getBoundingClientRect();
          const cells = [...tr.children];
          const rects = cells.map((c) => c.getBoundingClientRect());
          return {
            gl: g.left, gr: g.right,
            l: Math.min(...rects.map((r) => r.left)), r: Math.max(...rects.map((r) => r.right)),
            fill: getComputedStyle(cells[1]).backgroundColor,
            stickyFills: [cells[0], cells[cells.length - 1]].map((c) => getComputedStyle(c, '::before').backgroundColor),
          };
        })()`);
        check(id, 'feuille de route plein écran : lignes sur toute la largeur, fond uniforme',
          !!row && near(row.l, row.gl, 1) && near(row.r, row.gr, 1) && row.stickyFills.every((f) => f === row.fill),
          row ? `ligne ${row.l.toFixed(1)}–${row.r.toFixed(1)}, tableau ${row.gl.toFixed(1)}–${row.gr.toFixed(1)}, fonds ${row.fill} / ${row.stickyFills.join(' / ')}` : 'grille absente');
        await toggleColumns();
        await sleep(300);
      }
      await escape(session);
      await sleep(300);
    }
    const quit = await rectOf(session, `document.querySelector('[aria-label="Quitter le plein écran"], [aria-label="Exit full screen"]')`);
    if (quit) await click(session, quit.x + quit.w / 2, quit.y + quit.h / 2);
    await sleep(700);
  }
}

fs.mkdirSync(OUT, { recursive: true });
const gpxFile = path.join(OUT, 'route.gpx');
writeGpx(gpxFile);
const { session, close } = await launch({ port: Number(process.env.CDP_PORT ?? 18971) });
const screens = [];
try {
  await openEditorWithRoute(session, gpxFile);
  for (const screen of SCREENS.filter((sc) => !ONLY || ONLY.includes(sc.id))) {
    screens.push(await auditScreen(session, screen));
  }
  if (!ONLY || ONLY.includes('fhd-wide-left')) await auditWideLeftPanel(session);
  for (const screen of SCREENS.filter((sc) => INTERACTION_SCREENS.includes(sc.id) && (!ONLY || ONLY.includes(sc.id)))) {
    await interactions(session, screen);
  }
} finally {
  await close();
}
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ label: LABEL, date: new Date().toISOString(), screens, results }, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} critères OK — captures et rapport : ${path.relative(ROOT, OUT)}`);
process.exit(failed.length ? 1 : 0);
