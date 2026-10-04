/**
 * Garde-fou du chargement initial (après `vite build`) : ce qu'un utilisateur
 * connecté télécharge avant de voir le gestionnaire de projets.
 *
 *   npm run bundle:check            (inclus dans npm run check:full)
 *
 * Chemin critique = entrée index.html + shell du Dashboard (src/pages/Dashboard)
 * et leurs imports statiques, JS et CSS. Échoue si :
 *   - l'éditeur 3D ou un moteur lourd (mapbox-gl, LiDAR, proj4) y figure : ils
 *     doivent rester derrière le chargement paresseux de l'éditeur ;
 *   - sa taille brotli dépasse le budget.
 *
 * Lit dist-meta/bundle-report.json (plugin redviewBundleReportPlugin de
 * vite.config.ts) et les fichiers de dist/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT = path.join(ROOT, 'dist-meta/bundle-report.json');
const DIST = path.join(ROOT, 'dist');
const DASHBOARD_SHELL = 'src/pages/Dashboard/index.tsx';

/**
 * Budget brotli du chemin critique (Kio). Mesuré à 271 Kio après le découpage
 * de l'éditeur (1 075 Kio avant), + ~10 % de marge. Le relever est une décision
 * explicite, pas un réflexe pour faire passer un ajout.
 */
const BUDGET_KIB = Number(process.env.REDVIEW_INITIAL_BUDGET_KIB ?? 300);

/** Modules qui ne doivent jamais être sur le chemin critique. */
const FORBIDDEN = [
  { label: 'éditeur 3D (DashboardEditor)', test: (id) => id === 'src/pages/Dashboard/components/DashboardEditor.tsx' },
  { label: 'mapbox-gl', test: (id) => id.includes('node_modules/mapbox-gl/') },
  { label: '@mapbox/mapbox-gl-draw', test: (id) => id.includes('node_modules/@mapbox/mapbox-gl-draw/') },
  { label: 'copc (LiDAR)', test: (id) => id.includes('node_modules/copc/') },
  { label: 'proj4', test: (id) => id.includes('node_modules/proj4/') },
];

function brotliKiB(files) {
  let bytes = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(DIST, file));
    bytes += zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }).length;
  }
  return bytes / 1024;
}

function main() {
  if (!fs.existsSync(REPORT)) {
    console.error(`[bundle] ${path.relative(ROOT, REPORT)} absent : lancer \`vite build\` d'abord.`);
    process.exit(1);
  }
  const { chunks } = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entry = chunks.find((chunk) => chunk.isEntry && chunk.modules.includes('src/main.tsx'));
  const shell = chunks.find((chunk) => chunk.facadeModuleId === DASHBOARD_SHELL);
  if (!entry || !shell) {
    console.error('[bundle] entrée index.html ou shell du Dashboard introuvable dans le rapport.');
    process.exit(1);
  }

  // Clôture des imports statiques.
  const critical = new Set();
  const visit = (fileName) => {
    if (critical.has(fileName)) return;
    critical.add(fileName);
    for (const imported of byFile.get(fileName)?.imports ?? []) visit(imported);
  };
  visit(entry.fileName);
  visit(shell.fileName);

  const criticalChunks = [...critical].map((fileName) => byFile.get(fileName)).filter(Boolean);
  const css = [...new Set(criticalChunks.flatMap((chunk) => chunk.importedCss))];
  const jsKiB = brotliKiB(critical);
  const cssKiB = brotliKiB(css);
  const totalKiB = jsKiB + cssKiB;

  const violations = [];
  for (const rule of FORBIDDEN) {
    const hit = criticalChunks.find((chunk) => chunk.modules.some(rule.test));
    if (hit) violations.push(`${rule.label} dans ${hit.fileName}`);
  }

  console.log(`[bundle] chemin critique : ${critical.size} chunk(s) JS, ${css.length} CSS`);
  for (const chunk of criticalChunks) console.log(`  ${chunk.fileName} (${chunk.modules.length} modules)`);
  console.log(`[bundle] brotli : JS ${jsKiB.toFixed(0)} Kio + CSS ${cssKiB.toFixed(0)} Kio = ${totalKiB.toFixed(0)} Kio (budget ${BUDGET_KIB} Kio)`);

  if (totalKiB > BUDGET_KIB) violations.push(`${totalKiB.toFixed(0)} Kio > budget ${BUDGET_KIB} Kio`);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`[bundle] ✖ ${violation}`);
    console.error("[bundle] Charger le module fautif derrière l'éditeur (import dynamique) ou importer un module plus précis qu'un barrel.");
    process.exit(1);
  }
  console.log('[bundle] ✔ conforme');
}

main();
