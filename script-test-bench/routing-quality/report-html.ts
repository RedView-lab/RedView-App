/**
 * Page HTML autonome du routing-quality bench (avant / après) : synthèses,
 * répartitions revêtements / types de voies, superposition des tracés.
 *
 *   npx tsx script-test-bench/routing-quality/report-html.ts [--out <fichier.html>]
 *
 * Lit summary.json (écrit par compare.ts), sweep.json et les .geo.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'script-test-bench', 'reports', 'routing-quality');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}

const summary = JSON.parse(fs.readFileSync(path.join(DIR, 'summary.json'), 'utf8'));
const readGeo = (label: string): Record<string, [number, number][]> => {
  const file = path.join(DIR, `${label}.geo.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
};
const thin = (coords: [number, number][] | undefined, max = 90) => {
  if (!coords?.length) return null;
  if (coords.length <= max) return coords.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
  const step = (coords.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => coords[Math.round(i * step)]!).map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]);
};
const geoBefore = readGeo(summary.before.label);
const geoAfter = readGeo(summary.after.label);
const geo: Record<string, { b: unknown; a: unknown }> = {};
for (const row of summary.rows) geo[row.id] = { b: thin(geoBefore[row.id]), a: thin(geoAfter[row.id]) };
const sweepFile = path.join(DIR, 'sweep.json');
const sweep = fs.existsSync(sweepFile) ? Object.values(JSON.parse(fs.readFileSync(sweepFile, 'utf8'))) : [];
const notesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-notes.json');
const notes = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf8')) : { fixes: [], vps: [] };

const data = JSON.stringify({ summary, geo, sweep, notes }).replace(/</g, '\\u003c');
const template = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'report-template.html'), 'utf8');
const out = arg('out', path.join(DIR, 'routing-report.html'));
fs.writeFileSync(out, template.replace('/*__DATA__*/null', data));
console.log(`→ ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} Ko)`);
