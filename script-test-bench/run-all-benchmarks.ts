/**
 * RedView Test-Bench : Master Orchestrator (CLI Runner)
 * 
 * Exécute l'ensemble des suites de test-bench ou une suite ciblée,
 * génère le rapport exécutif Markdown et le rapport JSON structuré.
 * 
 * Usage :
 *   npx tsx script-test-bench/run-all-benchmarks.ts
 *   npx tsx script-test-bench/run-all-benchmarks.ts --quick
 *   npx tsx script-test-bench/run-all-benchmarks.ts --feature=meteo
 *   npx tsx script-test-bench/run-all-benchmarks.ts --feature=lidar
 *   … --allow-regressions   (code de sortie 0 malgré des dépassements de seuil)
 *
 * L'environnement (CPU, alimentation, commit) est enregistré avec le rapport,
 * le run est comparé au rapport précédent du même mode, et le code de sortie
 * vaut 1 si une suite plante ou si un seuil reste dépassé après la seconde
 * mesure (voir core/harness.ts).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareWithReport, findPreviousReport, printComparison } from './core/compare.ts';
import { captureBenchEnvironment, describeEnvironment } from './core/environment.ts';
import type { BenchmarkSuite } from './core/harness.ts';
import {
  printSuiteHeader,
  printSuiteResults,
  generateMarkdownReport,
  saveJsonReport,
} from './core/reporter.ts';

// Feature suites
import { runMeteoBenchmark } from './bench-meteo.ts';
import { runSlopeBenchmark } from './bench-pente.ts';
import { runAltiBenchmark } from './bench-alti.ts';
import { runSnowBenchmark } from './bench-neige.ts';
import { runBrouterBenchmark } from './bench-brouter.ts';
import { runFitPredictorBenchmark } from './bench-fit-predictor.ts';
import { runLidarBenchmark } from './bench-lidar.ts';
import { runPoiBenchmark } from './bench-poi.ts';
import { runExporterBenchmark } from './bench-exporter.ts';
import { runCenterPanelBenchmark } from './bench-center-panel.ts';
import { runServerApiBenchmark } from './bench-server-api.ts';
import { runFlyoverBenchmark } from './bench-flyover.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORTS_DIR = path.resolve(__dirname, 'reports');

interface CliOptions {
  quick: boolean;
  feature?: string;
  noReport: boolean;
  allowRegressions: boolean;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    quick: false,
    noReport: false,
    allowRegressions: false,
  };

  for (const arg of args) {
    if (arg === '--quick' || arg === '-q') {
      options.quick = true;
    } else if (arg === '--no-report') {
      options.noReport = true;
    } else if (arg === '--allow-regressions') {
      options.allowRegressions = true;
    } else if (arg.startsWith('--feature=')) {
      options.feature = arg.split('=')[1]?.toLowerCase().trim();
    }
  }

  return options;
}

interface FeatureRunner {
  id: string;
  name: string;
  run: (options: { quick?: boolean }) => Promise<BenchmarkSuite>;
}

const REGISTRY: FeatureRunner[] = [
  { id: 'meteo', name: 'Météorologie & Radar', run: runMeteoBenchmark },
  { id: 'pente', name: 'Pente & Horn 3x3', run: runSlopeBenchmark },
  { id: 'alti', name: 'Altitude & Profils Dénivelé', run: runAltiBenchmark },
  { id: 'neige', name: 'Neige & Nivologie Universitaire', run: runSnowBenchmark },
  { id: 'brouter', name: 'BRouter & Routage Dynamique', run: runBrouterBenchmark },
  { id: 'fit', name: 'FIT Predictor & Simulation Physique', run: runFitPredictorBenchmark },
  { id: 'lidar', name: 'LiDAR — préparation d’une tuile', run: runLidarBenchmark },
  { id: 'poi', name: 'POI & Corridor Overpass OSM', run: runPoiBenchmark },
  { id: 'exporter', name: 'Exporter (GPX, GeoJSON, XML)', run: runExporterBenchmark },
  { id: 'chart', name: 'Center Panel & Graphiques Multi-Axes', run: runCenterPanelBenchmark },
  { id: 'server', name: 'Serveur Node & Infrastructure API', run: runServerApiBenchmark },
  { id: 'flyover', name: 'Flyover 3D (rail caméra & transport)', run: runFlyoverBenchmark },
];

async function main(): Promise<void> {
  const options = parseCliArgs();
  const startTime = Date.now();

  console.log('\n\x1b[1m\x1b[36m╔════════════════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[1m\x1b[36m║           REDVIEW APP — SUITE DE BENCHMARKS & NON-RÉGRESSION DEVOPS        ║\x1b[0m');
  console.log('\x1b[1m\x1b[36m╚════════════════════════════════════════════════════════════════════════════╝\x1b[0m');
  console.log(`\x1b[90mMode: ${options.quick ? 'RAPIDE (--quick)' : 'COMPLET (Production)'} | Cible: ${options.feature || 'TOUTES LES FONCTIONNALITÉS'}\x1b[0m`);
  const environment = captureBenchEnvironment();
  console.log(`\x1b[90mMachine: ${describeEnvironment(environment)}\x1b[0m`);
  if (environment.power === 'battery') {
    console.log('\x1b[33m⚠ Sur batterie : CPU bridé, durées 1,5 à 100× plus longues et instables — ne comparer qu’à un run sur batterie, ou brancher le secteur.\x1b[0m');
  }
  console.log('');

  const runnersToExecute = options.feature
    ? REGISTRY.filter((r) => r.id === options.feature || r.id.includes(options.feature!))
    : REGISTRY;

  if (runnersToExecute.length === 0) {
    console.error(`\x1b[31mErreur: Fonctionnalité inconnue "${options.feature}". Choix possibles: ${REGISTRY.map((r) => r.id).join(', ')}\x1b[0m`);
    process.exit(1);
  }

  const executedSuites: BenchmarkSuite[] = [];
  const crashedSuites: string[] = [];

  for (const runner of runnersToExecute) {
    try {
      const suite = await runner.run({ quick: options.quick });
      printSuiteHeader(suite.title);
      printSuiteResults(suite);
      executedSuites.push(suite);
    } catch (err) {
      crashedSuites.push(runner.name);
      console.error(`\x1b[31m[ÉCHEC] Erreur lors de l'exécution du test-bench ${runner.name}:\x1b[0m`, err);
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

  // Scorecard Global
  let totalMetrics = 0;
  let passCount = 0;
  let warnCount = 0;
  let regressionCount = 0;

  for (const s of executedSuites) {
    for (const r of s.results) {
      totalMetrics++;
      if (r.status === 'PASS') passCount++;
      else if (r.status === 'WARN') warnCount++;
      else if (r.status === 'REGRESSION') regressionCount++;
    }
  }

  console.log('\x1b[1m\x1b[36m═'.repeat(78) + '\x1b[0m');
  console.log('\x1b[1m  BILAN EXÉCUTIF DEVOPS\x1b[0m');
  console.log('\x1b[1m\x1b[36m═'.repeat(78) + '\x1b[0m');
  console.log(`  • Suites fonctionnelles exécutées : \x1b[1m${executedSuites.length} / ${REGISTRY.length}\x1b[0m`);
  console.log(`  • Métriques & Opérations testées : \x1b[1m${totalMetrics}\x1b[0m`);
  console.log(`  • Conformes (PASS)               : \x1b[32m\x1b[1m${passCount}\x1b[0m`);
  console.log(`  • Alertes Latence/Jitter (WARN)  : \x1b[33m\x1b[1m${warnCount}\x1b[0m`);
  console.log(`  • Dépassements Seuil (REGRESSION): \x1b[31m\x1b[1m${regressionCount}\x1b[0m`);
  console.log(`  • Durée totale d'exécution       : \x1b[1m${elapsedSec}s\x1b[0m`);
  console.log('\x1b[1m\x1b[36m═'.repeat(78) + '\x1b[0m\n');

  const mode = options.quick ? 'quick' : 'full';
  const feature = options.feature ?? null;
  const previous = findPreviousReport(REPORTS_DIR, mode, feature);
  if (previous) printComparison(previous.file, previous.report, environment, compareWithReport(previous.report, executedSuites));

  if (!options.noReport && executedSuites.length > 0) {
    const mdPath = generateMarkdownReport(executedSuites, REPORTS_DIR, environment);
    const jsonPath = saveJsonReport(executedSuites, REPORTS_DIR, 'benchmarks', { mode, feature, environment });
    console.log(`\x1b[32m✔ Rapport Markdown généré : \x1b[0m${mdPath}`);
    console.log(`\x1b[32m✔ Export JSON généré      : \x1b[0m${jsonPath}\n`);
  }

  const failures = [
    ...crashedSuites.map((name) => `suite en échec : ${name}`),
    ...executedSuites.flatMap((suite) => suite.results
      .filter((r) => r.status === 'REGRESSION' || r.status === 'FAIL')
      .map((r) => `${suite.title} · ${r.name} — ${r.warningMessage ?? r.status}`)),
  ];
  if (failures.length > 0) {
    console.log(`\x1b[31m\x1b[1m${failures.length} problème(s)${options.allowRegressions && crashedSuites.length === 0 ? ' (tolérés : --allow-regressions)' : ''} :\x1b[0m`);
    for (const failure of failures) console.log(`  \x1b[31m• ${failure}\x1b[0m`);
    if (crashedSuites.length > 0 || !options.allowRegressions) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\x1b[31mErreur fatale de l\'orchestrateur:\x1b[0m', err);
  process.exit(1);
});
