/**
 * RedView Test-Bench : FIT Predictor (Physical Effort & Cycling Simulation)
 * 
 * Benchmarks :
 * 1. Calcul de densité de l'air dynamique ρ(h, T, P) selon l'altitude
 * 2. Équations de bilan de puissance cycliste (P_grav + P_rr + P_aero + P_drivetrain)
 * 3. Modèle de fatigue exponentielle (fatigue_lambda, fatigue_floor) sur 24h
 * 4. Boucle de convergence de vitesse (Newton-Raphson) sur 10 000 segments
 * 5. Simulation complète d'étape Alpine ultra (50 000 segments avec vent de face variable)
 */
import { BenchmarkSuite } from './core/harness.ts';
import { printSuiteHeader, printSuiteResults } from './core/reporter.ts';
import { generateSyntheticRoute, type TrackPoint } from './core/synthetic-data.ts';
import type { PredictionConfig } from '../src/features/fitPredictor/types.ts';

export async function runFitPredictorBenchmark(options: { quick?: boolean } = {}): Promise<BenchmarkSuite> {
  const suite = new BenchmarkSuite('FIT Predictor (Simulation Physique & Effort)');
  const iterations = options.quick ? 5 : 20;

  const route10k = generateSyntheticRoute(10_000);
  const route50k = generateSyntheticRoute(50_000);

  const riderConfig: Required<PredictionConfig> = {
    ftp_w: 270,
    rider_weight_kg: 68,
    bike_weight_kg: 8.5,
    mass_kg: 76.5,
    cda: 0.31,
    crr: 0.0045,
    pacing_factor: 0.85,
    race_mode: true,
    smoothing_window_m: 50,
    max_route_points: 50_000,
    fatigue_floor: 0.72,
    fatigue_lambda: 0.000035, // Taux de fatigue horaire
    start_time_h: 8.0,
    rider_type: 'trained',
    target_duration_h: 12.0,
    surface_types: [1, 2],
    ambient_temperature_c: 18.0,
    headwind_ms: 3.5,
    gender: 'male',
  };

  // --- BENCHMARK 1 : Calcul de densité d'air dynamique ρ(altitude, température) ---
  suite.measureSync(
    {
      name: "Calcul Densité d'Air Dynamique ρ(h, T)",
      category: 'fit-physics',
      iterations: iterations * 10,
      regressionThresholdP95Ms: 0.6,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      let sumRho = 0;
      for (let i = 0; i < 10_000; i++) {
        const altM = 500 + (i % 2500);
        sumRho += calculateAirDensity(altM, 20.0);
      }
      return sumRho;
    },
  );

  // --- BENCHMARK 2 : Équations de puissance stationnaire sur rampe ---
  suite.measureSync(
    {
      name: 'Bilan de Puissance Stationnaire (10k itérations)',
      category: 'fit-physics',
      iterations: iterations * 5,
      regressionThresholdP95Ms: 1.5,
      itemsProcessedPerOp: 10_000,
    },
    () => {
      let sumP = 0;
      for (let i = 0; i < 10_000; i++) {
        const speedMs = 4.0 + (i % 8) * 0.5;
        const gradePct = 2.0 + (i % 12);
        sumP += calculateRequiredPower(speedMs, gradePct, 1200, riderConfig);
      }
      return sumP;
    },
  );

  // --- BENCHMARK 3 : Modélisation de fatigue exponentielle (24h) ---
  suite.measureSync(
    {
      name: 'Courbe de Fatigue Exponentielle (24h simulation)',
      category: 'fit-fatigue',
      iterations: iterations * 10,
      regressionThresholdP95Ms: 0.3,
      itemsProcessedPerOp: 86_400,
    },
    () => {
      const seconds = 86_400;
      let totalEffort = 0;
      for (let s = 0; s < seconds; s += 60) {
        const fatigue = Math.max(
          riderConfig.fatigue_floor,
          Math.exp(-riderConfig.fatigue_lambda * s),
        );
        totalEffort += fatigue;
      }
      return totalEffort;
    },
  );

  // --- BENCHMARK 4 : Convergence Vitesse par Segment (10k segments) ---
  suite.measureSync(
    {
      name: 'Convergence Vitesse Newton-Raphson (10k segments)',
      category: 'fit-simulation-10k',
      iterations,
      regressionThresholdP95Ms: 14.0,
      itemsProcessedPerOp: 10_000,
    },
    () => simulateRouteEffort(route10k, riderConfig),
  );

  // --- BENCHMARK 5 : Simulation Complète Étape Ultra (50k segments) ---
  suite.measureSync(
    {
      name: 'Simulation Étape Ultra (50k segments, vent/relief)',
      category: 'fit-simulation-50k',
      iterations: Math.max(3, Math.floor(iterations / 2)),
      regressionThresholdP95Ms: 20.0,
      itemsProcessedPerOp: 50_000,
    },
    () => simulateRouteEffort(route50k, riderConfig),
  );

  // Diagnostics & Recommandations DevOps
  suite.addRegressionRisk(
    'Divergence de convergence Newton-Raphson sur les fortes descentes (>15%) avec vent arrière extrême.',
  );
  suite.addRegressionRisk(
    'Pression GC V8 lors de la création de 50 000 objets PredictionPoint dans la boucle de simulation.',
  );
  suite.addRecommendation(
    'Déporter la boucle de simulation dans le moteur WebAssembly Rust (crates/fit-predictor) déjà préparé dans vendor/redviewalgo.',
  );
  suite.addRecommendation(
    'Structurer les résultats en TypedArrays contigus (Float32Array pour temps, vitesse, watts) plutôt qu’un tableau d’objets JS.',
  );

  return suite;
}

const P0 = 101325; // Pa
const T0 = 288.15; // K
const L = 0.0065;  // K/m
const M = 0.0289644; // kg/mol
const R = 8.31447;   // J/(mol*K)
const G = 9.80665;   // m/s^2

const L_DIV_T0 = L / T0;
const BARO_EXP = (G * M) / (R * L);
const P0_M_DIV_R = (P0 * M) / R;

function calculateAirDensity(altM: number, tempC: number): number {
  const kelvin = tempC + 273.15;
  const pFactor = Math.pow(1 - L_DIV_T0 * altM, BARO_EXP);
  return (P0_M_DIV_R * pFactor) / kelvin;
}

function calculateRequiredPower(
  speedMs: number,
  gradePct: number,
  altM: number,
  config: Required<PredictionConfig>,
): number {
  const g = 9.80665;
  const rho = calculateAirDensity(altM, config.ambient_temperature_c);
  const theta = Math.atan(gradePct / 100);

  const fGrav = config.mass_kg * g * Math.sin(theta);
  const fRoll = config.mass_kg * g * config.crr * Math.cos(theta);
  const relAirSpeed = speedMs + config.headwind_ms;
  const fAero = 0.5 * rho * config.cda * relAirSpeed * Math.abs(relAirSpeed);

  const pWheel = (fGrav + fRoll + fAero) * speedMs;
  const drivetrainEfficiency = 0.975;
  return pWheel > 0 ? pWheel / drivetrainEfficiency : 0;
}

function simulateRouteEffort(
  route: TrackPoint[],
  config: Required<PredictionConfig>,
): { totalTimeSec: number; avgSpeedKmh: number; totalEnergyKj: number } {
  const n = route.length;
  let elapsedSec = 0;
  let totalEnergyJ = 0;
  const baseTargetPower = config.ftp_w * config.pacing_factor;

  for (let i = 1; i < n; i++) {
    const p1 = route[i - 1];
    const p2 = route[i];
    const distM = Math.max(1, p2.distanceM - p1.distanceM);
    const altM = (p1.elevationM + p2.elevationM) / 2;
    const gradePct = p2.gradientPct;

    // Fatigue factor
    const fatigue = Math.max(config.fatigue_floor, Math.exp(-config.fatigue_lambda * elapsedSec));
    const targetWatts = baseTargetPower * fatigue;

    // Fast Newton-Raphson approximation for speed at target power
    let speedMs = 6.0; // Initial guess 21.6 km/h
    for (let iter = 0; iter < 4; iter++) {
      const p = calculateRequiredPower(speedMs, gradePct, altM, config);
      const err = p - targetWatts;
      // Derivative approximation
      const pNext = calculateRequiredPower(speedMs + 0.1, gradePct, altM, config);
      const dp = (pNext - p) / 0.1;
      if (dp === 0) break;
      speedMs -= err / dp;
      if (speedMs < 1.0) speedMs = 1.0;
      if (speedMs > 25.0) speedMs = 25.0;
    }

    const segTimeSec = distM / speedMs;
    elapsedSec += segTimeSec;
    totalEnergyJ += targetWatts * segTimeSec;
  }

  const totalDistKm = (route[n - 1]?.distanceM ?? 0) / 1000;
  const avgSpeedKmh = elapsedSec > 0 ? (totalDistKm / elapsedSec) * 3600 : 0;

  return {
    totalTimeSec: Math.round(elapsedSec),
    avgSpeedKmh: Number(avgSpeedKmh.toFixed(1)),
    totalEnergyKj: Math.round(totalEnergyJ / 1000),
  };
}

// Standalone execution
if (process.argv[1]?.endsWith('bench-fit-predictor.ts')) {
  const quick = process.argv.includes('--quick');
  runFitPredictorBenchmark({ quick }).then((suite) => {
    printSuiteHeader(suite.title);
    printSuiteResults(suite);
  });
}
