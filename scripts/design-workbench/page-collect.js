// Évalué dans la page de l'app (capture.mjs l'appelle avec `(source)(args)`).
// Sérialise des régions du dashboard en HTML statique noir et blanc :
//  - peinture retirée des styles inline, gris posés en classes wb-* calculées
//    depuis les styles calculés (fond composité sur les ancêtres puis
//    luminance inversée : le thème sombre devient une maquette claire) ;
//  - carte Mapbox vidée, <canvas> remplacés par des blocs ;
//  - chaque élément reçoit data-wb="<id>", ceux dont on veut la règle source
//    (textes, conteneurs auto-layout, contrôles) sont marqués data-wbq dans
//    le DOM vivant pour CSS.getMatchedStylesForNode.
// Exploration (clic droit du workbench = clic de l'app) : liste des éléments
// cliquables, différences de DOM avant / après un clic (patchs au plus petit
// sous-arbre changé), sérialisation de ces patchs, vérification du retour à
// l'état précédent. L'état entre deux appels vit dans window.__wbx.
(function collect(args) {
  const canvas = document.querySelector('[data-rv-canvas]');
  const appScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-scale')) || 1;
  const X = (window.__wbx ??= { stack: {} });

  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'LINK', 'TEMPLATE']);
  const dropped = (e) => DROP_TAGS.has(e.tagName) || e.classList?.contains('mapboxgl-marker') || e.classList?.contains('mapboxgl-popup');
  const kids = (el) => [...el.children].filter((c) => !dropped(c));

  function regionKey(el, index) {
    if (el.tagName === 'CANVAS') return null;
    if (el.querySelector(':scope .mapboxgl-map') || el.classList.contains('mapboxgl-map')) return 'map';
    const own = el.getAttribute('data-rv-region');
    if (own) return own;
    const child = el.firstElementChild?.getAttribute('data-rv-region');
    if (child) return `${child}-shell`;
    if (el.classList.contains('rvd-place-search')) return 'search';
    if (el.querySelector(':scope > aside.rvmvc-map-tools')) return 'map-tools';
    if (el.style.cursor === 'row-resize') return 'center-resize';
    // Dock des statuts de chargement : transitoire, pas d'interface à régler.
    if (el.style.zIndex === '31') return null;
    if (el.style.zIndex === '40') return 'map-overlay';
    return `misc-${index}`;
  }
  function regionsMap() {
    const m = new Map();
    [...canvas.children].forEach((el, i) => {
      const k = regionKey(el, i);
      if (k) m.set(k, el);
    });
    return m;
  }
  function pathOf(el) {
    const path = [];
    let n = el;
    while (n && n.parentElement !== canvas) {
      if (!n.parentElement) return null;
      path.unshift(kids(n.parentElement).indexOf(n));
      n = n.parentElement;
    }
    if (!n) return null;
    const key = regionKey(n, [...canvas.children].indexOf(n));
    return key ? { key, path } : null;
  }
  function resolve(key, path) {
    let el = regionsMap().get(key);
    for (const i of path) {
      if (!el) return null;
      el = kids(el)[i];
    }
    return el || null;
  }
  /** État des champs recopié en attribut : une case cochée change le DOM comparé. */
  function syncForm(root) {
    for (const f of root.querySelectorAll('input, textarea, select')) {
      const v = f.type === 'checkbox' || f.type === 'radio' ? String(f.checked) : f.value;
      if (f.getAttribute('data-wbstate') !== v) f.setAttribute('data-wbstate', v);
    }
  }
  const visibleMenus = () => [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')]
    .filter((e) => e.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })).length;
  const visualRect = (el) => {
    const r = el.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    return [(r.left - c.left) / appScale, (r.top - c.top) / appScale, r.width / appScale, r.height / appScale].map((v) => +v.toFixed(2));
  };

  if (args.op === 'settle') {
    // Interface au repos : aucune mutation du DOM (hors carte) pendant `quiet`
    // ms et aucune animation finie en cours, au plus `max` ms.
    return new Promise((resolve) => {
      const quiet = args.quiet ?? 250, max = args.max ?? 1500;
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
        if (now - t0 > max || (now - last >= quiet && !busy())) {
          mo.disconnect();
          resolve(Math.round(now - t0));
        } else setTimeout(tick, 20);
      };
      setTimeout(tick, 20);
    });
  }

  if (args.op === 'clear') {
    document.querySelectorAll('[data-wbq]').forEach((e) => {
      e.removeAttribute('data-wbq');
      e.removeAttribute('data-wbk');
    });
    return 0;
  }

  if (args.op === 'anchor') {
    const el = (0, eval)(args.js);
    return el ? { ...pathOf(el), rect: visualRect(el) } : null;
  }

  if (args.op === 'match') {
    // Règles conditionnelles (fausses à cette taille) qui ciblent quand même
    // l'élément : le runtime les réévalue à la taille du designer.
    const compiled = [];
    for (const r of args.rules) {
      try {
        document.querySelector(r.sel);
        compiled.push(r);
      } catch {
        /* sélecteur que le moteur ne connaît pas */
      }
    }
    const out = {};
    for (const el of document.querySelectorAll('[data-wbq]')) {
      const hits = [];
      for (const r of compiled) {
        try {
          if (el.matches(r.sel)) hits.push(r.i);
        } catch {
          /* ignore */
        }
      }
      if (hits.length) out[el.getAttribute('data-wbq')] = hits;
    }
    return out;
  }

  // ── Exploration ─────────────────────────────────────────────────────────
  const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const famOf = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => !/^(is-|wb-)|--(active|on|open)$/.test(c)).sort().join('.')}`;
  const ACTIVE_RE = /(^|\s)(is-active|is-selected|is-on|is-checked)(\s|$)|--active(\s|$)/;
  const isActive = (el) => ACTIVE_RE.test(el.className?.baseVal ?? el.className ?? '')
    || ['aria-selected', 'aria-pressed', 'aria-checked'].some((a) => el.getAttribute(a) === 'true');

  const PRIORITY = ['left-panel-shell', 'right-panel-shell', 'center-toolbar', 'center-panel', 'search', 'map-tools', 'map-overlay'];

  if (args.op === 'candidates') {
    const re = new RegExp(args.excludeLabel, 'i');
    const roots = args.scope
      ? args.scope.map((s) => resolve(s.key, s.path)).filter(Boolean)
      : [...regionsMap().entries()].filter(([k]) => k !== 'map')
        // Panneaux d'abord : une capture interrompue garde l'essentiel.
        .sort(([a], [b]) => (PRIORITY.indexOf(a) + 99) % 99 - (PRIORITY.indexOf(b) + 99) % 99)
        .map(([, el]) => el);
    const seen = new Set();
    const out = [];
    for (const root of roots) {
      const list = [root, ...root.querySelectorAll(args.interactive)].filter((e) => e.matches(args.interactive));
      for (const el of list) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (args.exclude.some((s) => el.closest(s))) continue;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const label = labelOf(el);
        if (re.test(label)) continue;
        if (!el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const where = pathOf(el);
        if (!where || where.key === 'map') continue;
        // Groupe d'options exclusives (onglets, segments, lignes de fond de carte) :
        // le retour se fait en recliquant l'option active d'avant.
        let radio = null;
        const fam = famOf(el);
        const sibs = el.parentElement ? kids(el.parentElement).filter((s) => famOf(s) === fam) : [];
        const tabGroup = el.getAttribute('role') === 'tab' ? [...(el.closest('[role="tablist"]') || el.parentElement).querySelectorAll('[role="tab"]')] : null;
        const group = tabGroup || (sibs.length > 1 ? sibs : null);
        if (group && !isActive(el)) {
          // Exclusif seulement si une seule option est active (pas des puces à cocher).
          const actives = group.filter((s) => isActive(s));
          if (actives.length === 1) radio = pathOf(actives[0]);
        }
        out.push({
          ...where,
          label,
          fam,
          sig: `${fam}|${label}`,
          radio,
          hasPopup: el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false',
        });
      }
    }
    return out;
  }

  if (args.op === 'target') {
    const el = resolve(args.key, args.path);
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit) || (el.tagName === 'LABEL' && el.control === hit));
    // Décor posé sur la cible (indicateur d'onglet actif…) : clic synthétique.
    const covered = !ok && !!hit && !hit.closest('button, [role="button"], [role="tab"], a, input, label');
    return { ok: ok || covered, synthetic: covered, x: Math.round(x), y: Math.round(y), rect: visualRect(el), sig: `${famOf(el)}|${labelOf(el)}` };
  }

  if (args.op === 'click') {
    const el = resolve(args.key, args.path);
    if (!el) return false;
    el.click();
    return true;
  }

  if (args.op === 'closeIn') {
    // Bouton « fermer » dans ce qu'un clic a ouvert (la légende remplace son bouton).
    const re = /fermer|close|réduire|masquer la légende|replier/i;
    for (const s of args.scope) {
      const root = resolve(s.key, s.path);
      if (!root) continue;
      const btn = [root, ...root.querySelectorAll('button, [role="button"]')].find((b) => b.matches?.('button, [role="button"]') && re.test(labelOf(b)) && b.checkVisibility?.());
      if (btn) {
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return null;
  }

  if (args.op === 'fixExpanded') {
    // Accordéons ouverts / fermés par effet de bord (activer une couche ouvre sa
    // section) : on reclique ceux dont aria-expanded diffère de l'état de référence.
    const ref = X.stack[args.level] ?? X.pre;
    const out = [];
    for (const [k, before] of Object.entries(ref)) {
      const live = regionsMap().get(k);
      if (!live) continue;
      for (const b of before.querySelectorAll('[aria-expanded]')) {
        const path = [];
        for (let n = b; n && n !== before; n = n.parentElement) path.unshift(kids(n.parentElement).indexOf(n));
        let a = live;
        for (const i of path) a = a && kids(a)[i];
        if (!a || a.getAttribute('aria-expanded') === b.getAttribute('aria-expanded') || !a.matches('button, [role="button"]')) continue;
        if (!a.checkVisibility?.()) continue;
        a.scrollIntoView({ block: 'nearest' });
        const r = a.getBoundingClientRect();
        out.push({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        if (out.length >= 3) return out;
      }
    }
    return out;
  }

  if (args.op === 'pre') {
    syncForm(canvas);
    const clones = {};
    for (const [k, el] of regionsMap()) if (k !== 'map') clones[k] = el.cloneNode(true);
    X.pre = clones;
    if (args.level != null) X.stack[args.level] = clones;
    document.body.querySelectorAll(':scope > *').forEach((e) => e.setAttribute('data-wbold', ''));
    X.preMenus = visibleMenus();
    return Object.keys(clones).length;
  }

  if (args.op === 'post' || args.op === 'restored') {
    syncForm(canvas);
    const now = regionsMap();
    // Délais d'animation d'apparition (lignes de la feuille de route) : changent
    // à chaque rendu sans rien changer à l'interface.
    // Variables CSS inline (hauteurs calculées par la mise en page : le workbench
    // les recalcule) : idem.
    const normStyle = (v) => (v || '').replace(/(^|;)\s*((animation|transition)[\w-]*|--[\w-]+)\s*:[^;]*/g, '$1').replace(/;+\s*$/, '').replace(/^;+/, '').replace(/;\s*;/g, ';').trim();
    const sameAttrs = (b, a) => {
      const skip = (n) => n === 'data-wbq';
      const ba = [...b.attributes].filter((x) => !skip(x.name));
      const aa = [...a.attributes].filter((x) => !skip(x.name));
      if (ba.length !== aa.length) return false;
      // Identifiants React (useId : « _r_g_ », « :r1: ») : changent à chaque montage.
      const normId = (v) => (v || '').replace(/_r_[a-z0-9]+_|:r[a-z0-9]+:/gi, 'R');
      return ba.every((x) => (x.name === 'style' ? normStyle(a.getAttribute('style')) === normStyle(x.value) : normId(a.getAttribute(x.name)) === normId(x.value)));
    };
    const sigKids = (el) => [...el.childNodes].filter((n) => (n.nodeType === 1 && !dropped(n)) || (n.nodeType === 3 && n.textContent.trim()));
    // Parties qui changent seules (statut d'enregistrement, annuler / rétablir) :
    // ni patch, ni échec de retour en arrière.
    const ignored = (n) => n.nodeType === 1 && args.ignore && n.matches(args.ignore);
    const diff = (b, a, path, key, out) => {
      if (b.isEqualNode(a) || ignored(a) || ignored(b)) return;
      const replace = () => out.push({ key, path: path.slice(), type: 'replace', size: a.getElementsByTagName('*').length });
      if (b.nodeType !== 1 || a.nodeType !== 1 || b.tagName !== a.tagName) return replace();
      if (a.classList.contains('mapboxgl-map')) return;
      const bk = sigKids(b), ak = sigKids(a);
      if (bk.length !== ak.length) return replace();
      for (let i = 0; i < bk.length; i++) {
        if (bk[i].nodeType !== ak[i].nodeType || (bk[i].nodeType === 1 && bk[i].tagName !== ak[i].tagName)) return replace();
        if (bk[i].nodeType === 3 && bk[i].textContent !== ak[i].textContent) return replace();
      }
      if (!sameAttrs(b, a)) {
        // Petit sous-arbre : tout re-sérialiser (les gris des enfants suivent
        // l'état, ex. onglet actif) ; gros : seulement les attributs.
        if (a.getElementsByTagName('*').length <= 300) return replace();
        out.push({ key, path: path.slice(), type: 'attrs', size: 1 });
      }
      const be = bk.filter((n) => n.nodeType === 1), ae = ak.filter((n) => n.nodeType === 1);
      for (let i = 0; i < ae.length; i++) {
        path.push(i);
        diff(be[i], ae[i], path, key, out);
        path.pop();
      }
    };
    const patches = [];
    const ref = args.op === 'restored' && args.level != null ? X.stack[args.level] ?? X.pre : X.pre;
    for (const [k, b] of Object.entries(ref)) {
      const a = now.get(k);
      if (!a) continue;
      diff(b, a, [], k, patches);
    }
    if (args.op === 'restored') {
      return {
        ok: !patches.length,
        patches: patches.slice(0, 4).map((pt) => {
          const el = resolve(pt.key, pt.path);
          const before = (() => { let n = ref[pt.key]; for (const i of pt.path) n = n && kids(n)[i]; return n; })();
          return { ...pt, cls: String(el?.className?.baseVal ?? el?.className ?? '').slice(0, 60), text: (el?.textContent || '').slice(0, 40), was: (before?.outerHTML || '').replace(/ data-wb\w*="[^"]*"/g, '').slice(0, 220), now: (el?.outerHTML || '').replace(/ data-wb\w*="[^"]*"/g, '').slice(0, 220) };
        }),
      };
    }
    let inverse = false;
    if (args.level != null && X.stack[args.level]) {
      inverse = Object.entries(X.stack[args.level]).every(([k, b]) => {
        const a = now.get(k);
        return !a || b.isEqualNode(a);
      });
    }
    const layers = [];
    document.body.querySelectorAll(':scope > *:not([data-wbold])').forEach((e, i) => {
      if (/^(SCRIPT|STYLE|IFRAME|LINK)$/.test(e.tagName) || e.classList.contains('rv-cursor-loader')) return;
      if (!e.checkVisibility?.()) return;
      const r = e.getBoundingClientRect();
      if (r.width < 2 && r.height < 2 && !e.children.length) return;
      e.setAttribute('data-wbov', String(i));
      layers.push(`[data-wbov="${i}"]`);
    });
    const popupNode = visibleMenus() > (X.preMenus ?? 0);
    return { patches, layers, inverse, popupNode };
  }

  if (args.op === 'unmark') {
    document.querySelectorAll('[data-wbold],[data-wbov]').forEach((e) => {
      e.removeAttribute('data-wbold');
      e.removeAttribute('data-wbov');
    });
    return 0;
  }

  // ── Couleurs ────────────────────────────────────────────────────────────
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  probe.canvas.width = probe.canvas.height = 1;
  const colorCache = new Map();
  function parseColor(str) {
    if (!str || str === 'transparent') return [0, 0, 0, 0];
    let c = colorCache.get(str);
    if (c) return c;
    const m = str.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
    if (m) c = [+m[1], +m[2], +m[3], m[4] == null ? 1 : +m[4]];
    else {
      const s = str.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
      if (s) c = [s[1] * 255, s[2] * 255, s[3] * 255, s[4] == null ? 1 : +s[4]];
      else {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = '#000';
        probe.fillStyle = str;
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        c = [d[0], d[1], d[2], d[3] / 255];
      }
    }
    colorCache.set(str, c);
    return c;
  }
  const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  const sat = (c) => {
    const mx = Math.max(c[0], c[1], c[2]);
    const mn = Math.min(c[0], c[1], c[2]);
    return mx > 0 ? (mx - mn) / mx : 0;
  };
  const isAccent = (c, minAlpha) => c[3] >= minAlpha && sat(c) > 0.45 && Math.max(c[0], c[1], c[2]) > 60;
  const over = (top, bottom) => [
    top[0] * top[3] + bottom[0] * (1 - top[3]),
    top[1] * top[3] + bottom[1] * (1 - top[3]),
    top[2] * top[3] + bottom[2] * (1 - top[3]),
    1,
  ];
  const step = (g) => Math.max(0, Math.min(20, Math.round(g * 20)));
  // Fond moyen de la carte (imagerie) : base du compositing des panneaux.
  const MAP_BASE = [38, 42, 38, 1];

  // ── Styles inline : sans peinture ───────────────────────────────────────
  const scratch = document.createElement('div');
  const PAINT = args.paintProps;
  function cleanStyle(text) {
    if (!text) return '';
    scratch.style.cssText = text;
    for (const p of PAINT) scratch.style.removeProperty(p);
    for (const p of ['fill', 'stroke', 'stop-color']) {
      const v = scratch.style.getPropertyValue(p);
      if (v && !/^(none|transparent|currentcolor|inherit)$/i.test(v)) scratch.style.setProperty(p, 'currentColor');
    }
    return scratch.style.cssText;
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  /** Rectangle logique, défilements des ancêtres annulés (le workbench s'ouvre défilé à 0). */
  const rectOf = (el) => {
    const r = visualRect(el);
    let sx = 0, sy = 0;
    for (let p = el.parentElement; p && p !== canvas && p !== document.body; p = p.parentElement) {
      sx += p.scrollLeft;
      sy += p.scrollTop;
    }
    return [+(r[0] + sx).toFixed(2), +(r[1] + sy).toFixed(2), r[2], r[3]];
  };

  // Clé d'attribution : la même chaîne d'ancêtres (balise, classes, attributs
  // que les sélecteurs lisent, rang parmi les frères) donne les mêmes règles ;
  // capture.mjs ne redemande pas CSS.getMatchedStylesForNode pour une clé connue.
  const segOf = (n) => {
    let a = '';
    for (const x of n.attributes) {
      const nm = x.name;
      if (nm === 'class' || nm === 'id' || nm === 'role' || nm === 'type' || nm === 'disabled' || nm.startsWith('aria-')
        || (nm.startsWith('data-') && !nm.startsWith('data-wb'))) a += `${nm}=${x.value};`;
    }
    const p = n.parentElement;
    const sibs = p ? p.children : null;
    return `${n.tagName}|${a}|${sibs ? Array.prototype.indexOf.call(sibs, n) : 0}/${sibs ? sibs.length : 0}>`;
  };
  const prefixMemo = new Map();
  const prefixOf = (n) => {
    if (!n || n === canvas || n === document.body || n === document.documentElement) return '';
    let v = prefixMemo.get(n);
    if (v == null) {
      v = prefixOf(n.parentElement) + segOf(n);
      prefixMemo.set(n, v);
    }
    return v;
  };
  const hashStr = (str) => {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ c, 2246822519);
    }
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  };
  const attrKey = (el) => hashStr(`${prefixOf(el)}|style=${el.getAttribute('style') || ''}|chk=${el.checked ?? ''}`);

  let nextId = args.startId;
  const meta = {};
  const icons = new Set();
  const LAYOUT_DISPLAY = /^(inline-)?(flex|grid)$/;
  const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'A']);
  const BORDER_SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  function borderClasses(cs, eff, prefix) {
    const sides = [];
    for (const side of BORDER_SIDES) {
      const w = parseFloat(cs[`border${side}Width`]);
      const st = cs[`border${side}Style`];
      const c = parseColor(cs[`border${side}Color`]);
      if (!(w > 0) || st === 'none' || st === 'hidden' || c[3] < 0.03) {
        sides.push(null);
        continue;
      }
      const g = isAccent(c, 0.35) ? 0.12 : 1 - lum(over(c, eff));
      sides.push(step(g));
    }
    if (sides.every((s) => s != null && s === sides[0])) return [`${prefix}${sides[0]}`];
    return sides.map((s, i) => (s == null ? null : `${prefix}${'trbl'[i]}${s}`)).filter(Boolean);
  }

  function pseudoClasses(el, which, eff, out) {
    const cs = getComputedStyle(el, which);
    if (!cs || cs.content === 'none' || cs.content === 'normal' || cs.display === 'none') return;
    const tag = which === '::before' ? 'pb' : 'pa';
    const bg = parseColor(cs.backgroundColor);
    if (bg[3] >= 0.02) out.push(`wb-${tag}${isAccent(bg, 0.35) ? 0 : step(1 - lum(over(bg, eff)))}`);
    out.push(...borderClasses(cs, eff, `wb-${tag}d`));
    const fg = parseColor(cs.color);
    if (/^["']./.test(cs.content)) out.push(`wb-${tag}c${step(1 - lum(over(fg, eff)))}`);
  }

  const grayHex = (g) => {
    const c = Math.max(0, Math.min(255, Math.round(g * 255)));
    const x = c.toString(16).padStart(2, '0');
    return `#${x}${x}${x}`;
  };
  /** Couleurs SVG → gris (luminance inversée, gardée telle quelle sur fond accent). */
  function svgPaint(el, ctx) {
    const cs = getComputedStyle(el);
    const out = [];
    for (const [prop, key] of [['fill', 'fill'], ['stroke', 'stroke'], ['stop-color', 'stopColor']]) {
      const v = cs[key];
      if (!v || v === 'none' || v.startsWith('url(')) continue;
      const c = parseColor(v);
      if (c[3] < 0.02) {
        out.push(`${prop}:transparent`);
        continue;
      }
      const comp = over(c, ctx.eff);
      out.push(`${prop}:${grayHex(ctx.accent ? lum(comp) : 1 - lum(comp))}`);
    }
    return out.join(';');
  }

  function directText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, ' ').trim();
  }

  /**
   * Gris d'un élément (hors SVG) et contexte transmis à ses enfants.
   * ctx : { eff (fond composité RGB sous l'élément), accent (fond saturé →
   * noir en N&B), fg (pas de gris du texte hérité), inSvg }
   */
  function paint(el, ctx, cs) {
    const classes = [];
    let eff = ctx.eff, accent = ctx.accent, fgStep = ctx.fg;
    const bg = parseColor(cs.backgroundColor);
    if (bg[3] >= 0.02) {
      if (isAccent(bg, 0.35)) {
        accent = true;
        classes.push('wb-b0');
      } else {
        // Sur un fond accent (noir en N&B), un fond clair (icône en masque,
        // pastille) reste clair : polarité d'origine gardée.
        const comp = over(bg, eff);
        classes.push(`wb-b${step(ctx.accent ? lum(comp) : 1 - lum(comp))}`);
        accent = ctx.accent && lum(comp) < 0.5;
      }
      eff = over(bg, eff);
    }
    classes.push(...borderClasses(cs, eff, 'wb-d'));
    const fg = parseColor(cs.color);
    const fgEff = over(fg, eff);
    let g;
    if (accent) g = lum(fgEff);
    else if (isAccent(fg, 0.5)) g = 0.06;
    else g = 1 - lum(fgEff);
    const s = step(g);
    if (s !== ctx.fg) {
      classes.push(`wb-c${s}`);
      fgStep = s;
    }
    pseudoClasses(el, '::before', eff, classes);
    pseudoClasses(el, '::after', eff, classes);
    return { classes, child: { eff, accent, fg: fgStep, inSvg: ctx.inSvg || el.tagName === 'svg' } };
  }

  const base = { eff: MAP_BASE, accent: false, fg: -1, inSvg: false };
  /** Contexte de gris à l'entrée de `el` (patch sérialisé seul). */
  function ctxAt(el) {
    const chain = [];
    for (let n = el.parentElement; n && n !== canvas && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
    let ctx = base;
    for (const n of chain) {
      if (ctx.inSvg) continue;
      ctx = paint(n, ctx, getComputedStyle(n)).child;
    }
    return ctx;
  }

  function ser(el, ctx, shallow = false) {
    if (el.nodeType === 3) return esc(el.textContent);
    if (el.nodeType !== 1) return '';
    if (dropped(el)) return '';
    const isSvg = el instanceof SVGElement;
    const tag = isSvg ? el.tagName : el.tagName.toLowerCase();
    if (isSvg && ctx.inSvg && (tag === 'style' || tag === 'image')) return '';

    const id = nextId++;
    let classes = [];
    let cs = null;
    let childCtx = { ...ctx, inSvg: ctx.inSvg || tag === 'svg' };
    let replaced = null;
    const svgStyle = ctx.inSvg ? svgPaint(el, ctx) : '';

    if (!ctx.inSvg) {
      cs = getComputedStyle(el);
      const p = paint(el, ctx, cs);
      classes = p.classes;
      childCtx = p.child;

      if (el.tagName === 'CANVAS') {
        const r = el.getBoundingClientRect();
        const pr = el.parentElement?.getBoundingClientRect();
        const fills = pr && Math.abs(pr.width - r.width) < 1 && Math.abs(pr.height - r.height) < 1;
        replaced = {
          tag: 'div',
          extraClass: 'wb-ph',
          style: fills
            ? 'width:100%;height:100%'
            : `width:${+(r.width / appScale).toFixed(2)}px;height:${+(r.height / appScale).toFixed(2)}px`,
        };
        if (cs.display === 'inline') replaced.style += ';display:inline-block';
      }

      // Éléments dont on veut la règle source.
      const text = directText(el);
      const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
      const isText = !!text || (isField && !!(el.value || el.placeholder));
      if (el.tagName === 'IMG') {
        icons.add(el.getAttribute('src') || '');
        classes.push(ctx.accent ? 'wb-img wb-img-acc' : 'wb-img');
      }
      const isLayout =
        LAYOUT_DISPLAY.test(cs.display) ||
        CONTROL_TAGS.has(el.tagName) ||
        el.getAttribute('role') === 'button' ||
        parseFloat(cs.paddingTop) + parseFloat(cs.paddingRight) + parseFloat(cs.paddingBottom) + parseFloat(cs.paddingLeft) > 0;
      if ((isText || isLayout) && !replaced && cs.display !== 'none') {
        el.setAttribute('data-wbq', String(id));
        el.setAttribute('data-wbk', attrKey(el));
        const m = { k: (isText ? 1 : 0) | (isLayout ? 2 : 0), r: rectOf(el) };
        if (isText) {
          m.t = (text || el.value || el.placeholder || '').slice(0, 60);
          m.cs = [cs.fontSize, cs.fontWeight, cs.lineHeight, cs.letterSpacing, cs.textTransform];
        }
        if (isLayout) {
          m.ly = [cs.display, cs.flexDirection, cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft,
            cs.rowGap, cs.columnGap, cs.height, cs.minHeight, cs.width, cs.alignItems, cs.justifyContent, cs.flexWrap];
        }
        meta[id] = m;
      }
    }

    const outTag = replaced ? replaced.tag : tag;
    let attrs = ` data-wb="${id}"`;
    let classAttr = '';
    for (const a of el.attributes) {
      const name = a.name;
      if (/^on/i.test(name) || /^data-wb/.test(name) || name === 'contenteditable' || name === 'autofocus') continue;
      if (name === 'srcset') continue;
      if (replaced && (name === 'src' || name === 'width' || name === 'height' || name === 'alt')) continue;
      if (name === 'class') {
        classAttr = isSvg ? (el.getAttribute('class') || '') : el.className;
        continue;
      }
      let v = a.value;
      if (name === 'style') {
        v = cleanStyle(v);
        if (replaced) v = `${v};${replaced.style}`;
        if (svgStyle) v = v ? `${v};${svgStyle}` : svgStyle;
        if (!v) continue;
      } else if (name === 'value' || name === 'checked' || name === 'selected') continue;
      attrs += ` ${name}="${escAttr(v)}"`;
    }
    if (replaced && !el.hasAttribute('style')) attrs += ` style="${escAttr(replaced.style)}"`;
    if (svgStyle && !el.hasAttribute('style')) attrs += ` style="${escAttr(svgStyle)}"`;
    const allClasses = [classAttr, replaced?.extraClass, ...classes].filter(Boolean).join(' ').trim();
    if (allClasses) attrs += ` class="${escAttr(allClasses)}"`;

    if (el.tagName === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) attrs += ' checked';
      } else if (el.value) attrs += ` value="${escAttr(el.value)}"`;
      return `<input${attrs} readonly tabindex="-1">`;
    }
    if (el.tagName === 'TEXTAREA') return `<textarea${attrs} readonly tabindex="-1">${shallow ? '' : esc(el.value)}</textarea>`;
    if (el.tagName === 'OPTION' && el.selected) attrs += ' selected';
    if (replaced || shallow) return `<${outTag}${attrs}></${outTag}>`;
    if (/^(area|base|br|col|embed|hr|img|input|meta|param|source|track|wbr)$/i.test(tag)) return `<${outTag}${attrs}>`;

    let inner = '';
    if (!el.classList?.contains('mapboxgl-map')) for (const child of el.childNodes) inner += ser(child, childCtx);
    return `<${outTag}${attrs}>${inner}</${outTag}>`;
  }

  const regions = [];
  if (args.op === 'regions') {
    [...canvas.children].forEach((el, i) => {
      const key = regionKey(el, i);
      if (!key) return;
      if (args.keys && !args.keys.includes(key)) return;
      regions.push({ key, html: ser(el, base), z: getComputedStyle(el).zIndex });
    });
  } else if (args.op === 'nodes') {
    for (const { key, selector } of args.nodes) {
      const el = document.querySelector(selector);
      if (!el) continue;
      regions.push({ key, html: ser(el, base), rect: visualRect(el), inCanvas: canvas.contains(el) });
    }
  } else if (args.op === 'patches') {
    for (const p of args.patches) {
      const el = resolve(p.key, p.path);
      if (!el) continue;
      regions.push({ ...p, html: ser(el, ctxAt(el), p.type === 'attrs') });
    }
  }
  const qOrder = [...document.querySelectorAll('[data-wbq]')].map((e) => +e.getAttribute('data-wbq'));
  return {
    regions,
    meta,
    nextId,
    qOrder,
    icons: [...icons],
    appScale,
    canvas: { w: canvas.offsetWidth, h: canvas.offsetHeight },
  };
})
