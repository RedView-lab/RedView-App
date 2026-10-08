/**
 * SBOM (CycloneDX 1.5) et inventaire des licences de ce que RedView livre.
 *
 *   npm run sbom            (après `npm run build` : lit dist-meta/bundle-report.json)
 *   npm run sbom -- --check (ne réécrit rien ; échoue si les fichiers ne sont plus à jour)
 *
 * Deux ensembles, chacun son SBOM dans docs/operations/sbom/ :
 *   - serveur : les paquets que `npm ci --omit=dev` installe dans les images
 *     (Dockerfile, Dockerfile.multiplayer), lus dans package-lock.json — pas
 *     dans `npm sbom`, qui oublie `ws` (override `"ws": "$ws"`) ;
 *   - navigateur : les paquets réellement inclus dans le build Vite (modules
 *     node_modules/ du rapport de bundle), la plupart en devDependencies.
 * Version et licence viennent du lockfile : même résultat sur toute machine
 * (pas d'horodatage ni de numéro de série dans les SBOM).
 *
 * Écrit aussi docs/operations/licences.md. Échoue sur une licence copyleft
 * forte, absente ou inconnue qui n'est pas dans REVIEWED (exception revue à
 * la main, avec sa raison) : une nouvelle dépendance de ce genre se décide,
 * elle ne passe pas en silence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK = path.join(ROOT, 'package-lock.json');
const REPORT = path.join(ROOT, 'dist-meta/bundle-report.json');
const OUT_DIR = path.join(ROOT, 'docs/operations/sbom');
const LICENCES_MD = path.join(ROOT, 'docs/operations/licences.md');
const CHECK = process.argv.includes('--check');

/** Licences permissives : rien à faire au-delà de garder les mentions. */
const PERMISSIVE = new Set([
  '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'CC-BY-4.0',
  'ISC', 'MIT', 'MIT-0', 'Python-2.0', 'Unicode-3.0', 'Unlicense', 'Zlib',
]);
/** Copyleft faible : compatible avec un usage non modifié, à vérifier si on modifie le paquet. */
const WEAK_COPYLEFT = /^(LGPL|MPL|EPL|CDDL)-/;

/** Licences non permissives revues à la main : paquet → raison (affichée dans licences.md). */
const REVIEWED = {
  'mapbox-gl': 'Conditions Mapbox (propriétaire, v2+) : usage permis avec un compte Mapbox actif, '
    + 'pour les produits Mapbox du compte. Le jeton VITE_MAPBOX_TOKEN est celui de ce compte.',
  '@garmin/fitsdk': 'Licence du protocole FIT de Garmin (non exclusive, gratuite) : lecture/écriture '
    + 'de fichiers FIT. Garder le fichier LICENSE.txt du paquet ; ne pas redistribuer le SDK seul.',
  mediabunny: 'MPL-2.0 (copyleft faible, au fichier) : utilisé sans modification ; une modification '
    + 'de ses fichiers devrait être publiée sous MPL-2.0.',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** `node_modules/a/node_modules/@b/c` → `@b/c`. */
function nameFromLockKey(key) {
  const rest = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length).split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** Clé du lockfile du paquet qui contient un module (`…/node_modules/x/lib/y.js`). */
function lockKeyFromModule(id) {
  const parts = id.split('/');
  let end = -1;
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] !== 'node_modules') continue;
    end = parts[i + 1]?.startsWith('@') ? i + 2 : i + 1;
  }
  return end < 0 ? null : parts.slice(parts.indexOf('node_modules'), end + 1).join('/');
}

function classify(name, licence) {
  if (REVIEWED[name]) return 'revue';
  if (!licence) return 'inconnue';
  const ids = licence.replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+|\s+/).filter(Boolean);
  if (ids.length > 0 && ids.every((id) => PERMISSIVE.has(id))) return 'permissive';
  // Une alternative permissive suffit (« MIT OR GPL-2.0 »).
  if (/\bOR\b/.test(licence) && ids.some((id) => PERMISSIVE.has(id)) && !/\bAND\b/.test(licence)) return 'permissive';
  if (ids.every((id) => PERMISSIVE.has(id) || WEAK_COPYLEFT.test(id))) return 'copyleft faible';
  if (ids.some((id) => /GPL|EUPL|OSL|SSPL|CC-BY-SA/.test(id))) return 'copyleft forte';
  return 'inconnue';
}

function component(key, entry) {
  const name = nameFromLockKey(key);
  const [group, bare] = name.startsWith('@') ? name.split('/') : [undefined, name];
  const purl = `pkg:npm/${group ? `${encodeURIComponent(group)}/` : ''}${bare}@${entry.version}`;
  const out = { type: 'library', 'bom-ref': purl };
  if (group) out.group = group;
  Object.assign(out, { name: bare, version: entry.version, purl });
  if (entry.license) {
    out.licenses = PERMISSIVE.has(entry.license) || WEAK_COPYLEFT.test(entry.license)
      ? [{ license: { id: entry.license } }]
      : /\b(OR|AND)\b/.test(entry.license) ? [{ expression: entry.license }] : [{ license: { name: entry.license } }];
  }
  const sri = /^sha512-(.+)$/.exec(entry.integrity ?? '');
  if (sri) out.hashes = [{ alg: 'SHA-512', content: Buffer.from(sri[1], 'base64').toString('hex') }];
  if (entry.resolved) out.externalReferences = [{ type: 'distribution', url: entry.resolved }];
  const platform = [entry.os && `os=${entry.os.join(',')}`, entry.cpu && `cpu=${entry.cpu.join(',')}`].filter(Boolean);
  if (platform.length) out.properties = [{ name: 'redview:plateforme', value: platform.join(' ') }];
  return out;
}

function bom(label, version, entries) {
  const components = entries.map(([key, entry]) => component(key, entry))
    .sort((a, b) => a.purl.localeCompare(b.purl));
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      tools: { components: [{ type: 'application', name: 'scripts/quality/sbom.mjs' }] },
      component: { type: 'application', 'bom-ref': `redview-${label}`, name: `redview-${label}`, version },
    },
    components,
  };
}

function serverEntries(lock) {
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && !entry.devOptional);
}

function browserEntries(lock) {
  if (!fs.existsSync(REPORT)) {
    console.error(`[sbom] ${path.relative(ROOT, REPORT)} absent : lancer \`npm run build\` d'abord.`);
    process.exit(1);
  }
  const keys = new Set();
  for (const chunk of readJson(REPORT).chunks) {
    for (const id of chunk.modules) {
      const key = lockKeyFromModule(id.replaceAll('\\', '/'));
      if (key) keys.add(key);
    }
  }
  const missing = [...keys].filter((key) => !lock.packages[key]);
  if (missing.length) {
    console.error(`[sbom] modules du bundle absents de package-lock.json : ${missing.join(', ')}`);
    process.exit(1);
  }
  return [...keys].map((key) => [key, lock.packages[key]]);
}

function licenceRows(entries) {
  const byName = new Map();
  for (const [key, entry] of entries) {
    const name = nameFromLockKey(key);
    const row = byName.get(name) ?? { name, versions: new Set(), licence: entry.license ?? '', platform: false };
    row.versions.add(entry.version);
    row.platform ||= Boolean(entry.os || entry.cpu);
    byName.set(name, row);
  }
  return [...byName.values()]
    .map((row) => ({ ...row, versions: [...row.versions].sort().join(', '), kind: classify(row.name, row.licence) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function table(rows) {
  const lines = ['| Paquet | Version | Licence | Statut |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    const platform = row.platform ? ' (binaire de plateforme)' : '';
    lines.push(`| \`${row.name}\`${platform} | ${row.versions} | ${row.licence || '—'} | ${row.kind} |`);
  }
  return lines.join('\n');
}

function summary(rows) {
  const counts = {};
  for (const row of rows) counts[row.licence || '—'] = (counts[row.licence || '—'] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([licence, n]) => `${licence} ${n}`).join(' · ');
}

function licencesMarkdown(server, browser) {
  const reviewed = [...new Set([...server, ...browser].filter((row) => row.kind === 'revue').map((row) => row.name))].sort();
  return `# Licences des dépendances livrées

> Fichier généré par \`npm run sbom\` (\`scripts/quality/sbom.mjs\`) : ne pas l'éditer à la main.
> SBOM CycloneDX 1.5 à côté : [\`sbom/server.cdx.json\`](sbom/server.cdx.json) et [\`sbom/browser.cdx.json\`](sbom/browser.cdx.json).

Deux ensembles livrés :

- **serveur** : paquets installés dans les images Docker (\`npm ci --omit=dev\`) — ${server.length} paquets (${summary(server)}) ;
- **navigateur** : paquets inclus dans le build Vite — ${browser.length} paquets (${summary(browser)}).

Le script échoue sur une licence copyleft forte (GPL, AGPL, EUPL, SSPL…), absente ou inconnue qui n'a pas été revue. Une exception revue s'ajoute dans \`REVIEWED\` du script, avec sa raison.

## Exceptions revues

${reviewed.map((name) => `- \`${name}\` : ${REVIEWED[name]}`).join('\n')}

## Hors de cet inventaire

- **Moteurs Rust/WASM** (\`vendor/redviewalgo\`, \`vendor/redviewlaz\`, compilés dans \`.wasm\`) : crates sous MIT, Apache-2.0, « MIT OR Apache-2.0 », « Unlicense OR MIT » et Unicode-3.0 (\`unicode-ident\`), relevé le 2026-10-08 sur leurs \`Cargo.lock\` ; dont \`laz\` (Apache-2.0), \`fitparser\` (MIT), \`quick-xml\` (MIT), \`wasm-bindgen\` (MIT OR Apache-2.0).
- **Police** Rethink Sans (\`@fontsource-variable/rethink-sans\`, fichiers de police servis par l'app) : SIL OFL 1.1.
- **Code copié dans \`public/\`** (Service Worker, \`laz-perf.wasm\`) : couvert par les paquets ci-dessus ou écrit pour RedView.
- **Images Docker** : \`node:22-alpine\` (Node.js MIT, Alpine et ses paquets sous licences diverses), non scanné ici.

## Serveur

${table(server)}

## Navigateur

${table(browser)}
`;
}

function main() {
  const lock = readJson(LOCK);
  const { version } = readJson(path.join(ROOT, 'package.json'));
  const server = serverEntries(lock);
  const browser = browserEntries(lock);
  const serverRows = licenceRows(server);
  const browserRows = licenceRows(browser);

  const files = new Map([
    [path.join(OUT_DIR, 'server.cdx.json'), `${JSON.stringify(bom('server', version, server), null, 2)}\n`],
    [path.join(OUT_DIR, 'browser.cdx.json'), `${JSON.stringify(bom('browser', version, browser), null, 2)}\n`],
    [LICENCES_MD, licencesMarkdown(serverRows, browserRows)],
  ]);

  let stale = 0;
  for (const [file, content] of files) {
    const rel = path.relative(ROOT, file).replaceAll('\\', '/');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (current === content) continue;
    if (CHECK) {
      console.error(`[sbom] ${rel} n'est plus à jour : lancer \`npm run sbom\`.`);
      stale += 1;
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      console.log(`[sbom] ${rel} écrit (${crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)})`);
    }
  }

  const blocking = [...serverRows, ...browserRows].filter((row) => row.kind === 'copyleft forte' || row.kind === 'inconnue');
  for (const row of blocking) console.error(`[sbom] licence ${row.kind} non revue : ${row.name} (${row.licence || 'absente'})`);
  console.log(`[sbom] serveur ${serverRows.length} paquets, navigateur ${browserRows.length} ; `
    + `${blocking.length} licence(s) à revoir.`);
  if (stale || blocking.length) process.exit(1);
}

main();
