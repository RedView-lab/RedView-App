/*
 * RedView Workbench — runtime (inliné dans le HTML par build.mjs).
 *
 * La scène est le DOM capturé du dashboard (feuilles CSS de l'app, peinture
 * remplacée par des gris). La mise en page vient des vrais modules de l'app
 * (window.RVLayout : appScale.ts, Dashboard/lib/layout.ts…). Une modification
 * de typo ou d'espacement s'écrit dans la règle CSSOM d'origine (retrouvée par
 * `--wb-r`) : même cascade que l'app, appliquée à tous les éléments et tous
 * les états qui utilisent la règle. Export / import en JSON.
 */
(async () => {
  'use strict';

  /** Données de la capture : JSON compressé (gzip, base64), décompressé ici. */
  async function loadData() {
    const raw = document.getElementById('wb-data').textContent.trim();
    if (raw.startsWith('{')) return JSON.parse(raw);
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }
  const DATA = await loadData();
  const L = window.RVLayout;
  const PROPS = DATA.meta.props;
  const TEXT_PROPS = ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform'];
  const PAD = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
  const LAYOUT_EDIT = [...PAD, 'row-gap', 'column-gap', 'height', 'min-height', 'width'];
  const STORE_KEY = `rv-workbench:${DATA.meta.commit || 'local'}:${DATA.meta.builtAt}`;
  const PREFS_KEY = 'rv-workbench:prefs';
  const FORMAT = 'redview-workbench-changes';
  const WEIGHTS = ['400', '500', '600', '700'];
  const WEIGHT_NAMES = { 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold' };

  /** Table des rôles de src/shared/styles/typography.css (token, graisse). */
  const ROLES = [
    ['xl', '600', 'Titre de panneau'],
    ['2xl', '600', 'Titre de dialogue, statistique clef'],
    ['lg', '600', 'Titre de section, onglet, titre de ligne, titre de pop-in, champ de recherche'],
    ['lg', '400', 'Titre de groupe de champs'],
    ['lg', '500', 'Grand contrôle (≥ 36 px), bouton pleine largeur'],
    ['md', '500', 'Label de champ (atténué 64 %)'],
    ['md', '600', 'Valeur de contrôle, bouton, item de menu'],
    ['sm', '500', 'Compact : grille dense, barre d’outils, chip de filtre'],
    ['sm', '400', 'Texte d’aide, info-bulle, notice, statut'],
    ['xs', '500', 'Légende : méta, unité, borne, repère de curseur'],
    ['xs', '600', 'En-tête de tableau, graduation d’axe, badge'],
    ['xs', '700', 'Badge, surtitre (uppercase)'],
    ['2xs', '500', 'Micro : chiffre de pastille'],
    ['2xs', '700', 'Micro : glyphe'],
    ['3xs', '700', 'Badge posé sur la carte'],
  ];

  // ── Utilitaires ─────────────────────────────────────────────────────────
  const safe = {
    get(key) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* stockage indisponible : la session continue sans sauvegarde */
      }
    },
  };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k === 'value') value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    if (value != null) el.value = value;
    return el;
  }

  const cmpArr = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const fmt = (v, d = 2) => String(round(v, d)).replace('.', ',');
  const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const basename = (f) => (f || '').replace(/^src\//, '').replace(/^.*\/styles\//, '…/');

  // ── Scène ───────────────────────────────────────────────────────────────
  const stage = document.getElementById('wb-stage');
  const canvas = document.getElementById('wb-canvas');
  const portal = document.getElementById('wb-portal');
  canvas.appendChild(portal);
  const uiRoot = document.getElementById('wb-ui');

  const appSheet = document.getElementById('wb-app').sheet;
  const ruleById = new Map();
  (function index(list) {
    for (const r of list) {
      if (r.style && r.selectorText != null) {
        const v = r.style.getPropertyValue('--wb-r');
        if (v) ruleById.set(Number(v), r);
      }
      if (r.cssRules && r.cssRules.length) index(r.cssRules);
    }
  })(appSheet.cssRules);
  const overrideStyle = document.head.appendChild(h('style', { id: 'wb-overrides' }));

  /** Éléments par règle (tous états confondus) : comptes et échantillons de l'export. */
  const elementsByRule = new Map();
  for (const [id, arr] of Object.entries(DATA.attr)) {
    for (const si of arr) {
      if (si < 0) continue;
      for (const c of DATA.sets[si].o || []) {
        if (c[0] !== 'r' || c[1] == null) continue;
        let s = elementsByRule.get(c[1]);
        if (!s) elementsByRule.set(c[1], (s = new Set()));
        s.add(Number(id));
      }
    }
  }

  const DEFAULT_SCALE = L.scaleModule.__wbScaleParams();
  const tokenByName = new Map(DATA.tokens.map((t) => [t.name, t]));

  const state = {
    changes: { rules: {}, tokens: {}, elements: {}, scale: {}, notes: {} },
    // Déclencheurs capturés appliqués (dans l'ordre) et pop-in ouvert.
    view: { applied: [], popup: null, anchor: null },
    ui: { leftWidth: null, rightWidth: null, centerHeight: undefined, leftCollapsed: false, rightCollapsed: false, centerCollapsed: false, scaleForce: null, sidePriority: 'right' },
    prefs: { tab: 'inspect', x: null, y: null, collapsed: false, hidden: false, annotations: false, author: '', note: '', target: 'all' },
    selected: null,
    hover: null,
    ref: { src: null, opacity: 0.5, diff: false, scale: 'auto' },
  };
  const history = [];
  const redo = [];

  // ── Rendu : base + déclencheurs appliqués + pop-in ──────────────────────
  const TRIG = new Map(DATA.triggers.map((t) => [t.id, t]));
  /** Cibles par chemin (région + index d'enfants) → déclencheurs possibles. */
  const triggersByPath = new Map();
  const addTarget = (t, target, alias) => {
    const k = `${target.key}|${target.path.join('.')}`;
    if (!triggersByPath.has(k)) triggersByPath.set(k, []);
    triggersByPath.get(k).push({ t, sig: target.sig, alias: alias ? target : null });
  };
  for (const t of DATA.triggers) {
    if (t.contextMenu) continue;
    addTarget(t, t.target, false);
    for (const a of t.aliases || []) addTarget(t, a, true);
  }

  const regionEls = new Map();
  const tpl = document.createElement('template');
  const fromHtml = (html) => {
    tpl.innerHTML = html;
    return tpl.content.firstElementChild;
  };
  const fromSvg = (html) => {
    tpl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${html}</svg>`;
    return tpl.content.firstElementChild.firstElementChild;
  };
  const currentPopup = () => (state.view.popup ? TRIG.get(state.view.popup) : null);

  function nodeAt(key, path) {
    let el = regionEls.get(key);
    for (const i of path) {
      if (!el) return null;
      el = el.children[i];
    }
    return el || null;
  }

  function pathOfEl(el) {
    const path = [];
    let n = el;
    while (n && n.parentElement !== canvas) {
      if (!n.parentElement || n === canvas) return null;
      path.unshift([...n.parentElement.children].indexOf(n));
      n = n.parentElement;
    }
    if (!n) return null;
    for (const [key, root] of regionEls) if (root === n) return { key, path };
    return null;
  }

  function applyPatches(t) {
    for (const p of t.patches || []) {
      const node = nodeAt(p.key, p.path);
      if (!node) continue;
      const fresh = node instanceof SVGElement && node.tagName !== 'svg' ? fromSvg(p.html) : fromHtml(p.html);
      if (!fresh) continue;
      if (p.type === 'attrs') {
        for (const a of [...node.attributes]) node.removeAttribute(a.name);
        for (const a of fresh.attributes) node.setAttribute(a.name, a.value);
      } else {
        node.replaceWith(fresh);
        if (!p.path.length) regionEls.set(p.key, fresh);
      }
    }
  }

  /** Défilements des panneaux gardés d'un rendu à l'autre. */
  function saveScrolls() {
    const out = [];
    for (const el of canvas.querySelectorAll('*')) {
      if (el.scrollTop || el.scrollLeft) {
        const where = pathOfEl(el);
        if (where) out.push({ ...where, top: el.scrollTop, left: el.scrollLeft });
      }
    }
    return out;
  }

  let lastTouched = new Set(DATA.order);
  function renderRegions() {
    const scrolls = regionEls.size ? saveScrolls() : [];
    const active = [...state.view.applied, state.view.popup].filter((id) => id != null && TRIG.has(id)).map((id) => TRIG.get(id));
    const touched = new Set(active.flatMap((t) => (t.patches || []).map((p) => p.key)));
    for (const key of DATA.order) {
      if (regionEls.get(key) && !touched.has(key) && !lastTouched.has(key)) continue;
      const el = fromHtml(DATA.base[key]);
      const old = regionEls.get(key);
      if (old) old.replaceWith(el);
      else canvas.insertBefore(el, portal);
      regionEls.set(key, el);
    }
    for (const t of active) applyPatches(t);
    lastTouched = touched;
    portal.textContent = '';
    const pop = currentPopup();
    if (pop) for (const layer of pop.layers || []) {
      const el = fromHtml(layer.html);
      el.__wbRect = layer.rect;
      portal.appendChild(el);
    }
    for (const sc of scrolls) {
      const el = nodeAt(sc.key, sc.path);
      if (el) {
        el.scrollTop = sc.top;
        el.scrollLeft = sc.left;
      }
    }
    if (state.selected != null && !elById(state.selected)) state.selected = null;
    onDomChanged();
  }

  const elById = (id) => canvas.querySelector(`[data-wb="${id}"]`);

  function logicalRect(el) {
    const r = el.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const s = layout ? layout.appScale : 1;
    return [(r.left - c.left) / s, (r.top - c.top) / s, r.width / s, r.height / s];
  }

  function positionLayers() {
    const pop = currentPopup();
    if (!pop) return;
    let dx = 0, dy = 0;
    // Pop-in ancré sur l'élément cliqué (ou sur un membre de la même famille).
    const anchor = state.view.anchor || pop.target;
    if (anchor && pop.anchorRect && anchor.key !== 'map') {
      const a = nodeAt(anchor.key, anchor.path);
      if (a) {
        const r = logicalRect(a);
        dx = r[0] - pop.anchorRect[0];
        dy = r[1] - pop.anchorRect[1];
      }
    }
    const capW = DATA.meta.canvas.w, capH = DATA.meta.canvas.h;
    for (const el of portal.children) {
      const r = el.__wbRect;
      if (!r) continue;
      const full = r[2] >= capW - 2 && r[3] >= capH - 2;
      el.style.inset = 'auto';
      el.style.position = 'absolute';
      el.style.margin = '0';
      el.style.zoom = '1';
      el.style.transform = 'none';
      if (full) {
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.width = `${canvas.offsetWidth}px`;
        el.style.height = `${canvas.offsetHeight}px`;
      } else {
        el.style.left = `${r[0] + dx}px`;
        el.style.top = `${r[1] + dy}px`;
      }
    }
  }

  // ── Clic droit = clic dans l'app (déclencheurs capturés) ───────────────
  const famOf = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => !/^(is-|wb-)|--(active|on|open)$/.test(c)).sort().join('.')}`;
  const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const sigOf = (el) => `${famOf(el)}|${labelOf(el)}`;
  const isApplied = (id) => state.view.applied.includes(id);

  /** Déclencheur de l'élément (ou d'un ancêtre) valable dans l'état courant. */
  function triggerFor(el) {
    for (let n = el; n && n !== canvas; n = n.parentElement) {
      const where = pathOfEl(n);
      if (!where) continue;
      const list = triggersByPath.get(`${where.key}|${where.path.join('.')}`);
      if (!list) continue;
      const sig = sigOf(n);
      let best = null;
      for (const entry of list) {
        if (entry.sig !== sig && famOf(n) !== entry.sig.split('|')[0]) continue;
        const t = entry.t;
        if (!t.ctx.every(isApplied)) continue;
        const score = (entry.sig === sig ? 1000 : 0) + t.ctx.length * 10 + (t.kind === 'inverse' ? 5 : 0);
        if (!best || score > best.score || (score === best.score && t.id > best.t.id)) best = { t, score, anchor: entry.alias ? where : null };
      }
      if (best) return best;
    }
    return null;
  }

  /** Déclencheur appliqué que ce clic défait (re-clic de sa cible, ou de l'option d'avant). */
  function undoFor(el) {
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    for (let n = el; n && n !== canvas; n = n.parentElement) {
      const where = pathOfEl(n);
      if (!where) continue;
      for (const id of [...state.view.applied].reverse()) {
        const t = TRIG.get(id);
        if (t.kind !== 'persist' || t.target.key !== where.key) continue;
        if (!t.radio && same(t.target.path, where.path)) return id;
        if (t.radioPath && t.radioPath.key === where.key && same(t.radioPath.path, where.path)) return id;
      }
    }
    return null;
  }

  /** Retire un déclencheur et ceux qui en dépendent (capturés dans son contexte). */
  function removeTrigger(id) {
    const gone = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const x of state.view.applied) {
        if (!gone.has(x) && TRIG.get(x).ctx.some((c) => gone.has(c))) {
          gone.add(x);
          changed = true;
        }
      }
    }
    state.view.applied = state.view.applied.filter((x) => !gone.has(x));
  }

  const overlaps = (a, b) => a.key === b.key && (a.path.length <= b.path.length ? a.path.every((v, i) => v === b.path[i]) : b.path.every((v, i) => v === a.path[i]));

  function applyTrigger(t, anchor = null) {
    if (t.kind === 'popup') {
      state.view.popup = t.id;
      state.view.anchor = anchor;
      return;
    }
    if (t.kind === 'inverse') {
      removeTrigger(t.of);
      return;
    }
    if (isApplied(t.id)) {
      removeTrigger(t.id);
      return;
    }
    // Re-clic du déclencheur parent ou de son option active d'avant (onglet
    // Traçage vu depuis Rythme) : retour à l'état d'avant le parent.
    const parent = t.ctx.length ? TRIG.get(t.ctx[t.ctx.length - 1]) : null;
    const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (parent && t.kind === 'persist' && isApplied(parent.id) && t.target.key === parent.target.key
      && (samePath(t.target.path, parent.target.path) || (parent.radioPath && samePath(t.target.path, parent.radioPath.path)))) {
      removeTrigger(parent.id);
      return;
    }
    // Ce que le déclencheur remplace (autre onglet du groupe, même sous-arbre).
    for (const id of [...state.view.applied]) {
      if (t.ctx.includes(id) || !isApplied(id)) continue;
      const u = TRIG.get(id);
      if ((u.patches || []).some((pu) => (t.patches || []).some((pt) => overlaps(pu, pt)))) removeTrigger(id);
    }
    state.view.applied.push(t.id);
  }

  function setState(applied, popup = null, anchor = null) {
    state.view.applied = applied.filter((id) => TRIG.has(id));
    state.view.popup = popup;
    state.view.anchor = anchor;
    save();
    renderRegions();
    if (state.prefs.tab === 'screen') renderPanel();
  }

  /** Toggles de panneaux : la mise en page du workbench, comme dans l'app. */
  function panelToggle(el) {
    if (el.closest('.rvmvc-map-tools__button--panel')) return 'rightCollapsed';
    if (el.closest('.rvd-place-search__panel-toggle')) return 'leftCollapsed';
    if (el.closest('.rvc-center-toolbar__button--panel-toggle')) return 'centerCollapsed';
    return null;
  }

  function onRightClick(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !stage.contains(hit)) return;
    const pop = currentPopup();
    if (pop) {
      // Un clic dans le menu le referme (choix) ; dehors, il se referme et le clic continue.
      const inside = portal.contains(hit) || (pop.patches || []).some((p) => nodeAt(p.key, p.path)?.contains(hit));
      state.view.popup = null;
      state.view.anchor = null;
      if (inside) {
        setState(state.view.applied);
        return;
      }
    }
    const toggle = panelToggle(hit);
    if (toggle) {
      state.ui[toggle] = !state.ui[toggle];
      setState(state.view.applied);
      relayout();
      return;
    }
    // Re-clic d'un déclencheur appliqué (section, interrupteur) ou de l'option
    // active d'avant (onglet Traçage vu depuis Rythme) : retour à l'état d'avant.
    const undo = undoFor(hit);
    if (undo != null) {
      removeTrigger(undo);
      setState(state.view.applied, state.view.popup, state.view.anchor);
      return;
    }
    const found = triggerFor(hit);
    if (found) {
      applyTrigger(found.t, found.anchor);
      setState(state.view.applied, state.view.popup, state.view.anchor);
      return;
    }
    const menu = DATA.triggers.find((t) => t.contextMenu);
    if (menu && regionEls.get('map')?.contains(hit)) {
      setState(state.view.applied, menu.id);
      return;
    }
    if (pop) setState(state.view.applied);
    else toast('Pas d’action capturée sur cet élément');
  }

  /** Libellé d'un déclencheur avec son contexte (« Rythme › Profil de rythme »). */
  function triggerLabel(t) {
    return [...t.ctx.map((id) => TRIG.get(id)?.label), t.label].filter(Boolean).map((l) => short(l, 28)).join(' › ');
  }

  // ── Mise en page (vrais modules de l'app) ───────────────────────────────
  let layout = null;
  const UNITLESS = new Set(['zIndex', 'opacity', 'flex', 'flexGrow', 'flexShrink', 'order', 'lineHeight', 'fontWeight', 'zoom']);
  function applyStyle(el, obj) {
    if (!el) return;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'transition' || k === 'willChange') continue;
      const val = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v == null ? '' : String(v);
      if (k.startsWith('--')) el.style.setProperty(k, val);
      else el.style[k] = val;
    }
  }

  function effectiveScaleParams() {
    const p = { ...DEFAULT_SCALE };
    for (const [k, ch] of Object.entries(state.changes.scale)) p[k] = Number(ch.to);
    return p;
  }

  function readViewport() {
    return { w: window.innerWidth, h: window.innerHeight, hiDpi: window.matchMedia('(min-resolution: 1.95dppx)').matches };
  }

  function initialPanelSizes() {
    const lp = canvas.querySelector('.rvi-panel');
    const rp = canvas.querySelector('[data-rv-region="right-panel"] .rvc-panel');
    if (state.ui.leftWidth == null) state.ui.leftWidth = lp ? parseFloat(lp.style.width) || 360 : 360;
    if (state.ui.rightWidth == null) state.ui.rightWidth = rp ? parseFloat(rp.style.width) || 360 : 360;
    // L'app fige la hauteur du panneau central quand elle le révèle au premier
    // tracé (restoreCenterPanel) : on part de la hauteur capturée ; null = auto.
    if (state.ui.centerHeight === undefined) {
      const center = regionEls.get('center-panel');
      const hgt = center ? parseFloat(center.style.height) : NaN;
      state.ui.centerHeight = Number.isFinite(hgt) ? hgt : null;
    }
  }

  function layoutPass() {
    const sm = L.scaleModule;
    sm.__wbSetScaleParams(effectiveScaleParams());
    sm.__wbForceScale(state.ui.scaleForce);
    const rightContent = regionEls.get('right-panel-shell')?.firstElementChild;
    const exporterHost = rightContent?.children[1];
    // Comme useDashboardChrome : hauteur visuelle arrondie de l'hôte de l'export.
    const exporterPanelHeight = exporterHost ? Math.round(exporterHost.getBoundingClientRect().height) : 0;
    layout = L.getDashboardLayout({
      viewport: readViewport(),
      panelWidth: state.ui.rightWidth,
      leftPanelWidth: state.ui.leftWidth,
      exporterPanelHeight,
      centerPanelHeightOverride: state.ui.centerHeight,
      isLeftPanelCollapsed: state.ui.leftCollapsed,
      isCenterPanelCollapsed: state.ui.centerCollapsed,
      isRightPanelCollapsed: state.ui.rightCollapsed,
      // Panneau gardé quand la fenêtre est trop étroite pour les deux : le
      // dernier ouvert dans l'app (la capture ouvre le droit en dernier).
      sidePanelPriority: state.ui.sidePriority,
    });
    const s = layout.appScale;
    const zoomed = L.supportsStandardZoom();
    applyStyle(canvas, {
      position: 'absolute', top: 0, left: 0,
      width: layout.scaledViewportWidth, height: layout.scaledViewportHeight,
      overflow: 'clip', containerType: 'inline-size', containerName: 'rv-canvas',
      zoom: s !== 1 && zoomed ? String(s) : '',
      transform: s !== 1 && !zoomed ? `scale(${s})` : '',
      transformOrigin: s !== 1 && !zoomed ? 'top left' : '',
      '--app-scale': String(s),
      '--rv-canvas-width': `${layout.scaledViewportWidth}px`,
      '--rv-canvas-height': `${layout.scaledViewportHeight}px`,
    });
    document.documentElement.style.setProperty('--app-scale', String(s));
    document.documentElement.dataset.rvScaleMode = zoomed ? 'zoom' : 'transform';

    // pages/Dashboard/index.tsx (calculs inline, garder en phase).
    const P = L.C.PANEL_PADDING;
    const rightCollapsed = layout.isRightPanelCollapsed;
    const panelWidth = layout.rightPanelWidth;
    const leftPanelWidth = layout.leftPanelWidth;
    const rightDockWidth = rightCollapsed ? 0 : panelWidth + P * 2;
    const rightDockOffset = rightCollapsed ? P : rightDockWidth + P;
    const statusDockRight = layout.isShortCanvas ? rightDockOffset + layout.mapToolsWidth + P : rightDockOffset;
    const statusDockBottom = layout.centerToolbarVisible ? layout.designH - layout.centerToolbarTop + L.C.CENTER_PANEL_STACK_GAP : 88;
    const leftDockWidth = layout.isLeftPanelCollapsed ? 0 : leftPanelWidth + P * 2;
    const searchLeft = layout.isLeftPanelCollapsed ? P : leftPanelWidth + P * 2;
    const searchRight = rightDockOffset + layout.mapToolsWidth + P;
    const styles = L.getDashboardStyles({
      layout, isLeftPanelCollapsed: layout.isLeftPanelCollapsed, isRightPanelCollapsed: rightCollapsed,
      isCenterResizing: false, isResizing: false, isLeftResizing: false,
      panelWidth, leftPanelWidth, rightDockWidth, rightDockOffset, leftDockWidth,
    });

    const left = regionEls.get('left-panel-shell');
    applyStyle(left, styles.leftPanelStyle);
    applyStyle(left?.firstElementChild, styles.leftPanelContentStyle);
    const rviPanel = left?.querySelector('.rvi-panel');
    if (rviPanel) rviPanel.style.width = `${leftPanelWidth}px`;

    const right = regionEls.get('right-panel-shell');
    applyStyle(right, styles.rightPanelStyle);
    applyStyle(rightContent, styles.rightPanelContentStyle);
    applyStyle(rightContent?.children[0], styles.rightPrimaryPanelStyle);
    rightContent?.querySelectorAll('.rvc-panel').forEach((p) => { p.style.width = `${panelWidth}px`; });

    const toolbar = regionEls.get('center-toolbar');
    applyStyle(toolbar, styles.centerToolbarShellStyle);
    if (toolbar) toolbar.style.display = layout.centerToolbarVisible ? '' : 'none';
    const handle = regionEls.get('center-resize');
    applyStyle(handle, styles.centerResizeHandleStyle);
    if (handle) handle.style.display = layout.centerPanelVisible ? '' : 'none';
    const center = regionEls.get('center-panel');
    applyStyle(center, styles.centerPanelShellStyle);
    if (center) center.style.display = layout.centerToolbarVisible ? '' : 'none';
    center?.querySelector('.rvc-center-panel')?.classList.toggle('rvc-center-panel--compact', layout.isShortCanvas);

    const tools = regionEls.get('map-tools');
    applyStyle(tools, styles.mapViewportControlsStyle);
    tools?.querySelector('.rvmvc-map-tools')?.classList.toggle('rvmvc-map-tools--compact', layout.isShortCanvas);

    const search = regionEls.get('search');
    if (search) {
      const maxWidth = Math.max(0, layout.designW - searchLeft - searchRight);
      applyStyle(search, { top: P, left: searchLeft, right: searchRight, maxWidth });
      search.classList.toggle('rvd-place-search--tight', maxWidth < L.PLACE_SEARCH_TIGHT_WIDTH);
      search.classList.toggle('rvd-place-search--icons', maxWidth < L.PLACE_SEARCH_ICONS_WIDTH);
    }
    applyStyle(regionEls.get('status-dock'), { right: statusDockRight, bottom: statusDockBottom });
  }

  /** Port de centerPanel/components/analysis/useToolbarFitDensity.ts. */
  function fitToolbar() {
    const el = canvas.querySelector('.rvc-center-analysis__toolbar');
    if (!el || el.clientWidth === 0) return;
    const items = [...el.querySelectorAll(':scope > *, :scope > .rvc-center-analysis__filters > *')];
    const wraps = () => {
      let firstRowBottom = Infinity;
      const tops = [];
      for (const item of items) {
        const r = item.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        firstRowBottom = Math.min(firstRowBottom, r.bottom);
        tops.push(r.top);
      }
      return tops.some((t) => t >= firstRowBottom - 0.5);
    };
    const apply = (level) => {
      if (level === 0) delete el.dataset.density;
      else el.dataset.density = Array.from({ length: level }, (_, i) => i + 1).join(' ');
    };
    el.dataset.fitting = '';
    let level = 0;
    apply(0);
    while (level < 8 && wraps()) apply(++level);
    delete el.dataset.fitting;
  }

  // ItineraryPanelModeContent.tsx : --rvi-mode-max-height suit la hauteur du split.
  let modeObserver = null;
  function observeModeLayout() {
    modeObserver?.disconnect();
    const node = canvas.querySelector('.rvi-panel__mode-layout');
    if (!node) return;
    modeObserver = new ResizeObserver((entries) => {
      const hh = entries[0]?.contentRect.height ?? 0;
      if (hh > 0) node.style.setProperty('--rvi-mode-max-height', `${Math.max(168, hh - 180 - 12)}px`);
    });
    modeObserver.observe(node);
  }

  function relayout() {
    layoutPass();
    layoutPass();
    fitToolbar();
    positionLayers();
    scheduleUi();
  }

  function onDomChanged() {
    initialPanelSizes();
    observeModeLayout();
    relayout();
  }

  // ── Cascade : règle qui décide chaque propriété ─────────────────────────
  function setOf(id, prop) {
    const a = DATA.attr[id];
    if (!a) return null;
    const i = a[PROPS.indexOf(prop)];
    return i >= 0 ? DATA.sets[i] : null;
  }

  function containerFor(el, name) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.containerType && cs.containerType !== 'normal' && (!name || cs.containerName.split(/\s+/).includes(name))) return p;
    }
    return null;
  }

  function evalCond(cond, el) {
    try {
      if (cond.type === 'media') return window.matchMedia(cond.text).matches;
      if (cond.type === 'supports') return CSS.supports(cond.text);
      if (cond.type === 'container') {
        const m = cond.text.match(/^([a-zA-Z][\w-]*)?\s*(.*)$/);
        const name = m[1] && m[1] !== 'not' ? m[1] : null;
        const query = name ? m[2] : cond.text;
        const box = containerFor(el, name);
        if (!box) return false;
        const cs = getComputedStyle(box);
        const width = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        let ok = true;
        for (const part of query.split(/\band\b/)) {
          let mm;
          if ((mm = part.match(/max-width:\s*([\d.]+)px/))) ok = ok && width <= +mm[1];
          else if ((mm = part.match(/min-width:\s*([\d.]+)px/))) ok = ok && width >= +mm[1];
          else if ((mm = part.match(/width\s*(<=|<|>=|>)\s*([\d.]+)px/))) {
            const v = +mm[2];
            ok = ok && ({ '<=': width <= v, '<': width < v, '>=': width >= v, '>': width > v })[mm[1]];
          }
        }
        return ok;
      }
    } catch {
      /* condition inconnue */
    }
    return true;
  }

  function applicable(c, el) {
    if (c[0] !== 'r' || c[1] == null) return true;
    if (!ruleById.has(c[1])) return false;
    const meta = DATA.rules[c[1]];
    return !meta || meta.c.every((cond) => evalCond(cond, el));
  }

  function precedence(c, i) {
    const imp = c[3] ? 1 : 0;
    const author = c[0] === 'u' ? 0 : 1;
    const inline = c[0] === 'i' ? 1 : 0;
    const sp = c[0] === 'i' ? [0, 0, 0] : c[2].split('.').map(Number);
    return [imp, author, inline, sp[0], sp[1], sp[2], c[1] != null ? c[1] : i / 1000];
  }

  function ancestor(el, depth) {
    let a = el;
    for (let i = 0; i < depth && a; i++) a = a.parentElement;
    return a || el;
  }

  /** { c: candidat, depth } — depth 0 = déclaré sur l'élément, > 0 = hérité. */
  function winnerOf(id, prop, el) {
    const set = setOf(id, prop);
    if (!set) return null;
    const pick = (cands, depth, target) => {
      let best = null, key = null;
      cands.forEach((c, i) => {
        if (!applicable(c, target)) return;
        const k = precedence(c, i);
        if (!best || cmpArr(k, key) > 0) {
          best = c;
          key = k;
        }
      });
      return best ? { c: best, depth } : null;
    };
    const own = set.o ? pick(set.o, 0, el) : null;
    if (own) return own;
    for (const [depth, cands] of set.h || []) {
      const w = pick(cands, depth, ancestor(el, depth));
      if (w) return w;
    }
    return null;
  }

  /** Valeur d'une sous-propriété dans un raccourci capturé (« font: 600 var(--x)/1 … »). */
  function fromShorthand(prop, value) {
    const m = value.match(/^(font|padding|padding-block|padding-inline|gap):\s*(.*)$/);
    if (!m) return value;
    const [, sh, v] = m;
    if (sh === 'font') {
      const size = v.match(/(?:^|\s)(var\([^)]*\)|[\d.]+(?:px|em|rem|%))(?:\s*\/\s*(var\([^)]*\)|[^\s]+))?/);
      if (prop === 'font-size') return size ? size[1] : value;
      if (prop === 'line-height') return size && size[2] ? size[2] : 'normal';
      if (prop === 'font-weight') return (v.match(/(?:^|\s)([1-9]00|bold|normal)(?=\s)/) || [])[1] || '400';
      return value;
    }
    const parts = v.trim().split(/\s+/);
    if (sh === 'gap') return prop === 'row-gap' ? parts[0] : parts[1] ?? parts[0];
    if (sh === 'padding-block') return prop === 'padding-top' ? parts[0] : parts[1] ?? parts[0];
    if (sh === 'padding-inline') return prop === 'padding-left' ? parts[0] : parts[1] ?? parts[0];
    const [t, r = t, b = t, l = r] = parts;
    return { 'padding-top': t, 'padding-right': r, 'padding-bottom': b, 'padding-left': l }[prop] ?? value;
  }

  function candValue(c, prop, el) {
    if (c[0] === 'r' && c[1] != null) {
      const r = ruleById.get(c[1]);
      const v = r?.style.getPropertyValue(prop);
      if (v) return v.trim();
    }
    if (c[0] === 'i' && el) {
      const v = el.style.getPropertyValue(prop);
      if (v) return v.trim();
    }
    return fromShorthand(prop, c[4]);
  }

  /** Où écrire une modif de `prop` pour cet élément. */
  function targetFor(id, prop, el) {
    const w = winnerOf(id, prop, el);
    if (w && w.depth === 0 && w.c[0] === 'r' && w.c[1] != null && ruleById.has(w.c[1])) {
      return { kind: 'rule', id: w.c[1], adds: false };
    }
    if (!(w && w.depth === 0 && w.c[0] === 'i')) {
      // Hérité, navigateur ou rien : on ajoute la déclaration à la règle
      // principale de l'élément (celle de sa taille de texte / de son padding).
      const anchors = TEXT_PROPS.includes(prop) ? TEXT_PROPS : [...LAYOUT_EDIT, 'font-size'];
      for (const p of anchors) {
        const a = winnerOf(id, p, el);
        if (a && a.depth === 0 && a.c[0] === 'r' && a.c[1] != null && ruleById.has(a.c[1])) return { kind: 'rule', id: a.c[1], adds: true };
      }
    }
    return { kind: 'el', id };
  }

  function tokenOf(value, el) {
    if (!value) return null;
    const m = value.match(/var\((--rv-font-size-[\w-]+)/);
    if (m) return tokenByName.get(m[1])?.short ?? null;
    let v = value;
    const alias = value.match(/^var\((--[\w-]+)/);
    if (alias && el) v = getComputedStyle(el).getPropertyValue(alias[1]).trim();
    const px = parseFloat(v);
    if (!Number.isFinite(px) || !/px$/.test(v)) return null;
    for (const t of DATA.tokens) if (parseFloat(currentToken(t.name)) === px) return t.short;
    return null;
  }

  const currentToken = (name) => state.changes.tokens[name]?.to ?? tokenByName.get(name)?.value;

  function textInfo(el, id) {
    const cs = getComputedStyle(el);
    const w = winnerOf(id, 'font-size', el);
    const token = w ? tokenOf(candValue(w.c, 'font-size', el), el) : null;
    return { px: parseFloat(cs.fontSize), weight: cs.fontWeight, token, lh: cs.lineHeight, ls: cs.letterSpacing, tt: cs.textTransform };
  }

  function roleOf(token, weight) {
    const r = ROLES.find(([t, w]) => t === token && w === String(weight));
    return r ? r[2] : null;
  }

  function sourceLabel(w) {
    if (!w) return 'aucune règle (valeur par défaut)';
    const c = w.c;
    const inh = w.depth > 0 ? `hérité (${w.depth}) · ` : '';
    if (c[0] === 'u') return `${inh}navigateur`;
    if (c[0] === 'i') return `${inh}style inline (TSX)`;
    const m = DATA.rules[c[1]];
    if (!m) return `${inh}règle non résolue`;
    return `${inh}${m.s}`;
  }

  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n !== canvas && parts.length < 4; n = n.parentElement) {
      const cls = [...n.classList].find((c) => !c.startsWith('wb-') && !c.startsWith('is-'));
      parts.unshift(cls ? `.${cls}` : n.tagName.toLowerCase());
    }
    return parts.join(' > ');
  }

  // ── Modifications ───────────────────────────────────────────────────────
  const original = new Map();
  function rememberOriginal(ruleId, prop) {
    const key = `${ruleId}|${prop}`;
    if (original.has(key)) return original.get(key);
    const r = ruleById.get(ruleId);
    const o = { value: r.style.getPropertyValue(prop), priority: r.style.getPropertyPriority(prop) };
    original.set(key, o);
    return o;
  }

  function writeRule(ruleId, prop, value) {
    const r = ruleById.get(ruleId);
    if (!r) return;
    const o = rememberOriginal(ruleId, prop);
    if (value == null) {
      if (o.value) r.style.setProperty(prop, o.value, o.priority);
      else r.style.removeProperty(prop);
    } else r.style.setProperty(prop, value, o.priority);
  }

  function writeToken(name, value) {
    if (value == null) document.documentElement.style.removeProperty(name);
    else document.documentElement.style.setProperty(name, value);
  }

  function writeElementOverrides() {
    let css = '';
    for (const [id, props] of Object.entries(state.changes.elements)) {
      const decls = Object.entries(props).map(([p, ch]) => `${p}:${ch.to} !important`).join(';');
      if (decls) css += `[data-wb="${id}"]{${decls}}\n`;
    }
    overrideStyle.textContent = css;
  }

  function bucket(kind) {
    return state.changes[kind === 'rule' ? 'rules' : kind === 'token' ? 'tokens' : kind === 'el' ? 'elements' : kind === 'scale' ? 'scale' : 'notes'];
  }

  function readChange(kind, key, prop) {
    const b = bucket(kind);
    if (kind === 'token' || kind === 'scale' || kind === 'note') return b[key];
    return b[key]?.[prop];
  }

  /** Écrit (ou retire si `record` est vide) une modif, l'applique et l'historise. */
  function setChange(kind, key, prop, record, opts = {}) {
    const before = readChange(kind, key, prop);
    const b = bucket(kind);
    if (kind === 'token' || kind === 'scale' || kind === 'note') {
      if (record == null) delete b[key];
      else b[key] = record;
    } else {
      if (record == null) {
        if (b[key]) delete b[key][prop];
        if (b[key] && !Object.keys(b[key]).length) delete b[key];
      } else (b[key] ??= {})[prop] = record;
    }
    if (kind === 'rule') writeRule(Number(key), prop, record ? record.to : null);
    else if (kind === 'token') writeToken(key, record ? record.to : null);
    else if (kind === 'el') writeElementOverrides();
    if (!opts.silent) {
      history.push({ kind, key, prop, before, after: record });
      redo.length = 0;
    }
    save();
    if (kind !== 'note') relayout();
    else scheduleUi();
  }

  function undo() {
    const e = history.pop();
    if (!e) return toast('Rien à annuler');
    setChange(e.kind, e.key, e.prop, e.before, { silent: true });
    redo.push(e);
    renderPanel();
  }
  function redoLast() {
    const e = redo.pop();
    if (!e) return toast('Rien à rétablir');
    setChange(e.kind, e.key, e.prop, e.after, { silent: true });
    history.push(e);
    renderPanel();
  }

  /** Valeur écrite dans le code source pour cette règle (déclaration ou raccourci). */
  function authoredOf(ruleId, prop) {
    const d = DATA.rules[ruleId]?.d || {};
    if (d[prop] != null) return d[prop];
    for (const sh of ['font', 'padding', 'padding-block', 'padding-inline', 'gap']) {
      if (d[sh] == null) continue;
      const whole = `${sh}: ${d[sh]}`;
      const v = fromShorthand(prop, whole);
      if (v !== whole) return v;
    }
    return null;
  }

  /** Modif d'une propriété depuis l'inspecteur (valeur vide = retour à l'origine). */
  function editProp(id, prop, value) {
    const el = elById(id);
    if (!el) return;
    const t = targetFor(id, prop, el);
    const v = value == null ? '' : String(value).trim();
    if (t.kind === 'rule') {
      const from = authoredOf(t.id, prop) ?? (rememberOriginal(t.id, prop).value || null);
      if (!v || v === from) setChange('rule', String(t.id), prop, null);
      else setChange('rule', String(t.id), prop, { from, to: v });
    } else {
      const w = winnerOf(id, prop, el);
      const from = w ? candValue(w.c, prop, el) : getComputedStyle(el).getPropertyValue(prop);
      if (!v) setChange('el', String(id), prop, null);
      else setChange('el', String(id), prop, { from, to: v, sample: DATA.el[id]?.t ?? '', path: cssPath(el) });
    }
    renderPanel();
  }

  function revertAll() {
    for (const [id, props] of Object.entries(state.changes.rules)) for (const p of Object.keys(props)) writeRule(Number(id), p, null);
    for (const name of Object.keys(state.changes.tokens)) writeToken(name, null);
    state.changes = { rules: {}, tokens: {}, elements: {}, scale: {}, notes: {} };
    writeElementOverrides();
  }

  function applyAll() {
    for (const [id, props] of Object.entries(state.changes.rules)) for (const [p, ch] of Object.entries(props)) writeRule(Number(id), p, ch.to);
    for (const [name, ch] of Object.entries(state.changes.tokens)) writeToken(name, ch.to);
    writeElementOverrides();
  }

  function changeCount() {
    const c = state.changes;
    let n = Object.keys(c.tokens).length + Object.keys(c.scale).length;
    for (const p of Object.values(c.rules)) n += Object.keys(p).length;
    for (const p of Object.values(c.elements)) n += Object.keys(p).length;
    return n;
  }

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      safe.set(STORE_KEY, { changes: state.changes, view: state.view, ui: state.ui });
      safe.set(PREFS_KEY, state.prefs);
    }, 150);
  }

  // ── Export / import ─────────────────────────────────────────────────────
  function samplesFor(ruleId) {
    const ids = [...(elementsByRule.get(ruleId) || [])];
    const texts = [...new Set(ids.map((i) => DATA.el[i]?.t).filter(Boolean))];
    return { samples: texts.slice(0, 6), elementCount: ids.length };
  }

  function buildExport() {
    const vp = readViewport();
    const rules = Object.entries(state.changes.rules).map(([id, props]) => {
      const m = DATA.rules[id] || {};
      const shorthands = {};
      for (const sh of ['font', 'padding', 'gap', 'padding-block', 'padding-inline']) if (m.d?.[sh] != null) shorthands[sh] = m.d[sh];
      return {
        ruleId: Number(id),
        file: m.f ?? null,
        line: m.l ?? null,
        selector: m.s ?? null,
        conditions: (m.c || []).map((c) => `@${c.type} ${c.text}`),
        changes: Object.fromEntries(Object.entries(props).map(([p, ch]) => [p, { from: ch.from ?? null, to: ch.to }])),
        ...(Object.keys(shorthands).length ? { declaredShorthands: shorthands } : {}),
        ...samplesFor(Number(id)),
        comment: state.changes.notes[`r:${id}`]?.text ?? '',
      };
    });
    const elements = Object.entries(state.changes.elements).map(([id, props]) => ({
      elementId: Number(id),
      selectorPath: Object.values(props)[0]?.path ?? '',
      sample: Object.values(props)[0]?.sample ?? DATA.el[id]?.t ?? '',
      changes: Object.fromEntries(Object.entries(props).map(([p, ch]) => [p, { from: ch.from ?? null, to: ch.to }])),
    }));
    const comments = Object.entries(state.changes.notes)
      .filter(([k]) => !k.startsWith('r:'))
      .map(([k, n]) => ({ elementId: Number(k.slice(2)), selectorPath: n.path, sample: n.sample, rule: n.rule ?? null, text: n.text }));
    return {
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      author: state.prefs.author || '',
      note: state.prefs.note || '',
      target: state.prefs.target,
      snapshot: {
        commit: DATA.meta.commit,
        builtAt: DATA.meta.builtAt,
        lang: DATA.meta.lang,
        captureViewport: `${DATA.meta.viewport.w}x${DATA.meta.viewport.h}@${DATA.meta.viewport.dpr}`,
      },
      environment: {
        platform: navigator.platform,
        userAgent: navigator.userAgent,
        viewport: { w: vp.w, h: vp.h },
        dpr: window.devicePixelRatio,
        hiDpi: vp.hiDpi,
        appScale: layout ? layout.appScale : null,
        appScaleOverride: state.ui.scaleForce,
        panels: { left: state.ui.leftWidth, right: state.ui.rightWidth, centerHeight: state.ui.centerHeight },
      },
      appScaleParams: Object.fromEntries(Object.entries(state.changes.scale).map(([k, ch]) => [
        { hidpiMin: 'APP_SCALE_HIDPI_MIN', hidpiShrink: 'APP_SCALE_HIDPI_SHRINK_FACTOR', max: 'APP_SCALE_MAX', grow: 'APP_SCALE_GROW_FACTOR' }[k] || k,
        { from: ch.from, to: Number(ch.to) },
      ])),
      tokens: Object.fromEntries(Object.entries(state.changes.tokens).map(([k, ch]) => [k, { from: ch.from, to: ch.to }])),
      rules,
      elements,
      comments,
    };
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportFile() {
    const json = buildExport();
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    download(`redview-workbench-${stamp}.json`, JSON.stringify(json, null, 2));
    toast(`Export : ${changeCount()} modification(s)`);
  }

  const SCALE_KEYS = { APP_SCALE_HIDPI_MIN: 'hidpiMin', APP_SCALE_HIDPI_SHRINK_FACTOR: 'hidpiShrink', APP_SCALE_MAX: 'max', APP_SCALE_GROW_FACTOR: 'grow' };
  function importJson(json) {
    if (!json || json.format !== FORMAT) throw new Error('Ce fichier n’est pas un export du workbench RedView.');
    const sameSnapshot = json.snapshot?.builtAt === DATA.meta.builtAt;
    revertAll();
    let missing = 0;
    for (const r of json.rules || []) {
      let id = sameSnapshot && DATA.rules[r.ruleId] ? r.ruleId : null;
      if (id == null) {
        const hits = Object.entries(DATA.rules).filter(([, m]) => m.f === r.file && m.s === r.selector);
        hits.sort((a, b) => Math.abs((a[1].l ?? 0) - (r.line ?? 0)) - Math.abs((b[1].l ?? 0) - (r.line ?? 0)));
        id = hits[0] ? Number(hits[0][0]) : null;
      }
      if (id == null || !ruleById.has(id)) {
        missing++;
        continue;
      }
      state.changes.rules[id] = {};
      for (const [p, ch] of Object.entries(r.changes || {})) state.changes.rules[id][p] = { from: ch.from ?? null, to: ch.to };
      if (r.comment) state.changes.notes[`r:${id}`] = { text: r.comment };
    }
    for (const [name, ch] of Object.entries(json.tokens || {})) if (tokenByName.has(name)) state.changes.tokens[name] = { from: ch.from, to: ch.to };
    for (const [k, ch] of Object.entries(json.appScaleParams || {})) state.changes.scale[SCALE_KEYS[k] || k] = { from: ch.from, to: ch.to };
    for (const e of json.elements || []) {
      if (!sameSnapshot || !DATA.el[e.elementId]) {
        missing++;
        continue;
      }
      state.changes.elements[e.elementId] = {};
      for (const [p, ch] of Object.entries(e.changes || {})) state.changes.elements[e.elementId][p] = { from: ch.from, to: ch.to, sample: e.sample, path: e.selectorPath };
    }
    for (const c of json.comments || []) state.changes.notes[`e:${c.elementId}`] = { text: c.text, sample: c.sample, path: c.selectorPath, rule: c.rule };
    if (json.author) state.prefs.author = json.author;
    if (json.note) state.prefs.note = json.note;
    if (json.target) state.prefs.target = json.target;
    history.length = 0;
    redo.length = 0;
    applyAll();
    save();
    relayout();
    renderPanel();
    toast(missing ? `Import : ${missing} entrée(s) introuvable(s) dans cette capture` : `Import : ${changeCount()} modification(s)`);
  }

  function readFile(file) {
    if (/^image\//.test(file.type)) {
      const reader = new FileReader();
      reader.onload = () => {
        state.ref.src = reader.result;
        renderRef();
        renderPanel();
      };
      reader.readAsDataURL(file);
      return;
    }
    file.text().then((t) => {
      try {
        importJson(JSON.parse(t));
      } catch (err) {
        toast(err.message || 'Fichier illisible');
      }
    });
  }

  // ── Interface ───────────────────────────────────────────────────────────
  const hlHover = h('div', { class: 'wb-hl', style: 'display:none' });
  const hlSelect = h('div', { class: 'wb-hl wb-hl--select', style: 'display:none' });
  const tag = h('div', { class: 'wb-tag', style: 'display:none' });
  const sharedLayer = h('div');
  const padLayer = h('div');
  const annotLayer = h('div', { class: 'wb-annot' });
  const refImg = h('img', { class: 'wb-ref', alt: '', style: 'display:none' });
  const panel = h('div', { class: 'wb-panel' });
  const pill = h('button', { class: 'wb-pill', style: 'display:none', onclick: () => togglePanel(false) }, 'Workbench (W)');
  const toastEl = h('div', { class: 'wb-toast' });
  const dropzone = h('div', { class: 'wb-dropzone' }, 'Déposer un export .json ou une capture .png');
  uiRoot.append(refImg, annotLayer, sharedLayer, padLayer, hlHover, hlSelect, tag, panel, pill, toastEl, dropzone);

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2200);
  }

  function placeBox(box, el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) {
      box.style.display = 'none';
      return r;
    }
    box.style.display = 'block';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    return r;
  }

  function hoverLabel(el, id) {
    const m = DATA.el[id];
    if (!m) return '';
    const parts = [];
    if (m.k & 1) {
      const ti = textInfo(el, id);
      parts.push(`${ti.token ? `${ti.token} ` : ''}${fmt(ti.px)}/${ti.weight}`);
    }
    if (m.k & 2 && !(m.k & 1)) {
      const cs = getComputedStyle(el);
      parts.push(`${cs.display.includes('flex') || cs.display.includes('grid') ? (cs.flexDirection === 'column' ? '↓' : '→') : '□'} ${fmt(el.offsetWidth, 0)}×${fmt(el.offsetHeight, 0)}`);
    }
    const cls = [...el.classList].find((c) => !c.startsWith('wb-'));
    if (cls) parts.push(`.${cls}`);
    const found = triggerFor(el);
    if (found) {
      const t = found.t;
      const verb = t.kind === 'popup' ? 'ouvre' : t.kind === 'inverse' || isApplied(t.id) ? 'referme' : 'ouvre';
      parts.push(`clic droit ▸ ${verb}`);
    }
    return parts.join(' · ');
  }

  let uiQueued = false;
  function scheduleUi() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => {
      uiQueued = false;
      drawHighlights();
      drawAnnotations();
    });
  }

  function drawHighlights() {
    const hov = state.hover != null ? elById(state.hover) : null;
    if (hov && state.hover !== state.selected) {
      const r = placeBox(hlHover, hov);
      tag.textContent = hoverLabel(hov, state.hover);
      tag.style.display = tag.textContent ? 'block' : 'none';
      tag.style.left = `${Math.max(2, r.left)}px`;
      tag.style.top = `${r.top > 22 ? r.top - 19 : r.bottom + 3}px`;
    } else {
      hlHover.style.display = 'none';
      tag.style.display = 'none';
    }
    sharedLayer.textContent = '';
    padLayer.textContent = '';
    const sel = state.selected != null ? elById(state.selected) : null;
    if (!sel) {
      hlSelect.style.display = 'none';
      return;
    }
    placeBox(hlSelect, sel);
    const m = DATA.el[state.selected];
    if (m && m.k & 1) {
      const w = winnerOf(state.selected, 'font-size', sel);
      if (w && w.c[0] === 'r' && w.c[1] != null) {
        let n = 0;
        for (const other of canvas.querySelectorAll('[data-wb]')) {
          if (other === sel || n > 400) continue;
          const oid = Number(other.dataset.wb);
          if (!(DATA.el[oid]?.k & 1)) continue;
          const ow = winnerOf(oid, 'font-size', other);
          if (ow && ow.c[1] === w.c[1]) {
            const box = h('div', { class: 'wb-hl wb-hl--shared' });
            placeBox(box, other);
            sharedLayer.appendChild(box);
            n++;
          }
        }
      }
    }
    if (m && m.k & 2) {
      const cs = getComputedStyle(sel);
      const r = sel.getBoundingClientRect();
      const s = r.width / (sel.offsetWidth || r.width || 1);
      const pt = parseFloat(cs.paddingTop) * s, pr = parseFloat(cs.paddingRight) * s, pb = parseFloat(cs.paddingBottom) * s, pl = parseFloat(cs.paddingLeft) * s;
      const add = (left, top, width, height) => {
        if (width <= 0 || height <= 0) return;
        padLayer.appendChild(h('div', { class: 'wb-hl wb-hl--pad', style: `left:${left}px;top:${top}px;width:${width}px;height:${height}px` }));
      };
      add(r.left, r.top, r.width, pt);
      add(r.left, r.bottom - pb, r.width, pb);
      add(r.left, r.top + pt, pl, r.height - pt - pb);
      add(r.right - pr, r.top + pt, pr, r.height - pt - pb);
    }
  }

  function drawAnnotations() {
    annotLayer.textContent = '';
    if (!state.prefs.annotations) return;
    const placed = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const el of canvas.querySelectorAll('[data-wb]')) {
      const id = Number(el.dataset.wb);
      const m = DATA.el[id];
      if (!m || !(m.k & 1)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.left > vw || r.top > vh) continue;
      if (!el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue;
      const ti = textInfo(el, id);
      const label = `${ti.token ?? fmt(ti.px, 1)}·${ti.weight}`;
      const box = { l: r.left, t: r.top - 11, r: r.left + label.length * 5.6 + 6, b: r.top };
      if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) continue;
      placed.push(box);
      const w = winnerOf(id, 'font-size', el);
      const mod = w && w.c[0] === 'r' && state.changes.rules[w.c[1]];
      annotLayer.appendChild(h('span', { class: mod ? 'is-mod' : '', style: `left:${r.left}px;top:${r.top}px` }, label));
    }
  }

  function renderRef() {
    if (!state.ref.src) {
      refImg.style.display = 'none';
      return;
    }
    refImg.src = state.ref.src;
    refImg.style.display = 'block';
    refImg.style.opacity = String(state.ref.opacity);
    refImg.style.mixBlendMode = state.ref.diff ? 'difference' : 'normal';
    const apply = () => {
      const k = state.ref.scale === 'auto' ? window.devicePixelRatio || 1 : 1;
      refImg.style.width = `${refImg.naturalWidth / k}px`;
      refImg.style.height = `${refImg.naturalHeight / k}px`;
    };
    if (refImg.complete) apply();
    else refImg.onload = apply;
  }

  // ── Panneau ─────────────────────────────────────────────────────────────
  const TABS = [
    ['inspect', 'Inspecteur'],
    ['styles', 'Styles'],
    ['tokens', 'Tokens'],
    ['screen', 'Écran'],
    ['changes', 'Modifs'],
  ];

  function togglePanel(hide) {
    state.prefs.hidden = hide ?? !state.prefs.hidden;
    panel.style.display = state.prefs.hidden ? 'none' : '';
    pill.style.display = state.prefs.hidden ? '' : 'none';
    save();
  }

  function placePanel() {
    const w = panel.offsetWidth || 336;
    if (state.prefs.x == null || state.prefs.y == null) {
      const leftEdge = layout ? (layout.isLeftPanelCollapsed ? 12 : (layout.leftPanelWidth + 36) * layout.appScale) : 400;
      state.prefs.x = Math.round(leftEdge + 12);
      state.prefs.y = Math.round(64 * (layout ? layout.appScale : 1));
    }
    const x = Math.min(Math.max(0, state.prefs.x), window.innerWidth - Math.min(w, 120));
    const y = Math.min(Math.max(0, state.prefs.y), window.innerHeight - 40);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  }

  function renderPanel() {
    const n = changeCount();
    const body = h('div', { class: 'wb-body' });
    const tabs = h('div', { class: 'wb-tabs' }, TABS.map(([id, label]) =>
      h('button', {
        class: `wb-tab${state.prefs.tab === id ? ' is-active' : ''}`,
        onclick: () => {
          state.prefs.tab = id;
          save();
          renderPanel();
        },
      }, label, id === 'changes' && n ? h('b', null, String(n)) : null)));
    const date = new Date(DATA.meta.builtAt);
    const head = h('div', { class: 'wb-head' },
      h('span', { class: 'wb-title' }, 'RedView Workbench'),
      h('span', { class: 'wb-sub', title: `Capture du ${date.toLocaleString('fr-FR')} · ${DATA.meta.commit}` },
        `capture ${date.toLocaleDateString('fr-FR')} · ${DATA.meta.commit}`),
      h('button', { class: 'wb-icon-btn', title: 'Annuler (Ctrl+Z)', onclick: undo }, '↶'),
      h('button', { class: 'wb-icon-btn', title: 'Rétablir (Ctrl+Maj+Z)', onclick: redoLast }, '↷'),
      h('button', {
        class: 'wb-icon-btn',
        title: state.prefs.collapsed ? 'Déplier' : 'Replier',
        onclick: () => {
          state.prefs.collapsed = !state.prefs.collapsed;
          save();
          renderPanel();
        },
      }, state.prefs.collapsed ? '▢' : '–'),
      h('button', { class: 'wb-icon-btn', title: 'Masquer (W)', onclick: () => togglePanel(true) }, '×'));
    head.addEventListener('pointerdown', startDrag);
    const tab = state.prefs.tab;
    if (tab === 'inspect') renderInspector(body);
    else if (tab === 'styles') renderStyles(body);
    else if (tab === 'tokens') renderTokens(body);
    else if (tab === 'screen') renderScreen(body);
    else renderChanges(body);
    const foot = h('div', { class: 'wb-foot' },
      h('span', { class: 'wb-hint' }, n ? `${n} modif(s) · sauvegarde auto` : 'Aucune modification'),
      h('button', { class: 'wb-btn is-small', onclick: () => fileInput.click() }, 'Importer'),
      h('button', { class: 'wb-btn is-small is-primary', onclick: exportFile }, 'Exporter .json'));
    const scroll = panel.querySelector('.wb-body')?.scrollTop ?? 0;
    panel.className = `wb-panel${state.prefs.collapsed ? ' is-collapsed' : ''}`;
    panel.replaceChildren(head, tabs, body, foot);
    body.scrollTop = scroll;
    placePanel();
  }

  let drag = null;
  function startDrag(e) {
    if (e.target.closest('button')) return;
    drag = { x: e.clientX, y: e.clientY, px: panel.offsetLeft, py: panel.offsetTop };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.addEventListener('pointermove', onDrag);
    e.currentTarget.addEventListener('pointerup', endDrag, { once: true });
  }
  function onDrag(e) {
    if (!drag) return;
    state.prefs.x = drag.px + e.clientX - drag.x;
    state.prefs.y = drag.py + e.clientY - drag.y;
    placePanel();
  }
  function endDrag(e) {
    e.currentTarget.removeEventListener('pointermove', onDrag);
    drag = null;
    save();
  }

  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json,image/png,image/jpeg', style: 'display:none',
    onchange: (e) => {
      const f = e.target.files[0];
      if (f) readFile(f);
      e.target.value = '';
    },
  });
  uiRoot.appendChild(fileInput);

  // Inspecteur ----------------------------------------------------------------
  function sizeOptions(current) {
    const opts = DATA.tokens.map((t) => h('option', { value: `var(${t.name})` }, `${t.short} — ${currentToken(t.name)}`));
    const isToken = /^var\(--rv-font-size-/.test(current || '');
    if (current && !isToken) opts.unshift(h('option', { value: current }, `${current} (actuel)`));
    return opts;
  }

  function propRow(id, el, prop, label, control) {
    const w = winnerOf(id, prop, el);
    const t = targetFor(id, prop, el);
    const modified = t.kind === 'rule' ? !!state.changes.rules[t.id]?.[prop] : !!state.changes.elements[id]?.[prop];
    const src = h('div', { class: 'wb-src', title: srcTitle(w, t, prop) }, sourceLabel(w));
    if (t.kind === 'rule' && t.adds) src.append(h('span', null, ` → ajout dans ${DATA.rules[t.id]?.s ?? 'la règle'}`));
    if (t.kind === 'el') src.append(h('span', null, ' → surcharge de cet élément'));
    if (modified) {
      src.append(' · ', h('a', { onclick: () => editProp(id, prop, null) }, 'réinitialiser'));
    }
    return h('div', { class: 'wb-row' },
      h('label', null, label, modified ? h('i') : null),
      h('div', { class: 'wb-ctl' }, control, src));
  }

  function srcTitle(w, t, prop) {
    const lines = [];
    if (w && w.c[0] === 'r' && DATA.rules[w.c[1]]) {
      const m = DATA.rules[w.c[1]];
      lines.push(`${m.s}`, `${m.f}${m.l ? `:${m.l}` : ''}`);
      if (m.c.length) lines.push(m.c.map((c) => `@${c.type} ${c.text}`).join(' · '));
      lines.push(`${prop}: ${w.c[4]}`);
    }
    if (t.kind === 'rule' && t.adds && DATA.rules[t.id]) lines.push(`Modifier ici ajoute « ${prop} » à ${DATA.rules[t.id].s} (${DATA.rules[t.id].f})`);
    return lines.join('\n');
  }

  function currentValue(id, prop, el) {
    const t = targetFor(id, prop, el);
    if (t.kind === 'rule') {
      const ch = state.changes.rules[t.id]?.[prop];
      if (ch) return ch.to;
    } else if (state.changes.elements[id]?.[prop]) return state.changes.elements[id][prop].to;
    const w = winnerOf(id, prop, el);
    return w ? candValue(w.c, prop, el) : '';
  }

  function textInput(id, prop, value, cls = 'wb-input is-wide', placeholder = '') {
    return h('input', {
      class: cls, value: value ?? '', placeholder, spellcheck: 'false',
      onchange: (e) => editProp(id, prop, e.target.value),
      onkeydown: (e) => {
        if (e.key === 'Enter') e.target.blur();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const m = e.target.value.match(/^(-?[\d.]+)(px|em|%)?$/);
          if (!m) return;
          e.preventDefault();
          const stepV = m[2] === 'em' ? 0.01 : e.shiftKey ? 1 : 0.5;
          const next = round(parseFloat(m[1]) + (e.key === 'ArrowUp' ? stepV : -stepV), 3);
          e.target.value = `${next}${m[2] ?? ''}`;
          editProp(id, prop, e.target.value);
        }
      },
    });
  }

  function renderInspector(body) {
    const id = state.selected;
    const el = id != null ? elById(id) : null;
    if (!el) {
      body.append(h('div', { class: 'wb-sec' },
        h('div', { class: 'wb-help' },
          'Survolez la maquette : chaque texte affiche son token, sa taille et sa graisse. Cliquez un texte ou un bloc pour le modifier.'),
        h('div', { class: 'wb-help' },
          h('kbd', null, 'Clic droit'), ' = clic dans l’app (onglets, sections, menus) · ',
          h('kbd', null, 'Échap'), ' remonte au parent · ',
          h('kbd', null, 'W'), ' masque le panneau · ',
          h('kbd', null, 'Alt'), ' maintenu : maquette seule · ',
          h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'Z'), ' annule'),
        h('div', { class: 'wb-help' },
          'Une modification s’applique à la règle CSS d’origine : tous les éléments qui la partagent changent ensemble, dans tous les écrans.')));
      return;
    }
    const m = DATA.el[id] || { k: 0 };
    const crumbs = [];
    for (let n = el, depth = 0; n && n !== canvas && depth < 7; n = n.parentElement) {
      const nid = n.dataset?.wb;
      if (nid == null || !DATA.el[nid]) continue;
      const cls = [...n.classList].find((c) => !c.startsWith('wb-')) || n.tagName.toLowerCase();
      crumbs.unshift(h('button', { class: n === el ? 'is-current' : '', onclick: () => select(Number(nid)) }, cls.replace(/^rv[a-z]*-/, '')));
      depth++;
    }
    body.append(h('div', { class: 'wb-el-head' },
      m.t ? h('div', { class: 'wb-el-sample' }, `« ${short(m.t, 80)} »`) : h('div', { class: 'wb-el-sample' }, cssPath(el).split(' > ').pop()),
      h('div', { class: 'wb-crumbs' }, crumbs)));

    if (m.k & 1) {
      const ti = textInfo(el, id);
      const role = roleOf(ti.token, ti.weight);
      const sec = h('div', { class: 'wb-sec' }, h('div', { class: 'wb-sec-title' }, h('span', null, 'Texte')));
      const s = layout ? layout.appScale : 1;
      const dpr = window.devicePixelRatio || 1;
      sec.append(h('div', { class: 'wb-render' },
        `${fmt(ti.px)} px logique → ${fmt(ti.px * s)} px CSS (×${fmt(s, 3)}) → ${fmt(ti.px * s * dpr, 1)} px écran (DPR ${fmt(dpr)})`));
      if (role) sec.append(h('div', { class: 'wb-chip-line' }, h('span', { class: 'wb-chip is-dark' }, `${ti.token} · ${ti.weight}`), h('span', { class: 'wb-chip' }, role)));
      const fsVal = currentValue(id, 'font-size', el);
      const sizeSel = h('select', { class: 'wb-select', onchange: (e) => editProp(id, 'font-size', e.target.value) }, sizeOptions(fsVal));
      sizeSel.value = fsVal;
      const sizePx = textInput(id, 'font-size', /^var\(/.test(fsVal) ? '' : fsVal, 'wb-input is-num', 'px');
      sec.append(propRow(id, el, 'font-size', 'Taille', h('div', { class: 'wb-ctl-line' }, sizeSel, sizePx)));
      const fw = String(ti.weight);
      sec.append(propRow(id, el, 'font-weight', 'Graisse', h('div', { class: 'wb-ctl-line' },
        h('div', { class: 'wb-seg' }, WEIGHTS.map((wv) => h('button', {
          class: fw === wv ? 'is-on' : '', title: WEIGHT_NAMES[wv], onclick: () => editProp(id, 'font-weight', wv),
        }, wv))),
        h('span', { class: 'wb-faint' }, WEIGHT_NAMES[fw] || ''))));
      sec.append(propRow(id, el, 'line-height', 'Interligne', h('div', { class: 'wb-ctl-line' },
        textInput(id, 'line-height', currentValue(id, 'line-height', el), 'wb-input is-wide', 'normal'),
        h('span', { class: 'wb-faint wb-mono' }, ti.lh))));
      sec.append(propRow(id, el, 'letter-spacing', 'Approche', h('div', { class: 'wb-ctl-line' },
        textInput(id, 'letter-spacing', currentValue(id, 'letter-spacing', el), 'wb-input is-wide', 'normal'),
        h('span', { class: 'wb-faint wb-mono' }, ti.ls))));
      const tt = h('select', { class: 'wb-select', onchange: (e) => editProp(id, 'text-transform', e.target.value) },
        ['none', 'uppercase', 'capitalize', 'lowercase'].map((v) => h('option', { value: v }, v)));
      tt.value = ti.tt;
      sec.append(propRow(id, el, 'text-transform', 'Casse', tt));
      const w = winnerOf(id, 'font-size', el);
      if (w && w.c[0] === 'r' && w.c[1] != null) {
        const count = [...canvas.querySelectorAll('[data-wb]')].filter((o) => {
          const oid = Number(o.dataset.wb);
          if (!(DATA.el[oid]?.k & 1)) return false;
          const ow = winnerOf(oid, 'font-size', o);
          return ow && ow.c[1] === w.c[1];
        }).length;
        const meta = DATA.rules[w.c[1]];
        sec.append(h('div', { class: 'wb-src', title: `${meta?.f}:${meta?.l}` },
          h('b', null, `${count} élément(s) à l’écran`), ` partagent la taille de ${meta?.s ?? '—'} · ${basename(meta?.f)}${meta?.l ? `:${meta.l}` : ''}`));
      }
      body.append(sec);
    }

    if (m.k & 2) {
      const cs = getComputedStyle(el);
      const isFlex = /flex|grid/.test(cs.display);
      const sec = h('div', { class: 'wb-sec' }, h('div', { class: 'wb-sec-title' }, h('span', null, 'Auto-layout')));
      const sizing = (dim) => {
        const w = winnerOf(id, dim, el);
        if (w && w.depth === 0) {
          const v = candValue(w.c, dim, el);
          if (/^(100%|auto)$/.test(v)) return v === '100%' ? 'fill' : 'hug';
          return `fixe ${v}`;
        }
        return dim === 'width' && cs.display !== 'inline' && cs.display !== 'inline-flex' ? 'fill/auto' : 'hug';
      };
      sec.append(h('div', { class: 'wb-chip-line' },
        h('span', { class: 'wb-chip is-dark' }, isFlex ? `${cs.display} ${cs.flexDirection === 'column' ? '↓ vertical' : '→ horizontal'}` : cs.display),
        isFlex ? h('span', { class: 'wb-chip' }, `align ${cs.alignItems}`) : null,
        isFlex ? h('span', { class: 'wb-chip' }, `justify ${cs.justifyContent}`) : null,
        cs.flexWrap === 'wrap' ? h('span', { class: 'wb-chip' }, 'wrap') : null,
        h('span', { class: 'wb-chip' }, `L ${sizing('width')}`),
        h('span', { class: 'wb-chip' }, `H ${sizing('height')}`),
        h('span', { class: 'wb-chip' }, `${fmt(el.offsetWidth, 1)} × ${fmt(el.offsetHeight, 1)}`)));
      const padGrid = h('div', { class: 'wb-pad-grid' },
        PAD.map((p) => textInput(id, p, currentValue(id, p, el) || cs.getPropertyValue(p), 'wb-input is-num')),
        ['haut', 'droite', 'bas', 'gauche'].map((s) => h('span', null, s)));
      sec.append(propRow(id, el, 'padding-top', 'Padding', padGrid));
      if (isFlex) {
        sec.append(propRow(id, el, 'column-gap', 'Gap', h('div', { class: 'wb-ctl-line' },
          textInput(id, 'column-gap', currentValue(id, 'column-gap', el) || cs.columnGap, 'wb-input is-num'),
          h('span', { class: 'wb-faint' }, 'colonnes'),
          textInput(id, 'row-gap', currentValue(id, 'row-gap', el) || cs.rowGap, 'wb-input is-num'),
          h('span', { class: 'wb-faint' }, 'lignes'))));
      }
      sec.append(propRow(id, el, 'height', 'Hauteur', h('div', { class: 'wb-ctl-line' },
        textInput(id, 'height', currentValue(id, 'height', el), 'wb-input is-num', 'auto'),
        h('span', { class: 'wb-faint' }, 'min'),
        textInput(id, 'min-height', currentValue(id, 'min-height', el), 'wb-input is-num', 'auto'))));
      sec.append(propRow(id, el, 'width', 'Largeur', textInput(id, 'width', currentValue(id, 'width', el), 'wb-input is-num', 'auto')));
      body.append(sec);
    }

    const noteKey = `e:${id}`;
    const note = state.changes.notes[noteKey]?.text ?? '';
    const fsW = winnerOf(id, 'font-size', el);
    body.append(h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'Note pour le dev')),
      h('textarea', {
        class: 'wb-input', placeholder: 'Remarque sur cet élément (exportée avec le JSON)…', value: note,
        onchange: (e) => setChange('note', noteKey, null, e.target.value.trim()
          ? { text: e.target.value.trim(), sample: m.t ?? '', path: cssPath(el), rule: fsW && fsW.c[0] === 'r' ? DATA.rules[fsW.c[1]]?.s ?? null : null }
          : null),
      })));
  }

  // Styles ---------------------------------------------------------------------
  function renderStyles(body) {
    const groups = new Map();
    for (const el of canvas.querySelectorAll('[data-wb]')) {
      const id = Number(el.dataset.wb);
      if (!(DATA.el[id]?.k & 1)) continue;
      if (!el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue;
      const w = winnerOf(id, 'font-size', el);
      const key = w ? (w.c[0] === 'r' ? `r${w.c[1]}` : `${w.c[0]}${w.depth}`) : 'none';
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, w, ids: [], el }));
      g.ids.push(id);
    }
    const list = [...groups.values()].sort((a, b) => {
      const pa = textInfo(a.el, a.ids[0]).px, pb = textInfo(b.el, b.ids[0]).px;
      return pb - pa || b.ids.length - a.ids.length;
    });
    body.append(h('div', { class: 'wb-help' }, `${list.length} styles de texte à l’écran (règle qui fixe la taille). Cliquez pour sélectionner.`));
    const wrap = h('div', { class: 'wb-list' });
    for (const g of list) {
      const ti = textInfo(g.el, g.ids[0]);
      const meta = g.w && g.w.c[0] === 'r' ? DATA.rules[g.w.c[1]] : null;
      const mod = g.w && g.w.c[0] === 'r' && state.changes.rules[g.w.c[1]];
      const samples = [...new Set(g.ids.map((i) => DATA.el[i]?.t).filter(Boolean))].slice(0, 3).map((t) => short(t, 18));
      wrap.append(h('div', { class: `wb-list-item${mod ? ' is-mod' : ''}`, onclick: () => select(g.ids[0]) },
        h('div', { class: 'wb-li-main' }, samples.join(' · ') || '—'),
        h('span', { class: 'wb-chip' }, `${ti.token ?? fmt(ti.px)} · ${ti.weight} · ${g.ids.length}`),
        h('div', { class: 'wb-li-sub' }, meta ? `${meta.s} — ${basename(meta.f)}${meta.l ? `:${meta.l}` : ''}` : sourceLabel(g.w))));
    }
    body.append(wrap);
  }

  // Tokens ---------------------------------------------------------------------
  function renderTokens(body) {
    const usage = new Map();
    for (const el of canvas.querySelectorAll('[data-wb]')) {
      const id = Number(el.dataset.wb);
      if (!(DATA.el[id]?.k & 1)) continue;
      const t = textInfo(el, id).token;
      if (t) usage.set(t, (usage.get(t) || 0) + 1);
    }
    body.append(h('div', { class: 'wb-help' },
      'Échelle --rv-font-size-* (src/shared/styles/typography.css). Changer un token change tous les textes qui l’utilisent. Valeurs en px logiques (avant l’échelle du canevas).'));
    const list = h('div', { class: 'wb-list' });
    for (const t of DATA.tokens) {
      const ch = state.changes.tokens[t.name];
      const value = ch ? ch.to : t.value;
      list.append(h('div', { class: `wb-token${ch ? ' is-mod' : ''}` },
        h('span', { class: 'wb-token-name' }, t.short),
        h('span', { class: 'wb-token-sample', style: `font-size:${value};font-weight:600` }, 'Traçage Ag'),
        h('input', {
          class: 'wb-input is-num', value, title: `${t.name} (origine ${t.value})`,
          onchange: (e) => {
            const v = e.target.value.trim();
            const norm = /^[\d.]+$/.test(v) ? `${v}px` : v;
            setChange('token', t.name, null, !norm || norm === t.value ? null : { from: t.value, to: norm });
            renderPanel();
          },
        }),
        h('span', { class: 'wb-token-count', title: 'éléments à l’écran' }, String(usage.get(t.short) || 0))));
    }
    body.append(list);
  }

  // Écran ----------------------------------------------------------------------
  function numberField(value, onChange, opts = {}) {
    return h('input', {
      class: 'wb-input is-num', value: value ?? '', placeholder: opts.placeholder ?? '', title: opts.title ?? '',
      onchange: (e) => {
        const v = e.target.value.trim();
        onChange(v === '' ? null : Number(v.replace(',', '.')));
      },
    });
  }

  function renderScreen(body) {
    const vp = readViewport();
    const s = layout ? layout.appScale : 1;
    const params = effectiveScaleParams();
    body.append(h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'Écran')),
      h('dl', { class: 'wb-kv' },
        h('dt', null, 'Fenêtre'), h('dd', null, `${vp.w} × ${vp.h} px CSS`),
        h('dt', null, 'Densité'), h('dd', null, `DPR ${fmt(window.devicePixelRatio || 1)}${vp.hiDpi ? ' · Retina' : ''}`),
        h('dt', null, 'Échelle'), h('dd', null, `${fmt(s, 3)}${state.ui.scaleForce ? ' (forcée)' : ' (calculée comme l’app)'}`),
        h('dt', null, 'Canevas'), h('dd', null, layout ? `${fmt(layout.designW, 1)} × ${fmt(layout.designH, 1)} px logiques` : '—'),
        h('dt', null, 'Capture'), h('dd', null, `${DATA.meta.viewport.w} × ${DATA.meta.viewport.h} @${DATA.meta.viewport.dpr}`)),
      h('div', { class: 'wb-row' }, h('label', null, 'Forcer'),
        h('div', { class: 'wb-ctl-line' },
          numberField(state.ui.scaleForce, (v) => {
            state.ui.scaleForce = v;
            save();
            relayout();
            renderPanel();
          }, { placeholder: 'auto', title: 'Aperçu à une autre échelle (non exporté comme réglage)' }),
          h('span', { class: 'wb-faint' }, 'aperçu, ex. 0,92')))));

    const scaleRow = (key, label, hint) => {
      const ch = state.changes.scale[key];
      return h('div', { class: 'wb-row' }, h('label', null, label, ch ? h('i') : null),
        h('div', { class: 'wb-ctl' },
          h('div', { class: 'wb-ctl-line' },
            numberField(params[key], (v) => {
              setChange('scale', key, null, v == null || v === DEFAULT_SCALE[key] ? null : { from: DEFAULT_SCALE[key], to: v });
              renderPanel();
            }),
            h('span', { class: 'wb-faint' }, `origine ${String(DEFAULT_SCALE[key]).replace('.', ',')}`)),
          h('div', { class: 'wb-src' }, hint)));
    };
    body.append(h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'Échelle Retina (appScale.ts)')),
      h('div', { class: 'wb-help' }, 'Sous 1920×1080 sur Retina, l’app réduit le canevas d’une part du déficit, jamais sous le plancher. Ces réglages sont exportés.'),
      scaleRow('hidpiMin', 'Plancher', 'APP_SCALE_HIDPI_MIN'),
      scaleRow('hidpiShrink', 'Part', 'APP_SCALE_HIDPI_SHRINK_FACTOR')));

    const ui = state.ui;
    const check = (label, key) => h('label', { class: 'wb-check' },
      h('input', {
        type: 'checkbox', checked: ui[key], onchange: (e) => {
          ui[key] = e.target.checked;
          save();
          relayout();
          renderPanel();
        },
      }), label);
    body.append(h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'Panneaux (comme dans l’app)')),
      h('div', { class: 'wb-row' }, h('label', null, 'Gauche'), h('div', { class: 'wb-ctl-line' },
        numberField(ui.leftWidth, (v) => { ui.leftWidth = v ?? 360; save(); relayout(); renderPanel(); }), h('span', { class: 'wb-faint' }, 'px'))),
      h('div', { class: 'wb-row' }, h('label', null, 'Droite'), h('div', { class: 'wb-ctl-line' },
        numberField(ui.rightWidth, (v) => { ui.rightWidth = v ?? 360; save(); relayout(); renderPanel(); }), h('span', { class: 'wb-faint' }, 'px'))),
      h('div', { class: 'wb-row' }, h('label', null, 'Centre'), h('div', { class: 'wb-ctl-line' },
        numberField(ui.centerHeight, (v) => { ui.centerHeight = v; save(); relayout(); renderPanel(); }, { placeholder: 'auto' }), h('span', { class: 'wb-faint' }, 'px de haut'))),
      h('div', { class: 'wb-radio-line' }, check('Replier le panneau gauche', 'leftCollapsed'), check('Replier le panneau droit', 'rightCollapsed'), check('Replier le panneau central', 'centerCollapsed')),
      h('div', { class: 'wb-row' }, h('label', null, 'Étroit'), (() => {
        const sel = h('select', {
          class: 'wb-select', title: 'Fenêtre trop étroite pour les deux panneaux : l’app garde le dernier ouvert',
          onchange: (e) => { ui.sidePriority = e.target.value; save(); relayout(); renderPanel(); },
        }, h('option', { value: 'right' }, 'garder le panneau droit'), h('option', { value: 'left' }, 'garder le panneau gauche'));
        sel.value = ui.sidePriority;
        return sel;
      })())));

    const states = h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'État de l’interface'),
        state.view.applied.length || state.view.popup ? h('button', { class: 'wb-link', onclick: () => setState([]) }, 'état initial') : null),
      h('div', { class: 'wb-help' }, 'Clic droit sur la maquette = clic dans l’app : onglets, sections, interrupteurs, listes et menus capturés.'));
    const chips = h('div', { class: 'wb-chip-line' });
    for (const id of state.view.applied) {
      const t = TRIG.get(id);
      chips.append(h('span', { class: 'wb-chip', title: triggerLabel(t) }, short(t.label, 26), ' ',
        h('button', { class: 'wb-link is-muted', onclick: () => { removeTrigger(id); setState(state.view.applied, state.view.popup); } }, '×')));
    }
    if (state.view.popup) chips.append(h('span', { class: 'wb-chip is-dark' }, `menu : ${short(currentPopup()?.label ?? '', 24)}`));
    if (chips.children.length) states.append(chips);
    const goto = (kind, label) => {
      const list = DATA.triggers.filter((t) => t.kind === kind);
      const sel = h('select', {
        class: 'wb-select', onchange: (e) => {
          const t = TRIG.get(Number(e.target.value));
          if (!t) return;
          if (t.kind === 'popup') setState(t.ctx.slice(), t.id);
          else setState([...t.ctx, t.id]);
        },
      }, h('option', { value: '' }, `${list.length} ${kind === 'popup' ? 'menus et pop-ins' : 'états'}…`),
      list.map((t) => h('option', { value: String(t.id) }, triggerLabel(t))));
      return h('div', { class: 'wb-row' }, h('label', null, label), sel);
    };
    states.append(goto('persist', 'Aller à'), goto('popup', 'Ouvrir'));
    body.append(states);

    body.append(h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'Affichage')),
      h('label', { class: 'wb-check' }, h('input', {
        type: 'checkbox', checked: state.prefs.annotations, onchange: (e) => {
          state.prefs.annotations = e.target.checked;
          save();
          scheduleUi();
        },
      }), 'Afficher token · graisse sur tous les textes (A)')));

    const ref = state.ref;
    const refSec = h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'Calque de référence')),
      h('div', { class: 'wb-help' }, 'Capture d’écran de l’app réelle, à la même taille de fenêtre : en mode différence, le noir = superposition exacte.'),
      h('div', { class: 'wb-ctl-line' },
        h('button', { class: 'wb-btn is-small', onclick: () => fileInput.click() }, ref.src ? 'Changer l’image' : 'Choisir une capture…'),
        ref.src ? h('button', { class: 'wb-link is-muted', onclick: () => { ref.src = null; renderRef(); renderPanel(); } }, 'retirer') : null));
    if (ref.src) {
      refSec.append(
        h('div', { class: 'wb-row' }, h('label', null, 'Opacité'), h('input', {
          type: 'range', min: '0', max: '1', step: '0.05', value: String(ref.opacity),
          oninput: (e) => { ref.opacity = Number(e.target.value); renderRef(); },
        })),
        h('label', { class: 'wb-check' }, h('input', { type: 'checkbox', checked: ref.diff, onchange: (e) => { ref.diff = e.target.checked; renderRef(); } }), 'Mode différence'),
        h('label', { class: 'wb-check' }, h('input', {
          type: 'checkbox', checked: ref.scale === 'auto', onchange: (e) => { ref.scale = e.target.checked ? 'auto' : '1'; renderRef(); },
        }), 'Capture Retina (pixels ÷ DPR)'));
    }
    body.append(refSec);
  }

  // Modifs ---------------------------------------------------------------------
  function renderChanges(body) {
    const c = state.changes;
    const lines = h('div', { class: 'wb-list' });
    const line = (prop, from, to, onRevert) => h('div', { class: 'wb-change-line' },
      h('span', { class: 'wb-prop' }, prop),
      h('span', { class: 'wb-from' }, from ?? '—'), '→', h('span', { class: 'wb-to' }, to),
      h('button', { class: 'wb-link is-muted', title: 'Annuler cette modification', onclick: onRevert }, '×'));
    for (const [name, ch] of Object.entries(c.tokens)) {
      lines.append(h('div', { class: 'wb-change' }, h('div', { class: 'wb-change-head' }, h('b', null, 'Token'), h('span', { class: 'wb-faint' }, 'typography.css')),
        line(name.replace('--rv-font-size-', ''), ch.from, ch.to, () => { setChange('token', name, null, null); renderPanel(); })));
    }
    for (const [k, ch] of Object.entries(c.scale)) {
      lines.append(h('div', { class: 'wb-change' }, h('div', { class: 'wb-change-head' }, h('b', null, 'Échelle Retina'), h('span', { class: 'wb-faint' }, 'appScale.ts')),
        line(k, String(ch.from), String(ch.to), () => { setChange('scale', k, null, null); renderPanel(); })));
    }
    for (const [id, props] of Object.entries(c.rules)) {
      const m = DATA.rules[id] || {};
      const { elementCount } = samplesFor(Number(id));
      const item = h('div', { class: 'wb-change' },
        h('div', { class: 'wb-change-head' }, h('b', { title: m.s }, m.s ?? `règle ${id}`), h('span', { class: 'wb-faint' }, `${elementCount} él.`)),
        h('div', { class: 'wb-src', title: m.f }, `${m.f ?? ''}${m.l ? `:${m.l}` : ''}${m.c?.length ? ` · ${m.c.map((x) => `@${x.type} ${x.text}`).join(' ')}` : ''}`));
      for (const [p, ch] of Object.entries(props)) item.append(line(p, ch.from, ch.to, () => { setChange('rule', id, p, null); renderPanel(); }));
      lines.append(item);
    }
    for (const [id, props] of Object.entries(c.elements)) {
      const first = Object.values(props)[0];
      const item = h('div', { class: 'wb-change' },
        h('div', { class: 'wb-change-head' }, h('b', null, `Élément « ${short(first?.sample || '', 30)} »`)),
        h('div', { class: 'wb-src' }, first?.path ?? ''));
      for (const [p, ch] of Object.entries(props)) item.append(line(p, ch.from, ch.to, () => { setChange('el', id, p, null); renderPanel(); }));
      lines.append(item);
    }
    for (const [k, n] of Object.entries(c.notes)) {
      lines.append(h('div', { class: 'wb-change' },
        h('div', { class: 'wb-change-head' }, h('b', null, `Note${n.sample ? ` « ${short(n.sample, 30)} »` : ''}`),
          h('button', { class: 'wb-link is-muted', onclick: () => { setChange('note', k, null, null); renderPanel(); } }, '×')),
        h('div', { class: 'wb-help' }, n.text)));
    }
    if (!lines.children.length) lines.append(h('div', { class: 'wb-empty' }, 'Aucune modification pour l’instant.'));
    body.append(lines);

    const target = (value, label) => h('label', { class: 'wb-check' },
      h('input', { type: 'radio', name: 'wb-target', checked: state.prefs.target === value, onchange: () => { state.prefs.target = value; save(); } }), label);
    body.append(h('div', { class: 'wb-sec' },
      h('div', { class: 'wb-sec-title' }, h('span', null, 'Export')),
      h('div', { class: 'wb-row' }, h('label', null, 'Auteur'), h('input', {
        class: 'wb-input is-wide', value: state.prefs.author, placeholder: 'Nom', onchange: (e) => { state.prefs.author = e.target.value; save(); },
      })),
      h('textarea', {
        class: 'wb-input', value: state.prefs.note, placeholder: 'Note générale pour l’intégration…',
        onchange: (e) => { state.prefs.note = e.target.value; save(); },
      }),
      h('div', { class: 'wb-radio-line' }, h('span', { class: 'wb-muted' }, 'Ces modifications valent pour :'),
        target('all', 'Toutes les plateformes'), target('retina', 'Mac / Retina uniquement')),
      h('div', { class: 'wb-ctl-line' },
        h('button', { class: 'wb-btn is-primary', onclick: exportFile }, 'Exporter .json'),
        h('button', { class: 'wb-btn', onclick: () => fileInput.click() }, 'Importer…'),
        h('button', {
          class: 'wb-link is-muted', style: 'margin-left:auto', onclick: () => {
            if (!changeCount() && !Object.keys(state.changes.notes).length) return;
            if (!window.confirm('Annuler toutes les modifications ?')) return;
            revertAll();
            history.length = 0;
            redo.length = 0;
            save();
            relayout();
            renderPanel();
          },
        }, 'Tout réinitialiser'))));
  }

  // ── Sélection et événements ─────────────────────────────────────────────
  function pickAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !canvas.contains(hit)) return null;
    let el = hit.closest('[data-wb]');
    while (el && !DATA.el[el.dataset.wb]) el = el.parentElement?.closest('[data-wb]');
    if (!el) return null;
    // Texte non cliquable (pointer-events: none) sous le pointeur : le plus petit qui le contient.
    if (!(DATA.el[el.dataset.wb].k & 1) && el.getElementsByTagName('*').length < 400) {
      let best = null, area = Infinity;
      for (const d of el.querySelectorAll('[data-wb]')) {
        const m = DATA.el[d.dataset.wb];
        if (!m || !(m.k & 1)) continue;
        const r = d.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        if (r.width * r.height < area) {
          best = d;
          area = r.width * r.height;
        }
      }
      if (best) el = best;
    }
    return Number(el.dataset.wb);
  }

  function select(id) {
    state.selected = id;
    if (id != null && state.prefs.tab !== 'inspect') state.prefs.tab = 'inspect';
    if (state.prefs.hidden && id != null) togglePanel(false);
    renderPanel();
    scheduleUi();
  }

  function selectParent() {
    const el = state.selected != null ? elById(state.selected) : null;
    if (!el) return select(null);
    for (let p = el.parentElement; p && p !== canvas; p = p.parentElement) {
      if (p.dataset?.wb != null && DATA.el[p.dataset.wb]) return select(Number(p.dataset.wb));
    }
    select(null);
  }

  stage.addEventListener('mousemove', (e) => {
    const id = pickAt(e.clientX, e.clientY);
    if (id !== state.hover) {
      state.hover = id;
      scheduleUi();
    }
  });
  stage.addEventListener('mouseleave', () => {
    state.hover = null;
    scheduleUi();
  });
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'submit', 'input', 'change', 'dragstart']) {
    stage.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRightClick(e.clientX, e.clientY);
  }, true);
  stage.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    select(pickAt(e.clientX, e.clientY));
  }, true);
  stage.addEventListener('scroll', scheduleUi, true);

  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) && uiRoot.contains(e.target);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') {
      uiRoot.classList.add('is-peek');
      e.preventDefault();
      return;
    }
    if (typing(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoLast();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redoLast();
    } else if (!mod && e.key.toLowerCase() === 'w') {
      togglePanel();
    } else if (!mod && e.key.toLowerCase() === 'a') {
      state.prefs.annotations = !state.prefs.annotations;
      save();
      scheduleUi();
      if (state.prefs.tab === 'screen') renderPanel();
    } else if (e.key === 'Escape') {
      selectParent();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') uiRoot.classList.remove('is-peek');
  });
  window.addEventListener('blur', () => uiRoot.classList.remove('is-peek'));

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    dropzone.classList.add('is-on');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) dropzone.classList.remove('is-on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-on');
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f);
  });

  const resize = () => {
    relayout();
    placePanel();
    if (state.prefs.tab === 'screen') renderPanel();
  };
  window.addEventListener('resize', resize);
  window.matchMedia('(min-resolution: 1.95dppx)').addEventListener?.('change', resize);

  // ── Démarrage ───────────────────────────────────────────────────────────
  const saved = safe.get(STORE_KEY);
  if (saved) {
    Object.assign(state.changes, saved.changes || {});
    Object.assign(state.view, saved.view || {});
    Object.assign(state.ui, saved.ui || {});
  }
  Object.assign(state.prefs, safe.get(PREFS_KEY) || {});
  renderRegions();
  applyAll();
  relayout();
  renderPanel();
  togglePanel(state.prefs.hidden);
  document.fonts?.ready.then(relayout);

  // API pour verify.mjs (tests automatisés).
  window.__wb = {
    data: DATA,
    state,
    relayout,
    setView(v) {
      setState(v.applied ?? [], v.popup ?? null, v.anchor ?? null);
    },
    rightClick(el) {
      const r = el.getBoundingClientRect();
      onRightClick(r.left + Math.min(r.width / 2, 8), r.top + r.height / 2);
    },
    triggers: () => DATA.triggers,
    setUi(v) {
      Object.assign(state.ui, v);
      relayout();
    },
    select,
    editProp,
    setToken: (name, value) => setChange('token', name, null, value ? { from: tokenByName.get(name).value, to: value } : null),
    exportJson: buildExport,
    importJson,
    undo,
    redo: redoLast,
    winner: (id, prop) => {
      const el = elById(id);
      const w = el ? winnerOf(id, prop, el) : null;
      return w ? { type: w.c[0], rule: w.c[1], depth: w.depth, value: candValue(w.c, prop, el), selector: DATA.rules[w.c[1]]?.s ?? null } : null;
    },
    rects() {
      const out = {};
      for (const el of canvas.querySelectorAll('[data-wb]')) {
        const id = el.dataset.wb;
        if (!DATA.el[id]) continue;
        out[id] = logicalRect(el).map((v) => round(v, 2));
      }
      return out;
    },
    layout: () => layout,
    tab(name) {
      state.prefs.tab = name;
      renderPanel();
    },
    annotations(on) {
      state.prefs.annotations = on;
      scheduleUi();
    },
  };
})();
