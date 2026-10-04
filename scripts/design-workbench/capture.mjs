/**
 * Capture du dashboard réel pour le workbench (Edge headless, serveur dev,
 * compte démo, trace GPX) :
 *  - DOM noir et blanc de chaque région à l'ouverture (base) ;
 *  - exploration : chaque élément cliquable (onglets, sections, interrupteurs,
 *    listes déroulantes, menus…) est cliqué dans la vraie app ; on garde le
 *    plus petit sous-arbre changé (« patch ») ou le pop-in apparu, puis on
 *    revient à l'état d'avant (Échap, re-clic, option active d'avant) et on
 *    vérifie que le DOM est identique. Ce qu'un clic révèle est exploré à son
 *    tour (3 niveaux). Le clic droit du workbench rejoue ces « déclencheurs » ;
 *  - feuilles CSS chargées et, pour chaque texte / conteneur, les déclarations
 *    candidates de chaque propriété éditable (règle, inline ou navigateur,
 *    spécificité, !important, héritage) via CSS.getMatchedStylesForNode.
 * Écrit .cache/capture.json.
 *
 * Parallèle : plusieurs navigateurs se partagent les éléments de la base ; les
 * attentes suivent le DOM (repos détecté), l'attribution CSS est mise en cache
 * par chaîne d'ancêtres ; un budget borne la durée (Ctrl+C garde le capturé).
 *
 * Usage : node scripts/design-workbench/capture.mjs [--viewport 1920x950]
 *         [--workers 5] [--budget 150 (s)] [--max <clics>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../../script-test-bench/screen-audit/cdp.mjs';
import { openEditorWithRoute, writeGpx, APP_URL } from './session.mjs';
import {
  ATTR_PROPS, TEXT_PROPS, PAINT_PROP_LIST,
  buildOriginMap, parseSheet, declaresProp, matchableSelector, splitSelectorList, specificity, cmpSpec,
} from './css.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CACHE = path.join(HERE, '.cache');
const COLLECT = fs.readFileSync(path.join(HERE, 'page-collect.js'), 'utf8').trim();

const argValue = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const [VW, VH] = (argValue('viewport') ?? '1920x950').split('x').map(Number);
const DPR = Number(argValue('dpr') ?? 1);
const MAX_CLICKS = Number(argValue('max') ?? 5000);
const MAX_DEPTH = 3;

const log = (...a) => console.log('[capture]', ...a);

// ── Exploration : quoi cliquer, quoi éviter ───────────────────────────────
const INTERACTIVE = [
  'button', '[role="tab"]', '[role="switch"]', '[role="checkbox"]:not(input)', '[role="button"]:not(button)',
  '[aria-haspopup]:not(input):not(button)', 'label:has(input[type="checkbox"])',
].join(', ');
/** Actions sur les données, navigation, carte seule : jamais cliquées. */
const EXCLUDE = [
  '.rvi-tl-row', '.rvi-tl-list__head', '.rvi-tl-list__sort', '.rvi-tl-schedule__event-card', '.rvi-tl-schedule__action',
  '.rvi-tl-schedule__event-favorite', '.rvi-tl-schedule__day', '.rvchart__plotarea',
  '.rvmvc-map-tools__slot-zoom-in', '.rvmvc-map-tools__slot-zoom-out', '.rvmvc-map-tools__slot-compass',
  '.rvmvc-map-tools__slot-fullscreen', '.rvmvc-map-tools__slot-dimension',
  // Panneaux : rejoués par le workbench lui-même (mise en page).
  '.rvmvc-map-tools__button--panel', '.rvd-place-search__panel-toggle', '.rvc-center-toolbar__button--panel-toggle',
  '.rvi-header__back', '.rvi-header__save', '.rvc-exporter-panel__submit', '.rvc-btn-primary--lidar',
  '.rvi-tracage__recalculate-btn', '.rvi-action-stack__button',
  '.rvc-altitude__meter-btn', '.rvc-slopes__deg-btn', '.rvc-routes__opacity', '.rvc-weather__threshold-number',
  '.rvi-tl-add-split__main', '.rvi-tl-add__main', '.rvc-center-toolbar__playback', '.rvc-center-toolbar__button--play',
  '.rvc-center-summary__eye-button', '.rvi-itin__eye', '.rvc-routes__eye', '[class*="band-eye"]',
  '.rvc-center-summary__fullscreen-toggle', '.rvi-place-search', '.rvd-place-search__search-shell',
  // Ne se défont pas d'un re-clic (catégories POI : recherche relancée ; puces
  // de filtre : mode « seul ») : sources de reprises, peu d'intérêt typo.
  '.rvi-checkbox', '.rvi-tl-sheet-filters__chip',
];
const EXCLUDE_LABEL = [
  'supprim', 'effac', 'retir', 'réinitialis', 'retour au', 'enregistr', 'exporter', 'télécharg', 'partag',
  'recalcul', 're-calcul', 'annuler la modif', 'rétablir', 'plein écran', 'zoomer', 'dézoomer', 'boussole',
  'vue 3d', 'vue 2d', 'flyover', 'déconnex', 'dupliquer', 'renommer', 'importer', 'charger un fichier', 'inverser', 'interdire', 'découper',
].join('|');

/** Sous-arbres qui changent d'eux-mêmes : exclus des différences de DOM. */
const IGNORE = [
  // Lignes de la feuille de route : des données, réordonnées à chaque rendu.
  '.rvi-tl-list__items',
  // Statistiques de surface : recalculées en tâche de fond.
  '.rvc-center-summary__metric',
  // Bouton « Re-calculer » (état « à recalculer » après un réglage) et tracé du
  // graphique (redessiné en tâche de fond) : changent sans clic.
  '.rvi-action-stack__button', '.rvchart__plotarea', '.rvchart__xaxis-cells',
  '.rvi-header__saved', '.rvi-header__save',
  '.rvc-center-toolbar__button[aria-label="Annuler la modification"]', '.rvc-center-toolbar__button[aria-label="Rétablir"]',
].join(', ');

async function collect(session, args) {
  return session.evaluate(`(${COLLECT})(${JSON.stringify({ paintProps: PAINT_PROP_LIST, ignore: IGNORE, ...args })})`);
}

/** Souris posée sur la carte, loin des panneaux : aucun état :hover capturé. */
async function parkMouse(session) {
  const p = await session.evaluate(`(() => {
    const r = document.querySelector('[data-rv-canvas]').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 140) };
  })()`);
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
}

async function clickAt(session, x, y, button = 'left') {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}

async function escape(session) {
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

// ── Feuilles ──────────────────────────────────────────────────────────────

/** styleSheetId → data-vite-dev-id, dans l'ordre des <style> (change à chaque session). */
async function mapSheets(session, headers) {
  const order = await session.evaluate(`[...document.querySelectorAll('style[data-vite-dev-id]')].map((s) => s.getAttribute('data-vite-dev-id'))`);
  const byDevId = new Map();
  for (const h of headers.values()) {
    if (h.origin !== 'regular' || h.ownerNode == null) continue;
    try {
      const { node } = await session.send('DOM.describeNode', { backendNodeId: h.ownerNode });
      const attrs = node.attributes ?? [];
      const i = attrs.indexOf('data-vite-dev-id');
      if (i >= 0) byDevId.set(attrs[i + 1], h);
    } catch {
      /* feuille retirée */
    }
  }
  return order.filter((d) => byDevId.has(d)).map((devId) => ({ devId, sid: byDevId.get(devId).styleSheetId }));
}

/** Analyse les feuilles une fois (identifiants de règle stables entre sessions). */
async function parseSheets(session, mapped) {
  const sheets = [];
  let nextId = 1;
  for (const { devId, sid } of mapped) {
    const { text } = await session.send('CSS.getStyleSheetText', { styleSheetId: sid });
    const origin = buildOriginMap(devId, text, ROOT);
    const parsed = parseSheet(text, nextId, origin);
    nextId = parsed.nextId;
    sheets.push({
      devId,
      file: path.relative(ROOT, devId).split(path.sep).join('/'),
      text,
      rules: parsed.rules,
      byKey: new Map(parsed.rules.map((r) => [r.key, r])),
    });
  }
  return sheets;
}

/** Règles conditionnelles (@container / @media) qui déclarent une propriété éditable. */
function conditionalRules(sheets) {
  const out = [];
  for (const s of sheets) {
    for (const r of s.rules) {
      if (!r.conds.some((c) => c.type === 'container' || c.type === 'media')) continue;
      const names = new Set(Object.keys(r.decls));
      if (!ATTR_PROPS.some((p) => declaresProp(names, p))) continue;
      for (const sel of splitSelectorList(r.selector)) {
        if (/:(hover|active|focus)/.test(sel)) continue;
        out.push({ i: r.id, sel: matchableSelector(sel), spec: specificity(sel) });
      }
    }
  }
  return out;
}

// ── Attribution ───────────────────────────────────────────────────────────

const SHORTHAND_OF = {
  'font-size': ['font'], 'font-weight': ['font'], 'line-height': ['font'],
  'padding-top': ['padding', 'padding-block'], 'padding-bottom': ['padding', 'padding-block'],
  'padding-left': ['padding', 'padding-inline'], 'padding-right': ['padding', 'padding-inline'],
  'row-gap': ['gap'], 'column-gap': ['gap'],
};

function lastDecl(style, prop) {
  if (!style?.cssProperties) return null;
  let found = null;
  let pending = false;
  for (const p of style.cssProperties) {
    if (p.name !== prop || p.disabled || p.parsedOk === false) continue;
    if (p.value === '') {
      pending = true;
      continue;
    }
    found = { value: p.value, imp: p.important ? 1 : 0 };
  }
  if (found) return found;
  // Raccourci avec var() (« font: 600 var(--rv-font-size-xs)/1 … ») : ses
  // sous-propriétés restent vides jusqu'au calcul, le candidat est le raccourci.
  for (const sh of SHORTHAND_OF[prop] ?? []) {
    const e = [...(style.shorthandEntries ?? [])].reverse().find((x) => x.name === sh);
    if (e && (pending || /var\(/.test(e.value))) return { value: `${sh}: ${e.value}`, imp: e.important ? 1 : 0 };
  }
  return null;
}

function makeRuleResolver(sheets, mapped) {
  const byDevId = new Map(sheets.map((s) => [s.devId, s]));
  const bySid = new Map(mapped.map((m) => [m.sid, byDevId.get(m.devId)]));
  return (rule) => {
    const s = bySid.get(rule.styleSheetId);
    const range = rule.selectorList?.selectors?.[0]?.range;
    if (!s || !range) return null;
    return s.byKey.get(`${range.startLine}:${range.startColumn}`) ?? null;
  };
}

function maxSpec(rm) {
  let best = [0, 0, 0];
  for (const i of rm.matchingSelectors ?? []) {
    const sp = rm.rule.selectorList.selectors[i]?.specificity;
    const v = sp ? [sp.a, sp.b, sp.c] : [0, 0, 0];
    if (cmpSpec(v, best) > 0) best = v;
  }
  return best;
}

/**
 * Candidats d'une propriété dans un bloc (règles d'un niveau + inline).
 * Format compact : [type, ruleId|null, spec 'a.b.c', imp, valeur]
 * type : r = règle d'auteur, i = style inline, u = navigateur.
 */
function candidatesFrom(matchedRules, inlineStyle, prop, resolveRule) {
  const out = [];
  for (const rm of matchedRules ?? []) {
    const d = lastDecl(rm.rule.style, prop);
    if (!d) continue;
    if (rm.rule.origin === 'user-agent') {
      out.push(['u', null, '0.0.0', d.imp, d.value]);
      continue;
    }
    if (rm.rule.origin !== 'regular') continue;
    const rule = resolveRule(rm.rule);
    out.push(['r', rule ? rule.id : null, maxSpec(rm).join('.'), d.imp, d.value]);
  }
  const inl = lastDecl(inlineStyle, prop);
  if (inl) out.push(['i', null, '1.0.0.0', inl.imp, inl.value]);
  return out;
}

/** items : [{ nodeId, id }] → { id: { prop: { o: candidats, h: hérités } } }. */
async function attribute(session, items, resolveRule, extras, condById) {
  const out = {};
  // Requêtes CDP en parallèle par paquets (une session, réponses dans l'ordre).
  const responses = [];
  for (let i = 0; i < items.length; i += 24) {
    const chunk = items.slice(i, i + 24);
    responses.push(...await Promise.all(chunk.map((it) => session.send('CSS.getMatchedStylesForNode', { nodeId: it.nodeId }).catch(() => null))));
  }
  for (let k = 0; k < items.length; k++) {
    const id = items[k].id;
    const m = responses[k];
    if (!m) continue;
    const rec = {};
    for (const prop of ATTR_PROPS) {
      const own = candidatesFrom(m.matchedCSSRules, m.inlineStyle, prop, resolveRule);
      for (const ruleId of extras[id] ?? []) {
        const c = condById.get(ruleId);
        if (!c || own.some((o) => o[1] === ruleId)) continue;
        const value = c.rule.decls[prop];
        if (value == null) continue;
        const imp = /!important$/.test(value) ? 1 : 0;
        own.push(['r', ruleId, c.spec.join('.'), imp, value.replace(/\s*!important$/, '')]);
      }
      const entry = {};
      if (own.length) entry.o = own;
      if (TEXT_PROPS.includes(prop)) {
        const inh = [];
        (m.inherited ?? []).forEach((level, depth) => {
          const c = candidatesFrom(level.matchedCSSRules, level.inlineStyle, prop, resolveRule);
          if (c.length) inh.push([depth + 1, c]);
        });
        if (inh.length) entry.h = inh;
      }
      if (entry.o || entry.h) rec[prop] = entry;
    }
    out[id] = rec;
  }
  return out;
}

// ── Session ───────────────────────────────────────────────────────────────

const gpxFile = path.join(CACHE, 'route.gpx');
let sheets = null;
let sheetsPromise = null;
let condRules = [];
const condById = new Map();
/** Clé d'attribution (chaîne d'ancêtres, page-collect) → candidats : partagé entre workers. */
const attrCache = new Map();

/** Analyse les feuilles une seule fois (identifiants de règle identiques dans tous les workers). */
async function ensureSheets(session, mapped) {
  sheetsPromise ??= (async () => {
    sheets = await parseSheets(session, mapped);
    condRules = conditionalRules(sheets);
    for (const s of sheets) for (const r of s.rules) {
      const c = condRules.filter((x) => x.i === r.id);
      if (c.length) condById.set(r.id, { rule: r, spec: c.reduce((m, x) => (cmpSpec(x.spec, m) > 0 ? x.spec : m), [0, 0, 0]) });
    }
    log(`${sheets.length} feuilles, ${sheets.reduce((n, s) => n + s.rules.length, 0)} règles`);
  })();
  await sheetsPromise;
}

/** Ouvre l'app avec le projet tracé, CSS suivi, résolveur de règles à jour. */
async function startSession(port, { fullRows = false } = {}) {
  const browser = await launch({ port });
  const { session } = browser;
  // Worker 0 : attend les lignes POI ajoutées par le serveur (base complète).
  await openEditorWithRoute(session, gpxFile, { width: VW, height: VH, dpr: DPR, settleMs: fullRows ? 2200 : 300 });
  await session.evaluate('document.fonts.ready.then(() => 1)');
  const headers = new Map();
  session.on('CSS.styleSheetAdded', (p) => headers.set(p.header.styleSheetId, p.header));
  await session.send('CSS.enable');
  await sleep(150);
  const mapped = await mapSheets(session, headers);
  await ensureSheets(session, mapped);
  await session.send('CSS.startRuleUsageTracking');
  return { ...browser, headers, mapped, resolveRule: makeRuleResolver(sheets, mapped) };
}

// ── Capture ───────────────────────────────────────────────────────────────

const WORKERS = Math.max(1, Number(argValue('workers') ?? 6));
const BUDGET_MS = Number(argValue('budget') ?? 140) * 1000;
const BASE_PORT = Number(process.env.CDP_PORT ?? 18993);
const started = Date.now();
const deadline = started + BUDGET_MS;
let totalClicks = 0;
let interrupted = false;
process.once('SIGINT', () => {
  interrupted = true;
  log('interruption : on termine et on enregistre ce qui est capturé…');
});
const outOfTime = () => interrupted || Date.now() > deadline || totalClicks >= MAX_CLICKS;
/** File commune des éléments de la base : chaque worker prend le suivant dès qu'il est libre. */
let baseQueue = null;
let nextBase = 0;
/** Remplie par le worker 0 (app entièrement chargée), attendue par les autres. */
let resolveQueue;
const queueReady = new Promise((r) => { resolveQueue = r; });

const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const famOfSig = (sig) => sig.split('|')[0];

/**
 * Un worker = un navigateur. Les éléments cliquables de la base sont répartis
 * entre workers (hachage stable), chacun explore ce qu'ils révèlent.
 */
async function runWorker(k) {
  const tag = `w${k}`;
  const wlog = (...a) => log(`[${tag}]`, ...a);
  let S = await startSession(BASE_PORT + k, { fullRows: k === 0 });
  wlog(`prêt en ${((Date.now() - started) / 1000).toFixed(0)} s`);
  let nextId = k * 10_000_000 + 1;
  const meta = {};
  const attr = {};
  const icons = new Set();
  const triggers = [];
  const byId = new Map();
  let clicks = 0;
  let recoveries = 0;
  const usedDevIds = new Set();

  async function collectUsage() {
    try {
      const usage = await S.session.send('CSS.stopRuleUsageTracking');
      const used = new Set(usage.ruleUsage.filter((u) => u.used).map((u) => u.styleSheetId));
      for (const m of S.mapped) if (used.has(m.sid)) usedDevIds.add(m.devId);
    } catch {
      /* session fermée */
    }
  }

  /** Sérialise (patchs / régions / calques) puis attribue les éléments nouveaux (cache). */
  async function serialize(ops) {
    await collect(S.session, { op: 'clear' });
    const results = [];
    for (const op of ops) {
      const res = await collect(S.session, { ...op, startId: nextId });
      nextId = res.nextId;
      res.icons.forEach((i) => icons.add(i));
      results.push(res);
      Object.assign(meta, res.meta);
    }
    const marks = await S.session.evaluate(`[...document.querySelectorAll('[data-wbq]')].map((e) => [+e.getAttribute('data-wbq'), e.getAttribute('data-wbk')])`);
    const missing = [];
    marks.forEach((m, i) => { if (!attrCache.has(m[1])) missing.push(i); });
    if (missing.length) {
      const extras = await collect(S.session, { op: 'match', rules: condRules.map(({ i, sel }) => ({ i, sel })) });
      const { root } = await S.session.send('DOM.getDocument', { depth: 0 });
      const { nodeIds } = await S.session.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-wbq]' });
      if (nodeIds.length !== marks.length) throw new Error(`attribution : ${nodeIds.length} nœuds pour ${marks.length} marques`);
      const recs = await attribute(S.session, missing.map((i) => ({ nodeId: nodeIds[i], id: marks[i][0] })), S.resolveRule, extras, condById);
      for (const i of missing) attrCache.set(marks[i][1], recs[marks[i][0]] ?? {});
    }
    for (const [id, key] of marks) {
      const rec = attrCache.get(key);
      if (rec && Object.keys(rec).length) attr[id] = rec;
    }
    await collect(S.session, { op: 'clear' });
    return results;
  }

  async function settle(quiet = 150) {
    await parkMouse(S.session);
    await collect(S.session, { op: 'settle', quiet, max: 1600 });
  }

  async function clickTarget(key, path, sig = null) {
    const t = await collect(S.session, { op: 'target', key, path });
    if (!t || !t.ok || (sig && t.sig !== sig)) return null;
    if (t.synthetic) await collect(S.session, { op: 'click', key, path });
    else await clickAt(S.session, t.x, t.y);
    clicks++;
    totalClicks++;
    return t;
  }

  const isRestored = (level) => collect(S.session, { op: 'restored', level });

  async function restore(level, attempts) {
    for (const attempt of attempts) {
      const r = await isRestored(level);
      if (r.ok) return true;
      await attempt();
      await settle();
    }
    const r = await isRestored(level);
    if (!r.ok && process.env.WB_DEBUG) for (const d of r.patches) wlog(`    ≠ ${d.key} [${d.path.join('.')}] ${d.type} .${d.cls}`);
    return r.ok;
  }

  /** Session neuve et rejeu du contexte (quand un retour en arrière échoue). */
  async function recover(ctx) {
    recoveries++;
    wlog(`  ↻ reprise ${recoveries} (contexte ${ctx.length ? ctx.map((id) => byId.get(id).label.slice(0, 20)).join(' › ') : 'base'})`);
    await collectUsage();
    await S.close();
    S = await startSession(BASE_PORT + k);
    for (let i = 0; i < ctx.length; i++) {
      const t = byId.get(ctx[i]);
      await collect(S.session, { op: 'pre', level: i });
      if (!(await clickTarget(t.target.key, t.target.path))) throw new Error(`reprise impossible : ${t.label}`);
      await settle();
    }
    await collect(S.session, { op: 'pre', level: ctx.length });
  }

  const addTrigger = (t) => {
    t.id = triggers.length + 1;
    triggers.push(t);
    byId.set(t.id, t);
    return t;
  };

  const popupFamilies = new Map();
  const visited = new Set();
  const famCount = new Map();
  const exploredAt = new Map();

  async function explore(ctx, scope, depth) {
    // Base : file commune (le worker 0, app chargée, la remplit ; tous y puisent).
    let cands = [];
    if (depth === 0 && k !== 0) cands = await queueReady;
    else cands = await collect(S.session, { op: 'candidates', scope, exclude: EXCLUDE, excludeLabel: EXCLUDE_LABEL, interactive: INTERACTIVE });
    if (depth === 0 && k === 0) {
      baseQueue = cands;
      resolveQueue(cands);
    }
    const list = depth === 0 ? baseQueue : cands;
    for (const c of list) famCount.set(`${ctx.join('>')}|${c.fam}`, (famCount.get(`${ctx.join('>')}|${c.fam}`) ?? 0) + 1);
    const parent = ctx.length ? byId.get(ctx[ctx.length - 1]) : null;
    let i = 0;
    while (true) {
      if (outOfTime()) return;
      const c = depth === 0 ? baseQueue[nextBase++] : cands[i++];
      if (!c) return;
      // Autres options du groupe du déclencheur parent (onglet POI vu depuis
      // Rythme) : déjà capturées depuis la base, le workbench les remplace l'une
      // par l'autre. On ne garde que le re-clic et l'option active d'avant.
      const isParentTarget = parent && c.key === parent.target.key
        && (samePath(c.path, parent.target.path) || (parent.radioPath && samePath(c.path, parent.radioPath.path)));
      // Re-clic du parent / option active d'avant : le workbench en déduit le
      // retour (il retire le parent), inutile de le cliquer.
      if (isParentTarget) continue;
      if (parent && c.key === parent.target.key && famOfSig(c.sig) === famOfSig(parent.target.sig)
        && samePath(c.path.slice(0, -1), parent.target.path.slice(0, -1))) continue;
      const vkey = `${ctx.join('>')}|${c.key}|${c.path.join('.')}`;
      if (visited.has(vkey)) continue;
      visited.add(vkey);
      // Déjà capturée dans un contexte parent (même élément, même libellé) : le
      // workbench rejoue celle-là.
      const tkey = `${c.key}|${c.path.join('.')}|${c.sig}`;
      const seenIn = exploredAt.get(tkey) ?? [];
      if (!isParentTarget && seenIn.some((sc) => sc.length < ctx.length && sc.every((v, i) => v === ctx[i]))) continue;
      exploredAt.set(tkey, [...seenIn, ctx.slice()]);
      // Grandes familles de pop-ins identiques (pastilles de couleur, alertes) : la
      // première est capturée, les autres la rejouent à leur place.
      const famKey = `${ctx.join('>')}|${c.fam}`;
      const fam = popupFamilies.get(famKey);
      if (fam && (famCount.get(famKey) ?? 0) >= 10) {
        fam.aliases.push({ key: c.key, path: c.path, sig: c.sig });
        continue;
      }
      await exploreOne(c, ctx, depth);
    }
  }

  async function exploreOne(c, ctx, depth) {
    await collect(S.session, { op: 'clear' });
    await collect(S.session, { op: 'pre', level: depth });
    const t = await clickTarget(c.key, c.path, c.sig);
    if (!t) return;
    await settle();
    const post = await collect(S.session, { op: 'post', level: depth > 0 ? depth - 1 : null });
    const label = c.label || c.fam;
    const where = `${'  '.repeat(depth)}${ctx.length ? '↳ ' : ''}${label.slice(0, 40)}`;
    const target = { key: c.key, path: c.path, sig: c.sig };
    const reclick = async () => { await clickTarget(c.key, c.path); };

    if (!post.patches.length && !post.layers.length) {
      await collect(S.session, { op: 'unmark' });
      if (!(await restore(depth, [async () => escape(S.session)]))) await recover(ctx);
      return;
    }

    if (post.inverse && depth > 0) {
      // Revient à l'état d'avant le dernier déclencheur du contexte (onglet
      // d'avant, section refermée) : le workbench retire ce déclencheur.
      const parent = byId.get(ctx[ctx.length - 1]);
      addTrigger({ kind: 'inverse', of: parent.id, ctx: ctx.slice(), target, label });
      if (process.env.WB_DEBUG) wlog(`${where} → retour`);
      await collect(S.session, { op: 'unmark' });
      const ok = await restore(depth, [async () => { await clickTarget(parent.target.key, parent.target.path); }]);
      if (!ok) await recover(ctx);
      return;
    }

    const isPopup = post.layers.length > 0 || post.popupNode || c.hasPopup;
    const patchOps = post.patches.length ? [{ op: 'patches', patches: post.patches.map(({ key, path, type }) => ({ key, path, type })) }] : [];
    const layerOps = post.layers.length ? [{ op: 'nodes', nodes: post.layers.map((selector, i) => ({ key: `layer-${i}`, selector })) }] : [];
    const res = await serialize([...patchOps, ...layerOps]);
    const patches = patchOps.length ? res[0].regions.map((r) => ({ key: r.key, path: r.path, type: r.type, html: r.html })) : [];
    const layers = layerOps.length ? res[patchOps.length].regions.map((r) => ({ html: r.html, rect: r.rect })) : [];
    await collect(S.session, { op: 'unmark' });

    if (isPopup) {
      const trig = addTrigger({ kind: 'popup', ctx: ctx.slice(), target, label, anchorRect: t.rect, patches, layers, aliases: [] });
      popupFamilies.set(`${ctx.join('>')}|${c.fam}`, trig);
      wlog(`${where} → pop-in`);
      const ok = await restore(depth, [
        async () => escape(S.session),
        reclick,
        async () => escape(S.session),
        async () => {
          const p = await S.session.evaluate(`(() => { const r = document.querySelector('[data-rv-canvas]').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 160) }; })()`);
          await clickAt(S.session, p.x, p.y);
        },
      ]);
      if (!ok) await recover(ctx);
      return;
    }

    const trig = addTrigger({ kind: 'persist', radio: !!c.radio, radioPath: c.radio, ctx: ctx.slice(), target, label, patches });
    wlog(`${where} → état`);
    if (depth + 1 < MAX_DEPTH) {
      const scope = patches.filter((p) => p.type === 'replace').map((p) => ({ key: p.key, path: p.path }));
      if (scope.length) {
        await collect(S.session, { op: 'pre', level: depth + 1 });
        await explore([...ctx, trig.id], scope, depth + 1);
      }
    }
    const back = c.radio ? async () => { await clickTarget(c.radio.key, c.radio.path); } : reclick;
    const closeInside = async () => {
      const q = await collect(S.session, { op: 'closeIn', scope: patches.map((pt) => ({ key: pt.key, path: pt.path })) });
      if (q) await clickAt(S.session, q.x, q.y);
    };
    const fixExpanded = async () => {
      for (const q of await collect(S.session, { op: 'fixExpanded', level: depth })) await clickAt(S.session, q.x, q.y);
    };
    const ok = await restore(depth, [back, fixExpanded, closeInside, back, async () => escape(S.session)]);
    if (!ok) await recover(ctx);
  }

  // Base (worker 0) : tout le dashboard tel qu'il s'ouvre.
  let base = null;
  let b = null;
  if (k === 0) {
    await settle(400);
    [b] = await serialize([{ op: 'regions' }]);
    base = Object.fromEntries(b.regions.map((r) => [r.key, { html: r.html, z: r.z }]));
    wlog(`base : ${b.regions.length} régions, échelle ${b.appScale}, canevas ${b.canvas.w}×${b.canvas.h}`);
    const shot = await S.session.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(CACHE, 'app-base.png'), Buffer.from(shot.data, 'base64'));
  }

  await collect(S.session, { op: 'pre', level: 0 });
  try {
    await explore([], null, 0);
  } catch (err) {
    wlog(`! exploration interrompue : ${err.message}`);
  }

  // Menu contextuel de la carte (clic droit sur la carte dans l'app aussi).
  if (k === 0 && !interrupted) {
    await collect(S.session, { op: 'clear' });
    await collect(S.session, { op: 'pre', level: 0 });
    const p = await S.session.evaluate(`(() => { const t = document.querySelector('[data-rv-region="center-toolbar"]').getBoundingClientRect(); return { x: Math.round(t.left + t.width / 2), y: Math.round(t.top - 200) }; })()`);
    await clickAt(S.session, p.x, p.y, 'right');
    await settle();
    const post = await collect(S.session, { op: 'post' });
    if (post.patches.length || post.layers.length) {
      const res = await serialize([
        ...(post.patches.length ? [{ op: 'patches', patches: post.patches.map(({ key, path, type }) => ({ key, path, type })) }] : []),
        ...(post.layers.length ? [{ op: 'nodes', nodes: post.layers.map((selector, i) => ({ key: `layer-${i}`, selector })) }] : []),
      ]);
      const patches = post.patches.length ? res[0].regions.map((r) => ({ key: r.key, path: r.path, type: r.type, html: r.html })) : [];
      const layers = post.layers.length ? res[res.length - 1].regions.map((r) => ({ html: r.html, rect: r.rect })) : [];
      addTrigger({ kind: 'popup', ctx: [], target: { key: 'map', path: [], sig: 'map' }, label: 'Menu contextuel de la carte', contextMenu: true, anchorRect: null, patches, layers, aliases: [] });
    }
    await collect(S.session, { op: 'unmark' });
  }

  await collectUsage();
  await S.close();
  wlog(`fini : ${clicks} clics, ${triggers.length} déclencheurs, ${recoveries} reprise(s)`);
  return { base, b, triggers, meta, attr, icons, usedDevIds, clicks, recoveries };
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  writeGpx(gpxFile);
  log(`${WORKERS} workers (Edge headless, ports ${BASE_PORT}+), ${VW}×${VH} @${DPR}, budget ${BUDGET_MS / 1000} s, ${APP_URL}`);
  const results = await Promise.all(Array.from({ length: WORKERS }, (_, k) => runWorker(k).catch((err) => {
    log(`[w${k}] ! ${err.message}`);
    if (k === 0) resolveQueue([]);
    return null;
  })));
  const main0 = results[0];
  if (!main0?.base) throw new Error('le worker 0 n’a pas capturé la base');

  // Fusion : identifiants de déclencheurs globaux, contextes renumérotés.
  const triggers = [];
  const meta = {};
  const attr = {};
  const icons = new Set();
  const usedDevIds = new Set();
  let clicks = 0;
  let recoveries = 0;
  for (const r of results) {
    if (!r) continue;
    const map = new Map(r.triggers.map((t, i) => [t.id, triggers.length + i + 1]));
    for (const t of r.triggers) {
      triggers.push({ ...t, id: map.get(t.id), ctx: t.ctx.map((c) => map.get(c)), ...(t.of != null ? { of: map.get(t.of) } : {}) });
    }
    Object.assign(meta, r.meta);
    Object.assign(attr, r.attr);
    r.icons.forEach((i) => icons.add(i));
    r.usedDevIds.forEach((d) => usedDevIds.add(d));
    clicks += r.clicks;
    recoveries += r.recoveries;
  }

  const referenced = new Set();
  for (const rec of Object.values(attr)) for (const e of Object.values(rec)) {
    for (const c of e.o ?? []) if (c[1]) referenced.add(c[1]);
    for (const [, cs] of e.h ?? []) for (const c of cs) if (c[1]) referenced.add(c[1]);
  }
  const keptSheets = sheets.filter((s) => usedDevIds.has(s.devId) || s.rules.some((r) => referenced.has(r.id)));

  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch {
    /* hors git */
  }
  const capture = {
    meta: { builtAt: new Date().toISOString(), commit, lang: 'fr', viewport: { w: VW, h: VH, dpr: DPR }, appScale: main0.b.appScale, canvas: main0.b.canvas },
    sheets: keptSheets.map((s) => ({ devId: s.devId, file: s.file, text: s.text, firstId: s.rules[0]?.id ?? null })),
    base: main0.base,
    triggers,
    meta2: meta,
    attr,
    icons: [...icons],
  };
  fs.writeFileSync(path.join(CACHE, 'capture.json'), JSON.stringify(capture));
  const kinds = triggers.reduce((m, t) => ({ ...m, [t.kind]: (m[t.kind] ?? 0) + 1 }), {});
  const size = fs.statSync(path.join(CACHE, 'capture.json')).size;
  log(`OK — ${((Date.now() - started) / 1000).toFixed(0)} s, ${clicks} clics, ${triggers.length} déclencheurs ${JSON.stringify(kinds)}, ${recoveries} reprise(s), ${attrCache.size} attributions, ${(size / 1e6).toFixed(1)} Mo${Date.now() > deadline ? ' (budget atteint)' : ''}`);
}

await main();
