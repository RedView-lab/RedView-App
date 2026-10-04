/**
 * Vérification du workbench (Edge headless) :
 *  A. superposition avec la capture : rectangle de chaque texte / bloc dans
 *     chaque état (base, variantes, pop-ins) à la taille de capture ;
 *  B. superposition avec l'app réelle (serveur dev, compte démo) à plusieurs
 *     tailles d'écran, dont un MacBook Pro 14" émulé (DPR 2) : mêmes éléments
 *     retrouvés par leur chemin dans le DOM, même échelle de canevas ;
 *  D. clic droit = clic de l'app : onglet, section, liste déroulante, retour ;
 *  C. scénario d'édition : règle (taille, graisse, padding), token, densité
 *     de la barre d'analyse, export JSON (sélecteurs présents dans leurs
 *     fichiers), annuler / rétablir, rechargement (sauvegarde locale), import.
 * Rapport + captures : scripts/design-workbench/.cache/verify/. Code de sortie
 * ≠ 0 si un critère échoue.
 *
 * Usage : npm run workbench:verify [-- --no-app]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep, waitFor } from '../../script-test-bench/screen-audit/cdp.mjs';
import { openEditorWithRoute, writeGpx, setViewport } from './session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, '.cache', 'verify');
const HTML = path.join(HERE, 'out', 'redview-workbench.html');
const WITH_APP = !process.argv.includes('--no-app');
const TOL = 1;
const SCREENS = [
  { id: 'capture', w: 1920, h: 950, dpr: 1 },
  { id: 'mbp14', w: 1512, h: 870, dpr: 2 },
  { id: 'hd-1366', w: 1366, h: 640, dpr: 1 },
  { id: 'fhd-half', w: 958, h: 950, dpr: 1 },
];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

async function openWorkbench(session, { w, h, dpr }) {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await setViewport(session, { width: w, height: h, dpr });
  await session.send('Page.navigate', { url: `file:///${HTML.split(path.sep).join('/')}` });
  await waitFor(session, '!!window.__wb', { timeout: 30000 });
  await session.evaluate('document.fonts.ready.then(() => 1)');
  await sleep(600);
}

/** Écarts (px logiques) entre deux jeux de rectangles {id: [x, y, w, h]}. */
function compare(ref, got, ids) {
  const rows = [];
  for (const id of ids) {
    const a = ref[id], b = got[id];
    if (!a || !b) continue;
    if ((a[2] < 0.5 && a[3] < 0.5) && (b[2] < 0.5 && b[3] < 0.5)) continue;
    const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
    rows.push({ id, d, a, b });
  }
  rows.sort((x, y) => y.d - x.d);
  const within = rows.filter((r) => r.d <= TOL).length;
  return { n: rows.length, within, pct: rows.length ? (100 * within) / rows.length : 100, worst: rows.slice(0, 5) };
}

const fmtCmp = (c, data) => `${c.within}/${c.n} à ≤ ${TOL} px (${c.pct.toFixed(1)} %)${c.worst[0] && c.worst[0].d > TOL
  ? ` · pire ${c.worst[0].d.toFixed(1)} px « ${(data.el[c.worst[0].id]?.t ?? '').slice(0, 24)} »` : ''}`;

// ── A. Workbench ↔ capture ─────────────────────────────────────────────────
async function phaseA(session, data) {
  const v = data.meta.viewport;
  await openWorkbench(session, { w: v.w, h: v.h, dpr: v.dpr });
  const scale = await session.evaluate('window.__wb.layout().appScale');
  check('A · échelle du canevas = capture', Math.abs(scale - data.meta.appScale) < 1e-6, `${scale}`);
  const ref = Object.fromEntries(Object.entries(data.el).map(([id, m]) => [id, m.r]));
  const idsOf = (htmls) => [...new Set(htmls.flatMap((h) => [...h.matchAll(/ data-wb="(\d+)"/g)].map((m) => m[1])))].filter((id) => data.el[id]);
  // Base, puis chaque déclencheur dans son contexte : les éléments de ses patchs
  // et calques doivent tomber là où la capture les a mesurés dans l'app.
  const base = compare(ref, await (async () => {
    await session.evaluate('window.__wb.setView({ applied: [] })');
    await sleep(300);
    return session.evaluate('window.__wb.rects()');
  })(), idsOf(Object.values(data.base)).filter((id) => data.el[id].k & 1));
  check('A · base : textes superposés', base.pct >= 99, fmtCmp(base, data));
  let n = 0, within = 0;
  const weak = [];
  for (const t of data.triggers) {
    const htmls = [...(t.patches || []).map((p) => p.html), ...(t.layers || []).map((l) => l.html)];
    if (!htmls.length) continue;
    const view = t.kind === 'popup' ? { applied: t.ctx, popup: t.id } : { applied: [...t.ctx, t.id] };
    await session.evaluate(`window.__wb.setView(${JSON.stringify(view)})`);
    await sleep(120);
    const got = await session.evaluate('window.__wb.rects()');
    const c = compare(ref, got, idsOf(htmls).filter((id) => data.el[id].k & 1));
    if (!c.n) continue;
    n += c.n;
    within += c.within;
    if (c.pct < 95) weak.push(`${t.label.slice(0, 28)} ${c.pct.toFixed(0)} %`);
  }
  const triggersWithPatches = data.triggers.filter((t) => (t.patches || []).length || (t.layers || []).length).length;
  check(`A · ${triggersWithPatches} états et pop-ins capturés : textes superposés`, n > 0 && within / n >= 0.99,
    `${within}/${n} à ≤ ${TOL} px (${((100 * within) / Math.max(1, n)).toFixed(1)} %)`);
  check('A · aucun état sous 95 %', weak.length <= Math.ceil(triggersWithPatches * 0.03), weak.slice(0, 6).join(' · '));
  await session.evaluate('window.__wb.setView({ applied: [] })');
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'workbench-capture.png'), Buffer.from(shot.data, 'base64'));
}

// ── B. Workbench ↔ app réelle ──────────────────────────────────────────────
/** Dans la page (app ou workbench) : chemin région + index d'enfants → élément. */
const REGION_JS = `(() => {
  const canvas = document.querySelector('[data-rv-canvas]');
  const dropped = (e) => /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|LINK|TEMPLATE)$/.test(e.tagName) || e.classList.contains('mapboxgl-marker') || e.classList.contains('mapboxgl-popup');
  const keyOf = (el, i) => {
    if (el.tagName === 'CANVAS' || el.id === 'wb-portal') return null;
    if (el.querySelector(':scope .mapboxgl-map') || el.classList.contains('mapboxgl-map')) return 'map';
    const own = el.getAttribute('data-rv-region');
    if (own) return own;
    const child = el.firstElementChild?.getAttribute('data-rv-region');
    if (child) return child + '-shell';
    if (el.classList.contains('rvd-place-search')) return 'search';
    if (el.querySelector(':scope > aside.rvmvc-map-tools')) return 'map-tools';
    if (el.style.cursor === 'row-resize') return 'center-resize';
    if (el.style.zIndex === '31') return null;
    if (el.style.zIndex === '40') return 'map-overlay';
    return 'misc-' + i;
  };
  const regions = {};
  [...canvas.children].forEach((el, i) => { const k = keyOf(el, i); if (k) regions[k] = el; });
  const kids = (el) => [...el.children].filter((c) => !dropped(c));
  const s = parseFloat(getComputedStyle(canvas).getPropertyValue('--app-scale')) || 1;
  const c = canvas.getBoundingClientRect();
  const rect = (el) => { const r = el.getBoundingClientRect(); return [(r.left - c.left) / s, (r.top - c.top) / s, r.width / s, r.height / s].map((v) => Math.round(v * 100) / 100); };
  const text = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\\s+/g, ' ').trim().slice(0, 60);
  return { canvas, regions, kids, rect, text, s };
})()`;

async function workbenchPaths(session) {
  return session.evaluate(`(() => {
    const R = ${REGION_JS};
    const out = {};
    for (const [key, root] of Object.entries(R.regions)) {
      const walk = (el, p) => {
        const id = el.dataset?.wb;
        if (id && window.__wb.data.el[id]) out[id] = { key, p: p.slice(), t: window.__wb.data.el[id].t ?? null };
        R.kids(el).forEach((k, i) => { p.push(i); walk(k, p); p.pop(); });
      };
      walk(root, []);
    }
    return out;
  })()`);
}

async function rectsByPath(session, paths, { workbench }) {
  return session.evaluate(`(() => {
    const R = ${REGION_JS};
    const paths = ${JSON.stringify(paths)};
    const out = {}; let mismatch = 0;
    for (const [id, { key, p, t }] of Object.entries(paths)) {
      let el = R.regions[key];
      for (const i of p) { if (!el) break; el = R.kids(el)[i]; }
      if (!el) { mismatch++; continue; }
      if (!${workbench} && t != null && R.text(el) !== t && !(el.value && el.value.startsWith(t))) { mismatch++; continue; }
      out[id] = R.rect(el);
    }
    return { rects: out, mismatch, scale: R.s };
  })()`);
}

async function onion(session, appPng, wbPng, file) {
  const png = await session.evaluate(`(async () => {
    const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src; });
    const [a, b] = await Promise.all([load('data:image/png;base64,${appPng}'), load('data:image/png;base64,${wbPng}')]);
    const c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
    const x = c.getContext('2d');
    x.filter = 'grayscale(1) brightness(1.6)'; x.drawImage(a, 0, 0);
    x.filter = 'none'; x.globalAlpha = 0.55; x.globalCompositeOperation = 'multiply'; x.drawImage(b, 0, 0, a.width, a.height);
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
}

async function phaseB(app, wb, data) {
  const gpx = path.join(OUT, 'route.gpx');
  writeGpx(gpx);
  const v = data.meta.viewport;
  await openEditorWithRoute(app, gpx, { width: v.w, height: v.h, dpr: v.dpr });
  await app.evaluate('document.fonts.ready.then(() => 1)');
  await sleep(1500);
  await openWorkbench(wb, { w: v.w, h: v.h, dpr: v.dpr });
  // Session vierge (la phase C a laissé des modifs en localStorage), panneau masqué.
  await wb.evaluate('localStorage.clear(), 0');
  await wb.send('Page.reload');
  await waitFor(wb, '!!window.__wb', { timeout: 30000 });
  await wb.evaluate('document.fonts.ready.then(() => 1)');
  await wb.evaluate(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '#wb-ui { display: none !important; }' })), 0`);
  await sleep(600);
  const paths = await workbenchPaths(wb);
  for (const sc of SCREENS) {
    await setViewport(app, { width: sc.w, height: sc.h, dpr: sc.dpr });
    await setViewport(wb, { width: sc.w, height: sc.h, dpr: sc.dpr });
    await sleep(1800);
    await app.evaluate(`document.querySelector('.rv-mobile-block-overlay--dismissible .rv-mobile-block-button')?.click()`);
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(sc.w / 2), y: 140 });
    await sleep(400);
    const real = await rectsByPath(app, paths, { workbench: false });
    const mine = await rectsByPath(wb, paths, { workbench: true });
    check(`B · ${sc.id} ${sc.w}×${sc.h}@${sc.dpr} : même échelle de canevas`, Math.abs(real.scale - mine.scale) < 1e-6, `app ${real.scale} · workbench ${mine.scale}`);
    const ids = Object.keys(real.rects);
    const texts = compare(real.rects, mine.rects, ids.filter((id) => data.el[id]?.k & 1));
    const all = compare(real.rects, mine.rects, ids);
    check(`B · ${sc.id} : textes superposés à l’app (${real.mismatch} éléments non retrouvés)`, texts.pct >= (sc.id === 'capture' ? 99 : 97), fmtCmp(texts, data));
    check(`B · ${sc.id} : blocs superposés à l’app`, all.pct >= 95, fmtCmp(all, data));
    const off = ids.map((id) => ({ id, a: real.rects[id], b: mine.rects[id] })).filter(({ a, b }) => a && b && Math.max(...a.map((x, i) => Math.abs(x - b[i]))) > TOL);
    const info = await wb.evaluate(`(() => { const out = {}; for (const id of ${JSON.stringify(off.map((o) => o.id))}) { const el = document.querySelector('[data-wb="' + id + '"]'); let reg = el; while (reg && reg.parentElement && reg.parentElement.id !== 'wb-canvas') reg = reg.parentElement; out[id] = [String(el?.className?.baseVal ?? el?.className ?? '').split(' ').filter((c) => !c.startsWith('wb-')).slice(0, 2).join('.'), reg?.getAttribute('data-rv-region') || reg?.firstElementChild?.getAttribute('data-rv-region') || reg?.className || '']; } return out; })()`);
    fs.writeFileSync(path.join(OUT, `${sc.id}-ecarts.json`), JSON.stringify(off.map((o) => ({ ...o, t: data.el[o.id]?.t, cls: info[o.id]?.[0], region: info[o.id]?.[1] })), null, 1));
    const [sa, sb] = await Promise.all([app.send('Page.captureScreenshot', { format: 'png' }), wb.send('Page.captureScreenshot', { format: 'png' })]);
    fs.writeFileSync(path.join(OUT, `${sc.id}-app.png`), Buffer.from(sa.data, 'base64'));
    fs.writeFileSync(path.join(OUT, `${sc.id}-workbench.png`), Buffer.from(sb.data, 'base64'));
    await onion(wb, sa.data, sb.data, path.join(OUT, `${sc.id}-onion.png`));
  }
}

// ── D. Clic droit = clic de l'app ─────────────────────────────────────────
async function phaseD(session, data) {
  const v = data.meta.viewport;
  await openWorkbench(session, { w: v.w, h: v.h, dpr: v.dpr });
  await session.evaluate('localStorage.clear(), 0');
  await session.send('Page.reload');
  await waitFor(session, '!!window.__wb', { timeout: 30000 });
  await sleep(600);
  const r = await session.evaluate(`(async () => {
    const wb = window.__wb;
    const wait = () => new Promise((ok) => setTimeout(ok, 120));
    const q = (sel, text) => [...document.querySelectorAll('#wb-canvas ' + sel)].find((e) => !text || e.textContent.trim() === text);
    const out = {};
    const rc = (el) => { if (el) wb.rightClick(el); };
    // Onglet POI puis Rythme puis retour Traçage.
    rc(q('.rvi-mode', 'POI'));
    await wait();
    out.poi = q('.rvi-mode', 'POI')?.classList.contains('is-active') ?? false;
    rc(q('.rvi-mode', 'Rythme'));
    await wait();
    out.rythme = (q('.rvi-mode', 'Rythme')?.classList.contains('is-active') ?? false) && !(q('.rvi-mode', 'POI')?.classList.contains('is-active'));
    rc(q('.rvi-mode', 'Traçage'));
    await wait();
    out.tracage = (q('.rvi-mode', 'Traçage')?.classList.contains('is-active') ?? false) && !(q('.rvi-mode', 'Rythme')?.classList.contains('is-active'));
    out.appliedAfterBack = wb.state.view.applied.length;
    // Section du panneau droit : ouvrir, refermer.
    const title = q('.rvc-section__title-btn', 'Météo');
    const before = q('.rvc-section__title-btn', 'Météo')?.getAttribute('aria-expanded');
    rc(title);
    await wait();
    out.sectionOpen = q('.rvc-section__title-btn', 'Météo')?.getAttribute('aria-expanded');
    rc(q('.rvc-section__title-btn', 'Météo'));
    await wait();
    out.sectionClosed = q('.rvc-section__title-btn', 'Météo')?.getAttribute('aria-expanded');
    out.sectionBefore = before;
    // Liste déroulante (type d'activité) : ouverte, puis refermée par un clic ailleurs.
    rc(q('.rvi-tracage__mode-btn--activity'));
    await wait();
    out.popupOpen = !!wb.state.view.popup && document.querySelector('#wb-portal').children.length > 0;
    rc(q('.rvi-header__title') || document.querySelector('#wb-canvas .rvi-panel'));
    await wait();
    out.popupClosed = !wb.state.view.popup && document.querySelector('#wb-portal').children.length === 0;
    out.triggers = wb.triggers().length;
    return out;
  })()`);
  check('D · clic droit sur « POI » : onglet POI actif', r.poi);
  check('D · puis « Rythme » remplace POI', r.rythme);
  check('D · puis « Traçage » revient à l’état initial', r.tracage && r.appliedAfterBack === 0, `${r.appliedAfterBack} déclencheur(s) restant(s)`);
  check('D · section « Météo » : ouverte puis refermée', r.sectionBefore === 'false' && r.sectionOpen === 'true' && r.sectionClosed === 'false', `${r.sectionBefore} → ${r.sectionOpen} → ${r.sectionClosed}`);
  check('D · liste déroulante : ouverte, refermée par un clic ailleurs', r.popupOpen && r.popupClosed);
  check('D · déclencheurs capturés', r.triggers >= 150, String(r.triggers));
}

// ── C. Édition ─────────────────────────────────────────────────────────────
async function phaseC(session, data) {
  const v = data.meta.viewport;
  await openWorkbench(session, { w: v.w, h: v.h, dpr: v.dpr });
  await session.evaluate('localStorage.clear(), 0');
  await session.send('Page.reload');
  await waitFor(session, '!!window.__wb', { timeout: 30000 });
  await sleep(600);
  const r = await session.evaluate(`(async () => {
    const wb = window.__wb;
    const q = (s) => [...document.querySelectorAll('#wb-canvas ' + s)];
    const fs = (el) => getComputedStyle(el).fontSize;
    const modes = q('.rvi-mode');
    const id = Number(modes[0].dataset.wb);
    const before = modes.map(fs);
    wb.editProp(id, 'font-size', 'var(--rv-font-size-xl)');
    const afterSize = modes.map(fs);
    wb.editProp(id, 'font-weight', '500');
    const weight = getComputedStyle(modes[1]).fontWeight;
    wb.editProp(id, 'padding-left', '12px');
    const pad = getComputedStyle(modes[2]).paddingLeft;
    const xsEl = [...document.querySelectorAll('#wb-canvas [data-wb]')].find((e) => wb.winner(Number(e.dataset.wb), 'font-size')?.value === 'var(--rv-font-size-xs)');
    wb.setToken('--rv-font-size-xs', '11.5px');
    const xs = xsEl ? fs(xsEl) : null;
    const toolbar = document.querySelector('#wb-canvas .rvc-center-analysis__toolbar');
    const density = toolbar ? toolbar.dataset.density ?? '0' : null;
    const exported = wb.exportJson();
    // Dernier geste = token, puis padding : deux annulations, deux rétablissements.
    wb.undo();
    const xsUndo = xsEl ? fs(xsEl) : null;
    wb.undo();
    const padUndo = getComputedStyle(modes[2]).paddingLeft;
    wb.redo();
    wb.redo();
    const padRedo = getComputedStyle(modes[2]).paddingLeft;
    const xsRedo = xsEl ? fs(xsEl) : null;
    return { before, afterSize, weight, pad, xs, density, exported, padUndo, padRedo, xsUndo, xsRedo, id };
  })()`);
  check('C · taille via token sur la règle (.rvi-mode : 3 onglets)', r.before.every((x) => x === '14px') && r.afterSize.every((x) => x === '16px'), `${r.before.join(',')} → ${r.afterSize.join(',')}`);
  check('C · graisse appliquée aux éléments qui partagent la règle', r.weight === '500', r.weight);
  check('C · padding appliqué', r.pad === '12px', r.pad);
  check('C · token xs modifié', r.xs === '11.5px', String(r.xs));
  check('C · densité de la barre d’analyse recalculée', r.density != null, `palier ${r.density}`);
  check('C · annuler / rétablir', r.xsUndo === '11px' && r.padUndo === '8px' && r.padRedo === '12px' && r.xsRedo === '11.5px', `xs ${r.xsUndo}/${r.xsRedo} · padding ${r.padUndo}/${r.padRedo}`);
  const ex = r.exported;
  check('C · export : format et contenu', ex.format === 'redview-workbench-changes' && ex.rules.length === 1 && ex.tokens['--rv-font-size-xs']?.to === '11.5px'
    && ex.rules[0].changes['font-size']?.to === 'var(--rv-font-size-xl)' && ex.rules[0].changes['padding-left']?.to === '12px', `${ex.rules.length} règle(s), ${Object.keys(ex.tokens).length} token(s)`);
  const bad = ex.rules.filter((rule) => {
    try {
      const src = fs.readFileSync(path.join(ROOT, rule.file), 'utf8');
      const lines = src.split('\n');
      return !(rule.line && lines[rule.line - 1]?.includes(rule.selector.split(',')[0].trim())) && !src.includes(rule.selector);
    } catch {
      return true;
    }
  });
  check('C · export : sélecteur présent dans son fichier source, à la ligne indiquée', !bad.length, ex.rules.map((x) => `${x.selector} ${x.file}:${x.line}`).join(' · '));
  // Rechargement : la sauvegarde locale restaure tout.
  await sleep(400);
  await session.send('Page.reload');
  await waitFor(session, '!!window.__wb', { timeout: 30000 });
  await sleep(800);
  const restored = await session.evaluate(`getComputedStyle(document.querySelector('#wb-canvas .rvi-mode')).fontSize`);
  check('C · rechargement : modifications restaurées (localStorage)', restored === '16px', restored);
  // Import dans une session vide.
  await session.evaluate('localStorage.clear(), 0');
  await session.send('Page.reload');
  await waitFor(session, '!!window.__wb', { timeout: 30000 });
  await sleep(600);
  const imported = await session.evaluate(`(() => {
    const el = document.querySelector('#wb-canvas .rvi-mode');
    const before = getComputedStyle(el).fontSize;
    window.__wb.importJson(${JSON.stringify(ex)});
    return { before, after: getComputedStyle(el).fontSize, pad: getComputedStyle(el).paddingLeft, n: Object.keys(window.__wb.state.changes.rules).length };
  })()`);
  check('C · import : modifications réappliquées', imported.before === '14px' && imported.after === '16px' && imported.pad === '12px', JSON.stringify(imported));
  fs.writeFileSync(path.join(OUT, 'export-exemple.json'), JSON.stringify(ex, null, 2));
}

// ── Lancement ──────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(HTML)) {
  console.error('Workbench absent : lancer `npm run workbench` d’abord.');
  process.exit(1);
}
const html = fs.readFileSync(HTML, 'utf8');
const raw = html.slice(html.indexOf('id="wb-data">') + 13, html.indexOf('</script>', html.indexOf('id="wb-data">'))).trim();
const data = JSON.parse(raw.startsWith('{') ? raw : zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
check('fichier unique < 5 Mo', html.length < 5e6, `${(html.length / 1e6).toFixed(2)} Mo`);
check('aucune ressource externe', !/(src|href)="https?:/.test(html) && !/url\(["']?https?:/.test(html));

const wbBrowser = await launch({ port: 18997 });
let appBrowser = null;
try {
  await phaseA(wbBrowser.session, data);
  await phaseD(wbBrowser.session, data);
  await phaseC(wbBrowser.session, data);
  if (WITH_APP) {
    appBrowser = await launch({ port: 18998 });
    await phaseB(appBrowser.session, wbBrowser.session, data);
  }
} finally {
  await wbBrowser.close();
  if (appBrowser) await appBrowser.close();
}
const failed = results.filter((x) => !x.ok);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} critères OK — rapport et captures : ${path.relative(ROOT, OUT)}`);
process.exit(failed.length ? 1 : 0);
