/**
 * Gate qualité, bloquant avant chaque déploiement (scripts/deploy.mjs) et en CI.
 *
 *   npm run check                  types, lint, tests unitaires, knip, cycles (en parallèle)
 *   npm run check:full             + build de prod + régressions de correction hors ligne
 *   node scripts/check.mjs --only=lint,test
 *
 * Chaque étape est un script npm (une seule définition des commandes). Les
 * sorties sont mises en tampon et seules celles des étapes en échec sont
 * affichées, à la fin. Code de sortie non nul au premier échec.
 *
 * Exclus volontairement : bench:quick (seuils de perf dépendant de la machine
 * et de son alimentation : il sort en échec sur un seuil, mais une batterie
 * suffit à en dépasser), bench:snow et bench:avalanche (≈ 2,5 min chacun ;
 * bench:snow réécrit son rapport versionné), benchs réseau (routing, POI).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const PACKAGE_SCRIPTS = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts ?? {};

/** Étapes indépendantes, lancées en parallèle. */
const FAST_STEPS = [
  { id: 'typecheck', script: 'typecheck', label: 'Types (tsc -b : app, vite, api)' },
  // Benchs typés à part (pas dans tsc -b : le build de prod et l'image Docker
  // n'en ont pas besoin) : une API de l'app qui change casse sinon un bench
  // en silence — il mesure un tableau vide ou un `null` sans échouer.
  { id: 'typecheck-bench', script: 'typecheck:bench', label: 'Types des benchs (script-test-bench)' },
  { id: 'lint', script: 'lint', label: 'ESLint (cliquet de suppressions)' },
  { id: 'test', script: 'test', label: 'Tests unitaires (Vitest)' },
  { id: 'knip', script: 'knip', label: 'Code et dépendances morts (knip)' },
  { id: 'cycles', script: 'cycles', label: "Cycles d'imports (madge)" },
];

/** Étapes lourdes de --full, en série, seulement si les rapides passent. */
const FULL_STEPS = [
  { id: 'build', script: 'build:vite', label: 'Build de prod (vite build)' },
  { id: 'server', script: 'server:check', label: 'Serveurs de prod bundlés (dist-server, statiques précompressés)' },
  { id: 'bundle', script: 'bundle:check', label: 'Chargement initial (budget, éditeur hors chemin critique)' },
  // Navigateur réel sur le build ci-dessus, faux backend : connexion, projet,
  // import et export GPX, cloud, autre appareil, export RGPD, suppression du compte.
  { id: 'journey', script: 'e2e:journey', label: 'E2E : parcours principal (build de prod, faux backend)' },
  { id: 'redview', script: 'bench:redview', label: 'Régression : fichier .redview' },
  { id: 'project-layers', script: 'bench:project-layers', label: 'Régression : couches du projet' },
  { id: 'collab', script: 'bench:collab', label: 'Régression : co-édition' },
  { id: 'flyover', script: 'bench:flyover', label: 'Régression : flyover' },
];

/** Dernières lignes affichées pour une étape en échec. */
const FAILURE_TAIL_LINES = 120;

const COLORS = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' };
const paint = (color, text) => (process.stdout.isTTY ? `${COLORS[color]}${text}${COLORS.reset}` : text);

function parseArgs(argv) {
  const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean) ?? null;
  return { full: argv.includes('--full'), only };
}

function runStep(step) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: process.stdout.isTTY ? '1' : '0' };
    // Sous Windows npm est un .cmd : passage par le shell, commande en une
    // chaîne (noms de scripts constants, rien à échapper).
    const child = process.platform === 'win32'
      ? spawn(`npm run --silent ${step.script}`, { shell: true, env })
      : spawn('npm', ['run', '--silent', step.script], { env });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => { output += `\n${error.message}`; });
    child.on('close', (code) => {
      const result = { ...step, ok: code === 0, code, output, seconds: (performance.now() - startedAt) / 1000 };
      printStepLine(result);
      resolve(result);
    });
  });
}

function printStepLine(result) {
  const mark = result.ok ? paint('green', '✔') : paint('red', '✖');
  console.log(`${mark} ${result.label} ${paint('dim', `(${result.seconds.toFixed(1)} s)`)}`);
}

/** Indications de correction pour les échecs les plus fréquents. */
function hintFor(result) {
  if (result.id === 'lint' && /suppressions left that do not occur anymore/.test(result.output)) {
    return 'Des erreurs figées ont été corrigées : `npm run lint:prune` met à jour eslint-suppressions.json.';
  }
  if (result.id === 'cycles') {
    return "Importer le module concret plutôt que le barrel (index.ts) qui ré-exporte l'importeur.";
  }
  if (result.id === 'knip') {
    return 'Supprimer le fichier ou la dépendance inutilisés, ou déclarer la dépendance utilisée (package.json).';
  }
  return null;
}

function printFailure(result) {
  const lines = result.output.trimEnd().split(/\r?\n/);
  const tail = lines.slice(-FAILURE_TAIL_LINES);
  console.log(`\n${paint('red', `── ${result.label} : échec (npm run ${result.script}) ──`)}`);
  if (lines.length > tail.length) console.log(paint('dim', `… ${lines.length - tail.length} lignes masquées`));
  console.log(tail.join('\n'));
  const hint = hintFor(result);
  if (hint) console.log(paint('yellow', `→ ${hint}`));
}

async function main() {
  const { full, only } = parseArgs(process.argv.slice(2));
  const select = (steps) => (only ? steps.filter((step) => only.includes(step.id)) : steps);
  const fastSteps = select(FAST_STEPS);
  const fullSteps = (full || only ? select(FULL_STEPS) : []).filter((step) => {
    if (step.script in PACKAGE_SCRIPTS) return true;
    // Bench renommé ou retiré : signalé, pas ignoré en silence.
    console.log(paint('yellow', `⚠ ${step.label} : script npm « ${step.script} » absent, étape non lancée`));
    return false;
  });
  const startedAt = performance.now();

  console.log(paint('cyan', `[check] ${[...fastSteps, ...fullSteps].map((step) => step.id).join(', ')}`));
  const results = await Promise.all(fastSteps.map(runStep));

  if (fullSteps.length > 0) {
    if (results.every((result) => result.ok)) {
      for (const step of fullSteps) {
        const result = await runStep(step);
        results.push(result);
        if (!result.ok) break;
      }
    } else {
      console.log(paint('yellow', `↷ ${fullSteps.map((step) => step.id).join(', ')} non lancés (échec plus haut)`));
    }
  }

  const failures = results.filter((result) => !result.ok);
  failures.forEach(printFailure);
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.log(`\n${paint('red', `[check] ${failures.length} étape(s) en échec`)} ${paint('dim', `(${seconds} s)`)}`);
    process.exit(1);
  }
  console.log(`\n${paint('green', '[check] tout est vert')} ${paint('dim', `(${seconds} s)`)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
