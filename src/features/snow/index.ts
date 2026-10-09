// ============================================================================
// Fonction neige — orchestrateur public
// ----------------------------------------------------------------------------
// runSnowPipeline(heightmap) :
//   1. géographie de la scène (coins en WGS84, convergence des méridiens) ;
//   2. en parallèle : hauteur de neige AROME (±0,4°), mesures + bulletin
//      d'avalanche + historique météo (/api/snow-context), DEM lointain
//      (Terrarium) ; sans AROME (hors de son domaine, Météo-France indisponible),
//      pas de champ de neige : les modèles météo auto-hébergés ne portent pas de
//      hauteur de neige ;
//   3. orographie du modèle pour les cellules grossières (Terrarium) ;
//   4. moteur neige v2 dans un worker (lib/engine/pipeline.ts).
// ============================================================================

import { toWgs84, trueNorthGridBearingDeg } from '../lidar/lib/coordConvert';
import { DEFAULT_SNOW_ENGINE_CONFIG, type SnowEngineConfig } from './lib/engine/config';
import { SceneFrame } from './lib/engine/grid';
import type { CoarseSnowGrid, SceneGeo, SnowEngineInput, SnowEngineResult, SnowObservation } from './lib/engine/types';
import type { EngineWorkerRequest, EngineWorkerResponse } from './lib/engineWorker';
import { fetchAromeSnow, type AromeGrid } from './lib/sources/arome';
import { fetchSnowContext, type SnowContext } from './lib/sources/context';
import { coarseOrography, farFieldDem, terrariumSupported } from './lib/sources/terrarium';
import type { SnowField, SnowHeightmap, SnowProgress } from './types';

export type { CanopyGrid, SnowField, SnowHeightmap, SnowDisplayMode, SnowProgress, SnowObservation } from './types';
export type { SnowDiagnostics } from './lib/engine/types';
export { DEFAULT_SNOW_ENGINE_CONFIG } from './lib/engine/config';

/** DEM lointain : marge autour de la scène et pas, m. */
const FAR_MARGIN_M = 7000;
const FAR_CELL_M = 50;

function sceneGeo(h: SnowHeightmap): SceneGeo {
  const { minX, minY, maxX, maxY } = h.bounds;
  const ll = (x: number, y: number) => {
    const [lon, lat] = toWgs84(x, y, h.crs);
    return { lon, lat };
  };
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    corners: [ll(minX, minY), ll(maxX, minY), ll(maxX, maxY), ll(minX, maxY)],
    // trueNorthGridBearingDeg indique où pointe le nord vrai sur la grille ; le
    // moteur attend le gisement vrai de l'axe +Y de la grille : l'opposé.
    gridNorthBearingDeg: -trueNorthGridBearingDeg(cx, cy, h.crs),
  };
}

function runWorker(input: SnowEngineInput, progress: SnowProgress, signal?: AbortSignal): Promise<SnowEngineResult> {
  const worker = new Worker(new URL('./lib/engineWorker.ts', import.meta.url), { type: 'module' });
  const onAbort = () => worker.terminate();
  signal?.addEventListener('abort', onAbort);
  const transfer: Transferable[] = [input.dem.data.buffer as ArrayBuffer];
  if (input.canopy) transfer.push(input.canopy.data.buffer as ArrayBuffer);
  if (input.farDem) transfer.push(input.farDem.data.buffer as ArrayBuffer);
  return new Promise<SnowEngineResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<EngineWorkerResponse>) => {
      const m = e.data;
      if (m.type === 'progress') progress(40 + m.pct * 0.6, m.label);
      else if (m.type === 'done') resolve(m.result);
      else reject(new Error(m.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'snow worker error'));
    worker.postMessage({ type: 'compute', input } satisfies EngineWorkerRequest, transfer);
  }).finally(() => {
    signal?.removeEventListener('abort', onAbort);
    worker.terminate();
  });
}

export async function runSnowPipeline(
  heightmap: SnowHeightmap,
  options?: {
    /** Mesures supplémentaires (p. ex. sondages dans la scène : kind 'point'). */
    observations?: SnowObservation[];
    config?: Partial<SnowEngineConfig>;
    progress?: SnowProgress;
    signal?: AbortSignal;
  },
): Promise<SnowField> {
  const config: SnowEngineConfig = { ...DEFAULT_SNOW_ENGINE_CONFIG, ...(options?.config ?? {}) };
  const progress = options?.progress ?? (() => {});
  const signal = options?.signal;
  const t0 = performance.now();
  const sizeX = heightmap.bounds.maxX - heightmap.bounds.minX;
  const sizeY = heightmap.bounds.maxY - heightmap.bounds.minY;

  const geo = sceneGeo(heightmap);
  const frame = new SceneFrame(geo);
  const dem = new Float32Array(heightmap.data.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < dem.length; i++) {
    const v = heightmap.data[i] + heightmap.altitudeOffsetM;
    dem[i] = v;
    if (Number.isFinite(v)) { sum += v; count++; }
  }
  const sceneAltitude = count > 0 ? sum / count : heightmap.altitudeOffsetM;

  progress(0, 'Données neige (AROME, stations, bulletin, météo)…');
  const canUseTiles = terrariumSupported();
  // Les trois sources partent ensemble, mais sans l'analyse AROME il n'y a pas
  // de champ de neige : son échec arrête tout de suite les deux autres. Le
  // contexte (stations, BRA, 60 jours de météo) prend jusqu'à ~16 s à froid
  // (mesuré en prod le 2026-10-09) : la personne attendait tout ce temps pour
  // apprendre que la source Météo-France n'était pas disponible.
  const loads = new AbortController();
  const forwardAbort = () => loads.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  // Rejets pris en charge dès le départ : un échec pendant l'attente d'AROME
  // n'est jamais une promesse rejetée « non gérée ».
  const others = Promise.allSettled([
    fetchSnowContext(frame.center, sceneAltitude, loads.signal),
    canUseTiles ? farFieldDem(frame, sizeX, sizeY, FAR_MARGIN_M, FAR_CELL_M, loads.signal) : Promise.resolve(null),
  ]);
  let arome: AromeGrid;
  let contextRes: Awaited<typeof others>[0];
  let farRes: Awaited<typeof others>[1];
  try {
    try {
      arome = await fetchAromeSnow(frame.center, loads.signal);
    } catch (error) {
      loads.abort();
      throw error instanceof Error ? error : new Error('snow data unavailable');
    }
    [contextRes, farRes] = await others;
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const context: SnowContext | null = contextRes.status === 'fulfilled' ? contextRes.value : null;
  if (!context) console.warn('[snow] context unavailable:', contextRes.status === 'rejected' ? contextRes.reason : '');
  let coarse: CoarseSnowGrid = arome.grid;

  progress(25, 'Orographie du modèle…');
  if (canUseTiles) {
    try {
      const oro = await coarseOrography(coarse, signal);
      let known = 0;
      for (const v of oro) if (Number.isFinite(v)) known++;
      if (known > 0.5 * oro.length) coarse = { ...coarse, orographyM: oro };
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[snow] coarse orography unavailable:', err);
    }
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const input: SnowEngineInput = {
    dem: { data: dem, width: heightmap.width, height: heightmap.height, sizeX, sizeY },
    geo,
    coarse,
    farDem: farRes.status === 'fulfilled' ? farRes.value : null,
    canopy: heightmap.canopy ? { ...heightmap.canopy, data: new Float32Array(heightmap.canopy.data) } : null,
    observations: [...(context?.observations ?? []), ...(options?.observations ?? [])],
    bra: context?.bra ?? null,
    weather: context?.weather ?? null,
    analysisTimeMs: Date.parse(arome.timestamp) || Date.now(),
    config,
  };
  progress(40, 'Répartition de la neige…');
  const result = await runWorker(input, progress, signal);
  const sources = { ...(context?.sources ?? {}), arome: 'ok', farDem: input.farDem ? 'ok' : 'unavailable', orography: coarse.orographyM ? 'ok' : 'scene-dtm' };

  return {
    data: result.hsCm,
    width: result.width,
    height: result.height,
    boundsMeters: [heightmap.bounds.minX, heightmap.bounds.minY, heightmap.bounds.maxX, heightmap.bounds.maxY],
    stats: { ...result.stats, elapsedMs: performance.now() - t0 },
    arome: {
      timestamp: arome.timestamp,
      runHour: arome.runHour,
      source: 'meteofrance-arome',
    },
    diagnostics: result.diagnostics,
    sources,
  };
}
