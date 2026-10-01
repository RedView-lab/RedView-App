/**
 * Accès au moteur WASM depuis Node pour le banc de précision.
 *
 * `loadPkg(dir)` charge une glue wasm-bindgen (`--target web`) depuis n'importe
 * quel dossier : pkg de l'app, `.baseline-pkg` (ancien moteur figé) ou
 * `.dev-pkg` (build de développement). Surcharge par PACE_PKG.
 *
 * Les prédictions passent par les vrais builders TS de l'app
 * (`container-prediction.ts`) pour mesurer exactement ce que l'app calcule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultItinerary } from '../../../src/features/itineraryPanel/lib/project/defaultState.ts';
import {
  buildPredictionConfigFromRhythm,
  buildRouteGpxFile,
} from '../../../src/features/itineraryPanel/lib/schedule/container-prediction.ts';
import type { TrackPoint } from './rides';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
export const APP_PKG = path.join(ROOT, 'src/features/fitPredictor/engine/pkg');
export const BASELINE_PKG = path.join(ROOT, 'script-test-bench/pace-accuracy/.baseline-pkg');
export const DEV_PKG = path.join(ROOT, 'script-test-bench/pace-accuracy/.dev-pkg');

export async function loadPkg(dir: string = process.env.PACE_PKG ?? APP_PKG): Promise<any> {
  const url = pathToFileURL(path.join(dir, 'redviewalgo.js'));
  url.search = `?i=${Math.random()}`;
  const glue = await import(url.href);
  glue.initSync({ module: fs.readFileSync(path.join(dir, 'redviewalgo_bg.wasm')) });
  return glue;
}

export function silenceConsole<T>(fn: () => T): T {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

export type PresetLevel = 'debutant' | 'intermediaire' | 'avance' | 'expert';
export type Gender = 'default' | 'female' | 'male';

export type RiderSpec =
  | { kind: 'preset'; level: PresetLevel; gender: Gender }
  | { kind: 'custom'; fits: Uint8Array[]; gender?: Gender; ftp?: number | null; systemWeightKg?: number | null; tiresMm?: number | null };

export interface RoutePointInput { lat: number; lon: number; elevationM: number | null; distanceM?: number }

export function trackToRoutePoints(track: TrackPoint[]): RoutePointInput[] {
  return track.map((p) => ({ lat: p.lat, lon: p.lon, elevationM: p.ele, distanceM: p.d }));
}

function buildItinerary(points: RoutePointInput[], rider: RiderSpec) {
  const it = createDefaultItinerary(1);
  it.gpxRoute = { name: 'bench', points } as never;
  if (rider.kind === 'preset') {
    it.rhythm = { ...it.rhythm, rhythmProfile: 'preset', practiceLevel: rider.level, gender: rider.gender } as never;
  } else {
    it.rhythm = {
      ...it.rhythm,
      rhythmProfile: 'custom',
      usePastActivities: true,
      gender: rider.gender ?? 'default',
      ftp: rider.ftp ?? null,
      systemWeightKg: rider.systemWeightKg ?? null,
      tiresMm: rider.tiresMm ?? null,
    } as never;
  }
  return it;
}

export interface PredictionLike {
  total_time_s: number;
  total_distance_m: number;
  points: { distance_m: number; elapsed_time_s: number; predicted_speed_kmh: number; gradient_pct: number }[];
  [key: string]: unknown;
}

export interface V2Route {
  lat: Float64Array;
  lon: Float64Array;
  ele: Float64Array;
  dist: Float64Array;
  surface: Uint8Array;
  way: Uint8Array;
  wind: Float64Array;
}

export function trackToV2Route(track: TrackPoint[], attrs?: { surface?: Uint8Array; way?: Uint8Array; wind?: Float64Array }): V2Route {
  return {
    lat: Float64Array.from(track, (p) => p.lat),
    lon: Float64Array.from(track, (p) => p.lon),
    ele: Float64Array.from(track, (p) => p.ele),
    dist: Float64Array.from(track, (p) => p.d),
    surface: attrs?.surface ?? new Uint8Array(0),
    way: attrs?.way ?? new Uint8Array(0),
    wind: attrs?.wind ?? new Float64Array(0),
  };
}

/** Prédiction par l'API v2 `predict_cycling(...)`. */
export function predictV2(glue: any, route: V2Route, config: Record<string, unknown>): PredictionLike & Record<string, any> {
  return glue.predict_cycling(route.lat, route.lon, route.ele, route.dist, route.surface, route.way, route.wind, config);
}

/**
 * Table des préréglages de l'ancien moteur (retirée de l'app, où les niveaux
 * vivent désormais dans le moteur v2) : conservée ici pour rejouer fidèlement
 * la ligne de base (.baseline-pkg).
 */
const LEGACY_PRESETS: Record<PresetLevel, { wkg: number; cda: number; crr: number; fatigueFloor: number; fatigueLambda: number }> = {
  debutant: { wkg: 2.3, cda: 0.38, crr: 0.0052, fatigueFloor: 0.58, fatigueLambda: 0.032 },
  intermediaire: { wkg: 3.0, cda: 0.35, crr: 0.005, fatigueFloor: 0.66, fatigueLambda: 0.025 },
  avance: { wkg: 3.8, cda: 0.32, crr: 0.0046, fatigueFloor: 0.75, fatigueLambda: 0.018 },
  expert: { wkg: 5.0, cda: 0.28, crr: 0.0042, fatigueFloor: 0.85, fatigueLambda: 0.01 },
};

/** Prédiction par l'API historique `predict(fits, gpx, config)` (moteur v1 ou compat v2). */
export async function predictLegacy(glue: any, points: RoutePointInput[], rider: RiderSpec): Promise<PredictionLike> {
  const it = buildItinerary(points, rider);
  const cfg: Record<string, unknown> = { ...buildPredictionConfigFromRhythm(it.rhythm, points as never) };
  if (rider.kind === 'preset') {
    const level = LEGACY_PRESETS[rider.level];
    cfg.ftp_w = Math.round(level.wkg * (rider.gender === 'female' ? 56 : 70));
    cfg.cda = level.cda;
    cfg.crr = level.crr;
    cfg.fatigue_floor = level.fatigueFloor;
    cfg.fatigue_lambda = level.fatigueLambda;
  }
  const gpx = new Uint8Array(await buildRouteGpxFile(it).arrayBuffer());
  const fits = rider.kind === 'custom' ? rider.fits : [];
  return silenceConsole(() => glue.predict(fits, gpx, cfg, () => {})) as PredictionLike;
}
