/**
 * Audit i18n : extrait les chaînes visibles par l'utilisateur dans src/ (texte
 * JSX, attributs JSX traduisibles, arguments de t()/translateAppText(),
 * propriétés d'objet d'allure UI, messages de toast / confirmation) et les
 * vérifie une à une contre les paires { fr, en } de
 * src/shared/i18n/config/translations/*.ts.
 *
 * Lancement : node scripts/quality/i18n-audit.mjs [--json out.json] [--list] [--strict]
 *   --json <file>  écrit les chaînes manquantes (avec leur emplacement) en JSON
 *   --list         affiche chaque chaîne manquante avec son premier emplacement
 *   --strict       sort en 1 sur toute chaîne manquante, paire en conflit ou
 *                  gabarit dynamique (porte qualité : npm run i18n:check, dans check)
 *
 * Les tests, le simulateur de co-édition et les fichiers de NOT_UI_FILES ne
 * sont pas analysés ; TECHNICAL_STRINGS liste les quelques chaînes en position
 * d'allure UI qui n'atteignent jamais l'écran (chacune avec sa raison).
 *
 * Couverture = traduites / (traduites + manquantes) sur les chaînes uniques.
 * Les chaînes neutres en langue (unités, sigles, marques, nombres) sont
 * comptées à part et exclues du ratio. Les gabarits littéraux avec des mots
 * statiques en position UI sont signalés « dynamiques » (le traducteur du DOM
 * ne peut pas les reconnaître : il leur faut t('… {{var}} …', { var })).
 */
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { canonicalize, extractUiStrings, isNeutral, NOT_UI_FILES, readPairs, walkFiles } from './i18n-strings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');
const srcDir = join(root, 'src');
const translationsDir = join(srcDir, 'shared', 'i18n', 'config', 'translations');

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const listMissing = args.includes('--list');
const strict = args.includes('--strict');

const files = walkFiles(srcDir).filter((f) => !f.startsWith(translationsDir) && !NOT_UI_FILES.some((re) => re.test(f)));
const { found, dynamic } = extractUiStrings(files, root);

const pairs = readPairs(translationsDir);
const known = new Set();
for (const p of pairs) {
  known.add(canonicalize(p.fr));
  known.add(canonicalize(p.en));
}

let translated = 0;
let neutral = 0;
const missing = [];
for (const entry of found.values()) {
  if (known.has(entry.text)) translated += 1;
  else if (isNeutral(entry.text)) neutral += 1;
  else missing.push(entry);
}

missing.sort((a, b) => a.locations[0].localeCompare(b.locations[0]));
const total = translated + missing.length;
const coverage = total === 0 ? 100 : (translated / total) * 100;

// Hygiène des paires : une clé (d'un côté ou de l'autre) associée à deux
// traductions différentes. Dans une même langue la dernière paire l'emporte,
// donc l'une des deux est perdue sans bruit.
const conflicts = [];
for (const side of ['fr', 'en']) {
  const other = side === 'fr' ? 'en' : 'fr';
  const seen = new Map();
  for (const p of pairs) {
    const k = canonicalize(p[side]);
    const prev = seen.get(k);
    if (prev && canonicalize(prev[other]) !== canonicalize(p[other]) && p.fr !== p.en && prev.fr !== prev.en) {
      conflicts.push(`${side} "${k}": "${prev[other]}" (${prev.file}) vs "${p[other]}" (${p.file})`);
    }
    seen.set(k, p);
  }
}
const duplicates = conflicts.length;

if (listMissing) {
  console.log('--- conflicting pairs ---');
  for (const c of conflicts) console.log(c);
  for (const m of missing) console.log(`${m.locations[0]}\t[${m.kind}]\t${m.text}`);
  console.log('\n--- dynamic (template literals) ---');
  for (const d of dynamic) console.log(`${d.location}\t[${d.kind}]\t${d.text}`);
}

console.log(`[i18n-audit] files scanned: ${files.length}`);
console.log(`[i18n-audit] translation pairs: ${pairs.length} (conflicting duplicates: ${duplicates})`);
console.log(`[i18n-audit] unique UI strings: ${found.size} — translated ${translated}, missing ${missing.length}, neutral ${neutral}`);
console.log(`[i18n-audit] dynamic template strings in UI positions: ${dynamic.length}`);
console.log(`[i18n-audit] coverage: ${coverage.toFixed(1)}%`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ coverage, translated, neutral, missing, dynamic }, null, 2), 'utf-8');
  console.log(`[i18n-audit] wrote ${jsonOut}`);
}

if (strict && (missing.length > 0 || duplicates > 0 || dynamic.length > 0)) {
  console.error('[i18n-audit] --strict: every UI string needs a { fr, en } pair, no pair may conflict, and no template literal may sit in a UI position (use t(\'… {{var}} …\', { var })). Run with --list for the details.');
  process.exit(1);
}
