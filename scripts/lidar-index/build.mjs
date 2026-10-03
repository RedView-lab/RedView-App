#!/usr/bin/env node
// Régénère les index LiDAR Japon / Nouvelle-Zélande / Pays-Bas / Flandre et
// les polygones de couverture (overlay vert du mode téléchargement) de ces
// pays, de la France et de la Suisse.
//
//   npm run lidar:index                 # tout, listings en cache (scripts/lidar-index/.cache)
//   npm run lidar:index -- --refresh    # re-crawle les sources (NZ : ~1 h)
//   npm run lidar:index -- --only=jp    # ou nz, nl, be, fr, ch (liste séparée par des virgules)
//
// Sorties (commitées) :
//   src/features/lidar/lib/japan/japanLazIndex.ts + japanCoverage.json
//   src/features/lidar/lib/nz/nzLazIndex.ts       + nzCoverage.json
//   src/features/lidar/lib/franceCoverage.json    (IGN LiDAR HD, WFS Géoplateforme)
//   src/features/lidar/lib/swiss/swissCoverage.json (swissSURFACE3D, STAC swisstopo)
//   src/features/lidar/lib/netherlands/ahnIndex.ts + ahnCoverage.json (AHN, GeoTiles)
//   src/features/lidar/lib/flanders/dhmvIndex.ts   + dhmvCoverage.json (DHMV II, WFS OpenLidar)
// Les index et la couverture viennent de la même liste de fichiers : une zone
// verte sur la carte a toujours au moins un fichier téléchargeable. La France
// est découpée par les couvertures suisse, néerlandaise et flamande (et la
// Flandre par les Pays-Bas) : le clic y sert la dalle du pays voisin
// (`wgs84ToTileCoord`, `fileTiles.ts`), et les overlays ne se superposent pas.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJapan } from './japan.mjs';
import { buildNz } from './nz.mjs';
import { buildFrance } from './france.mjs';
import { buildSwiss } from './swiss.mjs';
import { buildNetherlands } from './netherlands.mjs';
import { buildFlanders, DHMV_CELL_M } from './flanders.mjs';
import { subtractCoverage } from './raster.mjs';
import { roundLonLat } from './encode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Map(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const refresh = args.get('refresh') === 'true';
const only = args.has('only') ? new Set(args.get('only').split(',')) : null;
const wants = (key) => !only || only.has(key);

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

if (wants('jp')) {
  console.log('Japon…');
  const jp = await buildJapan({ refresh });
  console.table(jp.stats);
  const files = jp.stats.reduce((n, s) => n + s.files, 0);
  writeIndex('src/features/lidar/lib/japan/japanLazIndex.ts', 'JapanLidarDataset', './types', 'JAPAN_LIDAR_DATASETS', jp.datasets, [
    `${files} nuages de points denses (LAS zippé, LAZ, COPC ; toutes classes), ${jp.stats.length} jeux, crawl du ${today}.`,
  ]);
  writeCoverage('src/features/lidar/lib/japan/japanCoverage.json', jp.coverage);
}

if (wants('nz')) {
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

const SWISS_COVERAGE = 'src/features/lidar/lib/swiss/swissCoverage.json';
const NL_COVERAGE = 'src/features/lidar/lib/netherlands/ahnCoverage.json';
const BE_COVERAGE = 'src/features/lidar/lib/flanders/dhmvCoverage.json';

function readCoveragePolygons(rel) {
  const file = path.join(ROOT, rel);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).features[0].geometry.coordinates : [];
}

if (wants('ch')) {
  console.log('Suisse…');
  const ch = await buildSwiss({ refresh });
  console.table(ch.stats);
  console.log(`  ${ch.items} items swissSURFACE3D, ${ch.tiles} dalles de 1 km`);
  writeCoverage(SWISS_COVERAGE, ch.coverage);
}

if (wants('nl')) {
  console.log('Pays-Bas…');
  const nl = await buildNetherlands({ refresh });
  console.table(nl.stats);
  if (nl.unplaced.length) console.warn(`  feuilles sans position (ignorées) : ${nl.unplaced.join(' ')}`);
  const files = nl.stats.reduce((n, s) => n + s.files, 0);
  const lines = [
    HEADER,
    `// ${files} sous-dalles AHN de 1 × 1,25 km (LAZ colorisé, GeoTiles TU Delft), crawl du ${today}.`,
    "import type { AhnDataset } from './types';",
    '',
    '/** Feuille (5 car.) + colonne (2) + ligne (3) de son coin sud-ouest, en unités de feuille (5 km, 6,25 km). */',
    `export const AHN_SHEET_GRID = ${JSON.stringify(nl.sheetGrid)};`,
    '',
    'export const AHN_LIDAR_DATASETS: readonly AhnDataset[] = [',
  ];
  for (const { sheets, ...meta } of nl.datasets) {
    lines.push('  {', `    ${Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')},`, `    sheets: ${JSON.stringify(sheets)},`, '  },');
  }
  lines.push('];', '');
  fs.writeFileSync(path.join(ROOT, 'src/features/lidar/lib/netherlands/ahnIndex.ts'), lines.join('\n'));
  console.log('→ src/features/lidar/lib/netherlands/ahnIndex.ts');
  writeCoverage(NL_COVERAGE, nl.coverage);
}

if (wants('be')) {
  console.log('Flandre…');
  const be = await buildFlanders({ refresh });
  console.table(be.stats);
  const lines = [
    HEADER,
    `// ${be.stats[0].cells} cellules DHMV II de ${DHMV_CELL_M} m couvertes (${be.stats[0].strips} morceaux de bandes, WFS EODaS OpenLidar), crawl du ${today}.`,
    "import type { DhmvCellGrid } from './types';",
    '',
    `export const DHMV_CELL_M = ${DHMV_CELL_M};`,
    '',
    `export const DHMV_CELL_GRID: DhmvCellGrid = ${JSON.stringify(be.grid)};`,
    '',
  ];
  fs.writeFileSync(path.join(ROOT, 'src/features/lidar/lib/flanders/dhmvIndex.ts'), lines.join('\n'));
  console.log('→ src/features/lidar/lib/flanders/dhmvIndex.ts');
  // Les Pays-Bas sont prioritaires le long de la frontière (`fileTiles.ts`).
  const feature = be.coverage.features[0];
  feature.geometry.coordinates = subtractCoverage(feature.geometry.coordinates, readCoveragePolygons(NL_COVERAGE), roundLonLat);
  writeCoverage(BE_COVERAGE, be.coverage);
}

if (wants('fr')) {
  console.log('France…');
  const fr = await buildFrance({ refresh });
  console.table(fr.stats);
  console.log(`  ${fr.tiles} dalles LiDAR HD publiées`);
  const neighbours = [SWISS_COVERAGE, NL_COVERAGE, BE_COVERAGE].map(readCoveragePolygons);
  for (const feature of fr.coverage.features) {
    if (feature.properties.crs !== 'LAMB93') continue;
    for (const clip of neighbours) feature.geometry.coordinates = subtractCoverage(feature.geometry.coordinates, clip, roundLonLat);
  }
  writeCoverage('src/features/lidar/lib/franceCoverage.json', fr.coverage);
}
