/**
 * RedView Test-Bench : FIT Predictor (moteur vélo v2, Rust/WASM)
 *
 * Mesure le VRAI moteur de l'app (src/features/fitPredictor/engine/pkg, celui
 * que le Web Worker charge), par la même API que le banc de précision
 * (script-test-bench/pace-accuracy, `npm run bench:pace`) :
 * 1. Prédiction d'un col de 14 km (grille ~10 m) et de 100 km vallonnés.
 * 2. Prédiction d'une étape ultra de 700 km (70 000 cellules).
 * 3. Calibration sur les sorties FIT réelles (Chamonix → Paris) quand elles
 *    sont présentes (PACE_FIT_DIR), sinon sautée.
 * Jusqu'au 2026-10-06 ce bench mesurait des copies de formules physiques
 * écrites dans le bench (densité de l'air, Newton-Raphson…), pas le moteur.
 * La justesse des temps est jugée par `npm run bench:pace`, pas ici.
 */
import fs from 'node:fs';
import { BenchmarkSuite } from '../core/harness.ts';
import { printSuiteHeader, printSuiteResults } from '../core/reporter.ts';
import { loadPkg, predictV2, silenceConsole, type V2Route } from '../pace-accuracy/lib/engine.ts';
import { straight } from '../pace-accuracy/lib/synthetic.ts';
import { FIT_DIR, loadRides } from '../pace-accuracy/lib/rides.ts';

const RIDER = { preset: { level: 'intermediaire', gender: 'female' } };

export async function runFitPredictorBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('FIT Predictor (Simulation Physique & Effort)');
  const iterations = options.quick ? 3 : 10;
  const glue = await loadPkg();
  const predict = (route: V2Route) => predictV2(glue, route, { geometry: 'planned', rider: RIDER });

  // Col de 14 km à 8 % (type Alpe d'Huez) et 100 km vallonnés.
  const col = straight(14_000, (d) => 700 + 0.08 * d, { step: 10 });
  const hilly = straight(100_000, (d) => 400 + 120 * Math.sin(d / 4000) + 30 * Math.sin(d / 700), { step: 10 });
  const ultra = straight(700_000, (d) => 400 + 120 * Math.sin(d / 4000) + 30 * Math.sin(d / 700), { step: 20 });

  const check = (label: string, totalS: number) => {
    if (!Number.isFinite(totalS) || totalS <= 0) throw new Error(`[bench-fit] ${label} : temps ${totalS}`);
  };
  check('col', predict(col).total_time_s);
  check('700 km', predict(ultra).total_time_s);

  suite.measureSync(
    {
      name: 'Moteur WASM : col 14 km à 8 %',
      category: 'fit-predict-climb',
      iterations: iterations * 2,
      regressionThresholdP95Ms: 20.0,
    },
    () => predict(col),
  );
  suite.measureSync(
    {
      name: 'Moteur WASM : 100 km vallonnés',
      category: 'fit-predict-100k',
      iterations,
      regressionThresholdP95Ms: 60.0,
    },
    () => predict(hilly),
  );
  suite.measureSync(
    {
      name: 'Moteur WASM : étape ultra 700 km',
      category: 'fit-predict-ultra',
      iterations: Math.max(3, iterations >> 1),
      regressionThresholdP95Ms: 250.0,
      itemsProcessedPerOp: 35_000,
    },
    () => predict(ultra),
  );

  if (fs.existsSync(FIT_DIR)) {
    const rides = loadRides();
    suite.measureSync(
      {
        name: `Calibration FIT réelles (${rides.length} sorties, LOO)`,
        category: 'fit-calibrate',
        iterations: options.quick ? 1 : 3,
        warmupIterations: 1,
        regressionThresholdP95Ms: 3000.0,
      },
      () => silenceConsole(() => glue.calibrate_cycling(rides.map((r) => r.bytes), { rider: { custom: { gender: 'female' } } }, () => {})),
    );
  } else {
    console.log(`[bench-fit] sorties FIT absentes (${FIT_DIR}) : calibration non mesurée`);
  }

  suite.addRegressionRisk(
    'Le moteur ne rend que le temps de déplacement : les pauses relèvent du planning (pauseAwareSchedule).',
  );
  suite.addRegressionRisk(
    'Changer les résultats du moteur impose de monter ENGINE_VERSION (Rust) et CYCLING_ENGINE_VERSION (TS) ensemble.',
  );
  suite.addRecommendation('Justesse : `npm run bench:pace` (FIT réels + scénarios physiques), échec sur un critère dur.');

  return suite;
}

// Exécution autonome
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/suites/fit-predictor.ts')) {
  const quick = process.argv.includes('--quick');
  runFitPredictorBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
