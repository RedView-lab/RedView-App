/**
 * Extraction des chaînes visibles par l'utilisateur dans le code de src/ et
 * lecture des paires { fr, en } : partagées par l'audit i18n
 * (scripts/quality/i18n-audit.mjs) et le contrôle du chemin critique
 * (scripts/quality/check-bundle.mjs : textes affichés sans l'éditeur).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

/** Pas de l'UI : tests et données de test, données à noms propres, libellés français par conception. */
export const NOT_UI_FILES = [
  /\.test\.tsx?$/,
  /[\\/]src[\\/]shared[\\/]test[\\/]/,
  /[\\/]features[\\/]collab[\\/]sim[\\/]/, // données de test du simulateur de co-édition
  /[\\/]features[\\/]lidar[\\/]lib[\\/]japan[\\/]/, // noms de préfectures et de jeux de données (noms propres)
  /[\\/]features[\\/]legal[\\/]content[\\/]/, // pages légales : texte complet en français ET en anglais, pas de paires (data-rv-no-translate)
  /[\\/]shared[\\/]lib[\\/]analytics[\\/]labels\.ts$/, // Umami labels, plain French on purpose (docs/analytics)
  /[\\/]shared[\\/]i18n[\\/]config[\\/]types\.ts$/, // noms de langues, chacun écrit dans sa propre langue
];

/** Chaînes en position d'allure UI qui n'atteignent jamais l'écran. */
const TECHNICAL_STRINGS = new Set([
  'Flow-Py block without its job', // erreur de protocole de worker (pool avalanche du LiDAR)
  'WebGPU', 'WebGL 2', // noms des moteurs de rendu dans la ligne de débogage du visualiseur
]);
/** Idem, pour les gabarits littéraux : un préfixe de leur texte statique. */
const TECHNICAL_TEMPLATE_PREFIXES = [
  'Cache terrain ', // libellé d'une tâche d'écriture de cache en arrière-plan (journaux)
  'BRouter HTTP ', 'BRouter upload HTTP ', // erreur amont brute, traduite en message par brouterErrorMessage
];

// --- helpers ---------------------------------------------------------------

export function canonicalize(text) {
  return text
    .replace(/ /g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'pkg') continue;
      walkFiles(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const NEUTRAL_WORDS = new Set([
  'redview', 'gpx', 'fit', 'tcx', 'kml', 'kmz', 'geojson', 'csv', 'json', 'png', 'svg', 'pdf', 'las', 'laz', 'copc',
  'km', 'km/h', 'm', 'mi', 'ft', 'mph', 'h', 'min', 's', 'w', 'kg', 'kj', 'kcal', 'bpm', 'rpm', 'hpa', 'mm', 'cm',
  '°c', '°f', '%', 'd+', 'd-', 'w/kg', 'm/s', 'ms', 'px', 'ok', 'id', 'url', 'api', 'ign', 'osm', 'srtm', 'dem', 'mnt',
  'lidar', 'brouter', 'mapbox', 'strava', 'komoot', 'garmin', 'wahoo', 'openstreetmap', 'appwrite', 'stripe',
  'swisstopo', 'swissalti3d', 'arome', 'arpege', 'icon', 'gfs', 'ecmwf', 'open-meteo', 'meteoblue', 'windy',
  'ucap', 'cp', 'ftp', 'vam', 'np', 'if', 'tss', 'ctl', 'atl', 'tsb', 'hr', 'fc', 'gt20', 'utc', 'gmt', 'beta',
  'x', 'y', 'z', 'n', 'e', 'o', 'w', 'ne', 'nw', 'se', 'sw', 'no', 'so', 'ns', 'eo', 'v', 'vs', 'max', 'moy', 'avg',
  'pro', 'demo', 'mtb', 'vtt', 'gravel', 'route', 'trail', 'email', 'ultra', 'bikepacking', 'google', 'apple',
  'github', 'discord', 'instagram', 'facebook', 'youtube', 'chrome', 'firefox', 'safari', 'webgl', 'wasm', 'gps',
  'esc', 'enter', 'shift', 'ctrl', 'alt', 'cmd', 'tab', 'space', 'suppr', 'del', 'swiss', 'norway',
  'poi', 'fps', 'err', 'local', 'normal', 'auto', 'sec', 'mp', 'lon', 'lat', 'pts', 'voxel',
  'hillshade', 'zoom', 'info', 'stop', 'start', 'sport', 'description', 'surface', 'type', 'total', 'distance',
]);

/** Chaînes identiques dans les deux langues (unités, sigles, nombres, marques). */
export function isNeutral(text) {
  if (!/[A-Za-zÀ-ÿ]{2,}/.test(text)) return true; // pas de vrai mot
  const words = text
    .toLowerCase()
    .split(/[\s·•|,;:()[\]{}<>/=+×→←↑↓–—\-!?…."'«»]+/)
    .filter(Boolean)
    .filter((w) => /[a-zà-ÿ]/.test(w));
  if (words.length === 0) return true;
  return words.every((w) => NEUTRAL_WORDS.has(w) || /^\d/.test(w) || /^[a-z]$/.test(w));
}

/** Ressemble à un identifiant, une classe CSS, un chemin, une URL, une clé… plutôt qu'à de la prose. */
function looksTechnical(text) {
  if (/^https?:\/\//.test(text) || /^\/[\w\-/.]*$/.test(text) || /^[.#]?[\w-]+\.(svg|png|jpg|webp|css|js|ts)$/.test(text)) return true;
  if (/^[a-z0-9]+([_\-.:/]+[a-z0-9]+)+$/i.test(text) && !/\s/.test(text)) return true; // identifiants kebab / snake / pointés / BEM
  if (/^[\s.]*[a-z0-9]+(\.[a-z0-9]+)+$/i.test(text) && !/\s\w/.test(text.trim())) return true; // suffixes de fichier « .json.gz »
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(text)) return true; // camelCase
  if (/^[A-Z0-9_]{2,}$/.test(text) && text.includes('_')) return true; // CONST_CASE
  if (/^(rgba?|hsla?|var|calc|url|translate|scale|rotate|linear-gradient)\(/.test(text)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return true;
  if (/^[\d.\s%a-z-]+$/.test(text) && /\d/.test(text) && !/\s[a-z]{3,}/i.test(text)) return true; // valeurs CSS « 4px 2px »
  if (/[{};]\s*$/.test(text) && /:/.test(text)) return true; // blocs CSS
  if (!/\s/.test(text) && /^[a-z][a-z0-9]*$/.test(text)) return true; // un seul mot en minuscules : presque toujours une clé
  return false;
}

const UI_ATTRIBUTES = /^(aria-label|aria-description|aria-valuetext|placeholder|title|alt|label|.*Label|.*Title|description|.*Description|tooltip|.*Tooltip|hint|.*Hint|subtitle|helperText|message|.*Message|caption|heading|emptyText|emptyState|confirmText|cancelText|text|.*Text)$/;
const UI_PROPERTIES = /^(label|.*Label|title|.*Title|description|.*Description|tooltip|.*Tooltip|hint|.*Hint|subtitle|message|.*Message|placeholder|caption|heading|helper|helperText|summary|detail|details|unitLabel|text|.*Text|warning|error|errorMessage|explanation|legend|badge|cta|content)$/;
const NON_UI_ATTRIBUTES = /^(className|class|style|id|key|href|src|type|name|role|value|htmlFor|data-.*|ref|target|rel|method|action|accept|autoComplete|inputMode|d|viewBox|fill|stroke|transform|xmlns|path|icon|color|variant|size|as|tone|mode|testId)$/;
const HTML_CLOSING_TAG = /<\/(div|span|p|button|label|h[1-6]|li|ul|ol|strong|em|a|small|option|section|header|footer|b|i|td|th|tr|table|dt|dd|summary|details)>/;
const DOM_TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel', 'alt']);
const LABEL_FUNCTION = /(label|title|text|message|caption|description|tooltip|hint|summary|name|wording|phrase)/i;
const UI_CALLS = new Set(['t', 'translateAppText', 'showToast', 'notify', 'confirm', 'alert', 'tr', 'translate']);

// --- paires de traduction -------------------------------------------------

export function readPairs(translationsDir) {
  const pairs = [];
  for (const name of readdirSync(translationsDir)) {
    if (!name.endsWith('.ts') || name === 'index.ts') continue;
    const file = join(translationsDir, name);
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        let fr = null;
        let en = null;
        for (const prop of node.properties) {
          if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
          const key = prop.name.getText(sf);
          const init = prop.initializer;
          const value = ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : null;
          if (key === 'fr') fr = value;
          if (key === 'en') en = value;
        }
        if (fr != null && en != null) pairs.push({ fr, en, file: name });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return pairs;
}

// --- extraction -------------------------------------------------------------

let found = new Map(); // texte canonique -> { text, kind, locations: [] }
let dynamic = []; // gabarits littéraux en position UI
let root = '.';

function record(text, kind, sf, node) {
  const canonical = canonicalize(text);
  if (!canonical || canonical.length < 2) return;
  if (looksTechnical(canonical) || TECHNICAL_STRINGS.has(canonical)) return;
  if (!/[A-Za-zÀ-ÿ]/.test(canonical)) return;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const loc = `${relative(root, sf.fileName).replace(/\\/g, '/')}:${line + 1}`;
  const entry = found.get(canonical);
  if (entry) {
    entry.locations.push(loc);
  } else {
    found.set(canonical, { text: canonical, kind, locations: [loc] });
  }
}

function recordDynamic(node, sf, kind) {
  if (/^---context:/m.test(node.head.text) || /brf-template/.test(sf.fileName)) return; // source de profil BRouter, pas de l'UI
  if (TECHNICAL_TEMPLATE_PREFIXES.some((prefix) => node.head.text.startsWith(prefix))) return;
  const staticText = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  if (!/[A-Za-zÀ-ÿ]{3,}/.test(staticText) || isNeutral(canonicalize(staticText))) return;
  if (looksTechnical(canonicalize(staticText))) return;
  if (/^[\s\w-]*$/.test(staticText) && !/\s[a-zA-Z]{3,}\s/.test(` ${staticText} `)) return;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  dynamic.push({
    text: node.getText(sf).slice(0, 160),
    kind,
    location: `${relative(root, sf.fileName).replace(/\\/g, '/')}:${line + 1}`,
  });
}

/** Collecte les littéraux de chaîne atteignables comme « valeurs » d'une expression (ternaires, ||, ??, parenthèses). */
function collectValueStrings(expr, sf, kind) {
  if (!expr) return;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    record(expr.text, kind, sf, expr);
  } else if (ts.isTemplateExpression(expr)) {
    recordDynamic(expr, sf, kind);
  } else if (ts.isConditionalExpression(expr)) {
    collectValueStrings(expr.whenTrue, sf, kind);
    collectValueStrings(expr.whenFalse, sf, kind);
  } else if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(expr.operatorToken.kind)) {
    if (expr.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) collectValueStrings(expr.left, sf, kind);
    collectValueStrings(expr.right, sf, kind);
  } else if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression?.(expr)) {
    collectValueStrings(expr.expression, sf, kind);
  }
}

/** Nœuds texte et attributs traduisibles dans une chaîne / un gabarit HTML (gabarits innerHTML). */
function recordHtml(node, sf) {
  const raw = ts.isTemplateExpression(node)
    ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
    : node.text;
  const html = raw.replace(/<(script|style)[\s\S]*?<\/>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '');
  for (const match of html.matchAll(/>([^<>]+)</g)) {
    for (const part of match[1].split(' ')) record(part, 'html-text', sf, node);
  }
  for (const match of html.matchAll(/(title|aria-label|placeholder|alt)="([^" ]+)"/g)) {
    record(match[2], 'html-attr', sf, node);
  }
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function isInsideNoTranslate(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isJsxElement(p)) {
      const attrs = p.openingElement.attributes.properties;
      if (attrs.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === 'data-rv-no-translate')) return true;
    }
  }
  return false;
}

/** Instructions return dans les fonctions nommées comme des formateurs de libellé / texte. */
function isLabelFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) {
      return Boolean(p.name && LABEL_FUNCTION.test(p.name.getText()));
    }
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const holder = p.parent;
      if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return LABEL_FUNCTION.test(holder.name.text);
      if (holder && ts.isPropertyAssignment(holder) && holder.name) return LABEL_FUNCTION.test(holder.name.getText());
      return false;
    }
  }
  return false;
}

function extract(file) {
  const content = readFileSync(file, 'utf-8');
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const visit = (node) => {
    if ((ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) && HTML_CLOSING_TAG.test(node.getText(sf))) {
      recordHtml(node, sf);
    }
    if (ts.isJsxText(node)) {
      if (!isInsideNoTranslate(node, sf)) record(node.text, 'jsx-text', sf, node);
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      if (!isInsideNoTranslate(node, sf)) collectValueStrings(node.expression, sf, 'jsx-expr');
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (!NON_UI_ATTRIBUTES.test(name) && UI_ATTRIBUTES.test(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) record(node.initializer.text, 'jsx-attr', sf, node.initializer);
        else if (ts.isJsxExpression(node.initializer)) collectValueStrings(node.initializer.expression, sf, 'jsx-attr');
      }
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && UI_CALLS.has(name) && node.arguments.length > 0) {
        collectValueStrings(node.arguments[0], sf, `call:${name}`);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && DOM_TEXT_PROPERTIES.has(node.left.name.text)) {
      collectValueStrings(node.right, sf, `dom:${node.left.name.text}`);
    } else if (ts.isCallExpression(node) && calleeName(node) === 'setAttribute' && node.arguments.length === 2
      && ts.isStringLiteral(node.arguments[0]) && ['title', 'aria-label', 'placeholder', 'alt'].includes(node.arguments[0].text)) {
      collectValueStrings(node.arguments[1], sf, `dom:${node.arguments[0].text}`);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && UI_PROPERTIES.test(node.name.text)) {
      collectValueStrings(node.initializer, sf, `var:${node.name.text}`);
    } else if (ts.isReturnStatement(node) && node.expression && isLabelFunction(node)) {
      collectValueStrings(node.expression, sf, 'return');
    } else if (ts.isPropertyAssignment(node) && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const key = node.name.text;
      if (UI_PROPERTIES.test(key) && key !== 'fr' && key !== 'en') {
        collectValueStrings(node.initializer, sf, `prop:${key}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Chaînes d'interface des fichiers donnés (chemins absolus), emplacements
 * relatifs à `rootDir`.
 */
export function extractUiStrings(files, rootDir) {
  found = new Map();
  dynamic = [];
  root = rootDir;
  for (const file of files) extract(file);
  return { found, dynamic };
}
