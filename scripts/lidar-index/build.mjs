#!/usr/bin/env node
// Régénère les index LiDAR Japon / Nouvelle-Zélande et leurs polygones de couverture.
//
//   npm run lidar:index                 # JP + NZ, listings en cache (scripts/lidar-index/.cache)
//   npm run lidar:index -- --refresh    # re-crawle les buckets (NZ : ~1 h)
//   npm run lidar:index -- --only=jp    # ou --only=nz
//
// Sorties (commitées) :
//   src/features/lidar/lib/japan/japanLazIndex.ts + japanCoverage.json
//   src/features/lidar/lib/nz/nzLazIndex.ts       + nzCoverage.json
// Les index et la couverture viennent de la même liste de fichiers : une zone
// verte sur la carte a toujours au moins un fichier téléchargeable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJapan } from './japan.mjs';
import { buildNz } from './nz.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const refresh = args.get('refresh') === 'true';
const only = args.get('only');

const HEADER = '// Généré par `npm run lidar:index` (scripts/lidar-index/build.mjs) — ne pas éditer à la main.';

function writeIndex(rel, typeName, typeImport, constName, datasets, summary) {
  const lines = [
    HEADER,
    ...summary.map(s => `// ${s}`),
    `import type { ${typeName} } from '${typeImport}';`,
    '',
    `export const ${constName}: readonly ${typeName}[] = [`,
  ];
  for (const d of datasets) {
    const { sheets, tiles, ...meta } = d;
    const props = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
    lines.push(`  {\n    ${props},`);
    if (sheets !== undefined) lines.push(`    sheets: ${JSON.stringify(sheets)},`);
    if (tiles !== undefined) lines.push(`    tiles: ${JSON.stringify(tiles)},`);
    lines.push('  },');
  }
  lines.push('];', '');
  fs.writeFileSync(path.join(ROOT, rel), lines.join('\n'));
  console.log(`→ ${rel} (${(fs.statSync(path.join(ROOT, rel)).size / 1024).toFixed(0)} Kio)`);
}

function writeCoverage(rel, geojson) {
  fs.writeFileSync(path.join(ROOT, rel), JSON.stringify(geojson));
  let polygons = 0;
  let vertices = 0;
  for (const f of geojson.features) for (const p of f.geometry.coordinates) { polygons++; for (const r of p) vertices += r.length; }
  console.log(`→ ${rel} (${(fs.statSync(path.join(ROOT, rel)).size / 1024).toFixed(0)} Kio, ${polygons} polygones, ${vertices} sommets)`);
}

const today = new Date().toISOString().slice(0, 10);

if (only !== 'nz') {
  console.log('Japon…');
  const jp = await buildJapan({ refresh });
  console.table(jp.stats);
  const files = jp.stats.reduce((n, s) => n + s.files, 0);
  writeIndex('src/features/lidar/lib/japan/japanLazIndex.ts', 'JapanLidarDataset', './types', 'JAPAN_LIDAR_DATASETS', jp.datasets, [
    `${files} nuages de points denses (LAS zippé, LAZ, COPC ; toutes classes), ${jp.stats.length} jeux, crawl du ${today}.`,
  ]);
  writeCoverage('src/features/lidar/lib/japan/japanCoverage.json', jp.coverage);
}

if (only !== 'jp') {
  console.log('Nouvelle-Zélande…');
  const nz = await buildNz({ refresh });
  console.table(nz.stats.map(({ dir, files, year, density, bytesPerPoint, kept, reason, note }) => ({ dir, files, year, density, bytesPerPoint, kept, reason: reason || note })));
  const keptFiles = nz.stats.reduce((n, s) => n + s.kept, 0);
  const keptSets = nz.stats.filter(s => s.kept > 0).length;
  writeIndex('src/features/lidar/lib/nz/nzLazIndex.ts', 'NzLidarDataset', './types', 'NZ_LIDAR_DATASETS', nz.datasets, [
    `${keptFiles} nuages de points LAZ denses (LINZ via OpenTopography), ${keptSets} dossiers, crawl du ${today}.`,
  ]);
  writeCoverage('src/features/lidar/lib/nz/nzCoverage.json', nz.coverage);
}
