/**
 * Feuilles CSS du workbench : analyse (règles numérotées, conditions,
 * spécificité), fichier d'origine de chaque règle (les `index.css` de l'app
 * importent des partiels, inlinés par Vite) et passage en noir et blanc.
 *
 * Les identifiants de règle sont globaux, dans l'ordre du document (feuilles
 * dans l'ordre des <style>, règles dans l'ordre du texte) : c'est l'ordre de
 * la cascade, le runtime s'en sert pour départager deux règles de même
 * spécificité.
 */
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

/** Sélecteurs d'état interactif : la maquette est figée, rien ne change au survol. */
const INTERACTIVE_PSEUDO = /:(hover|active|focus|focus-visible|focus-within)\b/;

/** Peinture retirée des feuilles et des styles inline ; le N&B vient des classes wb-*. */
const PAINT_PROPS = new Set([
  'color', 'background', 'background-color', 'background-image', 'background-blend-mode',
  'box-shadow', 'text-shadow', 'filter', 'backdrop-filter', '-webkit-backdrop-filter',
  'transition', 'transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function',
  'animation', 'animation-name', 'animation-duration', 'animation-delay', 'animation-iteration-count',
  'animation-timing-function', 'animation-fill-mode', 'animation-direction', 'animation-play-state',
  'will-change', 'mix-blend-mode', 'outline', 'outline-color', 'outline-style', 'outline-width', 'outline-offset',
  'caret-color', 'accent-color', 'text-decoration-color', '-webkit-text-fill-color', '-webkit-tap-highlight-color',
  'text-emphasis-color', 'column-rule-color',
]);
export const PAINT_PROP_LIST = [...PAINT_PROPS];

/** fill / stroke / stop-color : la couleur suit le texte (classes wb-c*). */
const CURRENT_COLOR_PROPS = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color']);
const KEEP_COLOR_VALUES = /^(none|transparent|currentcolor|inherit|initial|unset|context-fill|context-stroke)$/i;

/** Propriétés dont le workbench retrouve la règle source (édition + export). */
export const TEXT_PROPS = ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-transform'];
export const LAYOUT_PROPS = [
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'row-gap', 'column-gap', 'height', 'min-height', 'width',
];
export const ATTR_PROPS = [...TEXT_PROPS, ...LAYOUT_PROPS];

/** Longhands → shorthands qui les portent (règles conditionnelles, sans CDP). */
const SHORTHANDS = {
  'font-size': ['font'], 'font-weight': ['font'], 'line-height': ['font'],
  'padding-top': ['padding', 'padding-block', 'padding-block-start'],
  'padding-bottom': ['padding', 'padding-block', 'padding-block-end'],
  'padding-left': ['padding', 'padding-inline', 'padding-inline-start'],
  'padding-right': ['padding', 'padding-inline', 'padding-inline-end'],
  'row-gap': ['gap', 'grid-gap', 'grid-row-gap'],
  'column-gap': ['gap', 'grid-gap', 'grid-column-gap'],
};

export function declaresProp(declNames, prop) {
  if (declNames.has(prop)) return true;
  return (SHORTHANDS[prop] ?? []).some((s) => declNames.has(s));
}

function conditionsOf(node) {
  const conds = [];
  for (let p = node.parent; p && p.type !== 'root'; p = p.parent) {
    if (p.type === 'atrule' && ['media', 'container', 'supports'].includes(p.name)) {
      conds.unshift({ type: p.name, text: p.params.trim() });
    }
  }
  return conds;
}

function insideKeyframes(node) {
  for (let p = node.parent; p && p.type !== 'root'; p = p.parent) {
    if (p.type === 'atrule' && /keyframes$/.test(p.name)) return true;
  }
  return false;
}

/**
 * Spécificité (a, b, c) d'un sélecteur simple liste-libre : #id ; .classe,
 * [attr], :pseudo-classe ; type, ::pseudo-élément. :is/:not/:has = max des
 * arguments, :where = 0.
 */
export function specificity(selector) {
  let a = 0, b = 0, c = 0;
  const s = selector.trim();
  let i = 0;
  const add = (spec) => { a += spec[0]; b += spec[1]; c += spec[2]; };
  const readArgs = () => {
    let depth = 1, j = i;
    while (j < s.length && depth > 0) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') depth--;
      j++;
    }
    const inner = s.slice(i, j - 1);
    i = j;
    return inner;
  };
  const maxOf = (list) => splitSelectorList(list).map(specificity)
    .reduce((m, x) => (cmpSpec(x, m) > 0 ? x : m), [0, 0, 0]);
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { a++; i++; while (i < s.length && /[\w-]/.test(s[i])) i++; }
    else if (ch === '.') { b++; i++; while (i < s.length && /[\w-]/.test(s[i])) i++; }
    else if (ch === '[') { b++; while (i < s.length && s[i] !== ']') i++; i++; }
    else if (ch === ':' && s[i + 1] === ':') {
      c++; i += 2; while (i < s.length && /[\w-]/.test(s[i])) i++;
      if (s[i] === '(') { i++; readArgs(); }
    } else if (ch === ':') {
      i++;
      let name = '';
      while (i < s.length && /[\w-]/.test(s[i])) name += s[i++];
      if (s[i] === '(') {
        i++;
        const args = readArgs();
        if (name === 'where') continue;
        if (['is', 'not', 'has', 'matches', '-webkit-any'].includes(name)) add(maxOf(args));
        else if (['nth-child', 'nth-last-child'].includes(name)) {
          b++;
          const of = args.match(/\bof\b(.+)$/);
          if (of) add(maxOf(of[1]));
        } else b++;
      } else if (['before', 'after', 'first-line', 'first-letter'].includes(name)) c++;
      else b++;
    } else if (/[a-zA-Z]/.test(ch)) { c++; while (i < s.length && /[\w-]/.test(s[i])) i++; }
    else i++;
  }
  return [a, b, c];
}

export function cmpSpec(x, y) {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Découpe une liste de sélecteurs aux virgules de premier niveau. */
export function splitSelectorList(list) {
  const out = [];
  let depth = 0, cur = '', quote = null;
  for (const ch of list) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Sélecteur testable par `Element.matches` (sans pseudo-élément final). */
export function matchableSelector(sel) {
  return sel.replace(/::?(before|after|placeholder|marker|selection|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?\s*$/i, '').trim() || '*';
}

/**
 * Fichier d'origine de chaque offset du texte de feuille servi par Vite :
 * les `@import './x.css';` sont inlinés (contenu rogné), on retrouve chaque
 * segment dans l'ordre.
 */
export function buildOriginMap(devIdFile, browserText, repoRoot) {
  const segments = [];
  const visit = (file) => {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const re = /@import\s+['"]([^'"]+)['"]\s*;/g;
    let last = 0, m;
    const pieces = [];
    while ((m = re.exec(src))) {
      pieces.push({ start: last, end: m.index });
      pieces.push({ import: path.resolve(path.dirname(file), m[1]) });
      last = re.lastIndex;
    }
    pieces.push({ start: last, end: src.length });
    for (const p of pieces) {
      if (p.import) visit(p.import);
      else {
        const raw = src.slice(p.start, p.end);
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const lead = p.start + raw.indexOf(trimmed);
        segments.push({ file, src, srcOffset: lead, text: trimmed });
      }
    }
  };
  visit(devIdFile);
  let cursor = 0;
  const located = [];
  for (const seg of segments) {
    const at = browserText.indexOf(seg.text, cursor);
    if (at < 0) continue;
    located.push({ ...seg, at });
    cursor = at + seg.text.length;
  }
  const rel = (f) => path.relative(repoRoot, f).split(path.sep).join('/');
  return (offset) => {
    for (const seg of located) {
      if (offset >= seg.at && offset < seg.at + seg.text.length) {
        const srcOffset = seg.srcOffset + (offset - seg.at);
        const line = seg.src.slice(0, srcOffset).split('\n').length;
        return { file: rel(seg.file), line };
      }
    }
    return { file: rel(devIdFile), line: null };
  };
}

/**
 * Analyse une feuille. `firstId` : identifiant global de sa première règle.
 * Retourne les règles de style (hors @keyframes) avec sélecteurs,
 * conditions, déclarations et position (ligne/colonne 0-based du sélecteur,
 * comme les plages CDP).
 */
export function parseSheet(text, firstId, origin) {
  const root = postcss.parse(text);
  const rules = [];
  let id = firstId;
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    const start = rule.source?.start ?? { line: 1, column: 1, offset: 0 };
    const decls = {};
    rule.each((d) => {
      if (d.type === 'decl') decls[d.prop.toLowerCase()] = d.important ? `${d.value} !important` : d.value;
    });
    const where = origin ? origin(start.offset) : { file: null, line: null };
    rules.push({
      id: id++,
      node: rule,
      selector: rule.selector,
      selectors: rule.selectors,
      conds: conditionsOf(rule),
      decls,
      key: `${start.line - 1}:${start.column - 1}`,
      file: where.file,
      line: where.line,
    });
  });
  return { root, rules, nextId: id };
}

/**
 * CSS du workbench pour une feuille déjà analysée : peinture retirée,
 * fill/stroke en currentColor, sélecteurs interactifs retirés, @font-face et
 * @keyframes supprimés, `--wb-r:<id>` posé dans chaque règle gardée (le
 * runtime retrouve la règle CSSOM par cet identifiant).
 */
export function workbenchCss({ root, rules }) {
  const byNode = new Map(rules.map((r) => [r.node, r]));
  root.walkAtRules((at) => {
    if (at.name === 'font-face' || /keyframes$/.test(at.name) || at.name === 'import' || at.name === 'charset') at.remove();
  });
  root.walkRules((rule) => {
    const info = byNode.get(rule);
    if (!info) return;
    const kept = rule.selectors.filter((s) => !INTERACTIVE_PSEUDO.test(s));
    if (!kept.length) {
      rule.remove();
      return;
    }
    if (kept.length !== rule.selectors.length) rule.selectors = kept;
    rule.walkDecls((d) => {
      const prop = d.prop.toLowerCase();
      if (PAINT_PROPS.has(prop)) d.remove();
      else if (CURRENT_COLOR_PROPS.has(prop) && !KEEP_COLOR_VALUES.test(d.value.trim())) d.value = 'currentColor';
      else if (prop === 'scrollbar-color') d.value = 'var(--wb-scroll-thumb) transparent';
      // Couleurs de bordure gardées : les bordures visibles à la capture
      // reçoivent une classe wb-d* (!important), les autres restent transparentes.
    });
    rule.append({ prop: '--wb-r', value: String(info.id) });
  });
  // Blocs conditionnels vidés par le tri.
  root.walkAtRules((at) => {
    if (['media', 'container', 'supports'].includes(at.name) && !at.nodes?.some((n) => n.type !== 'comment')) at.remove();
  });
  root.walkComments((c) => c.remove());
  return root.toString().replace(/\n\s*\n/g, '\n');
}
