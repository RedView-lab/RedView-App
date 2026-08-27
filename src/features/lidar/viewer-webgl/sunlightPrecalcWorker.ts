// ============================================
// LiDAR HD — WebGL Sunlight Precalculation Worker
// ============================================
// Fast background worker that precalculates the entire diurnal solar
// exposure timeline and snapshots (every 10 minutes) for 60+ FPS zero-latency scrubbing.

import {
  getSunPositionForLocalMinutes,
  resolveSunTimesForLocalDay,
} from '@/features/sunlight/lib/sun-calc';
import {
  computeShadowSweep,
  createShadowSweepScratch,
  type ShadowSweepScratch,
} from '@/features/sunlight/lib/shadowSweep';

export interface PrecalcRequest {
  type: 'precalc';
  id: number;
  dateStr: string;
  gridWidth: number;
  gridHeight: number;
  cellSizeX: number;
  cellSizeY: number;
  northSouthElev: Float32Array;
  centerLat: number;
  centerLon: number;
  timeZone: string;
  stepMinutes?: number;
}

export interface PrecalcResponse {
  type: 'precalc-done';
  id: number;
  dateStr: string;
  sunriseMinutes: number;
  sunsetMinutes: number;
  timeSteps: number[];
  snapshots: Float32Array[];
}

export interface PrecalcError {
  type: 'precalc-error';
  id: number;
  message: string;
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let currentScratch: ShadowSweepScratch | null = null;
let currentScratchSize = 0;

function parseClockMinutes(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return 720;
  return Number(match[1]) * 60 + Number(match[2]);
}

ctx.onmessage = (e: MessageEvent<PrecalcRequest>) => {
  const msg = e.data;
  if (!msg || msg.type !== 'precalc') return;

  try {
    const {
      id,
      dateStr,
      gridWidth,
      gridHeight,
      cellSizeX,
      cellSizeY,
      northSouthElev,
      centerLat,
      centerLon,
      timeZone,
      stepMinutes = 10,
    } = msg;

    const N = gridWidth * gridHeight;
    if (!currentScratch || currentScratchSize < N) {
      currentScratch = createShadowSweepScratch(N);
      currentScratchSize = N;
    }

    const times = resolveSunTimesForLocalDay(dateStr, centerLat, centerLon, timeZone);
    const sunriseM = times.sunriseTime && times.sunriseTime !== '--:--' ? parseClockMinutes(times.sunriseTime) : 360;
    const sunsetM = times.sunsetTime && times.sunsetTime !== '--:--' ? parseClockMinutes(times.sunsetTime) : 1260;

    const startM = Math.max(0, Math.floor(sunriseM / stepMinutes) * stepMinutes);
    const endM = Math.min(1440, Math.ceil(sunsetM / stepMinutes) * stepMinutes);

    const cumulative = new Float32Array(N);
    const timeSteps: number[] = [];
    const snapshots: Float32Array[] = [];
    const transferBuffers: Transferable[] = [];

    // Pre-seed baseline snapshot before sunrise (all 0)
    timeSteps.push(startM);
    const baseSnapshot = new Float32Array(N);
    snapshots.push(baseSnapshot);
    transferBuffers.push(baseSnapshot.buffer);

    let t = startM;
    while (t < endM) {
      const nextT = Math.min(endM, t + stepMinutes);
      const dt = nextT - t;
      const midT = t + dt * 0.5;

      const pos = getSunPositionForLocalMinutes(dateStr, midT, centerLat, centerLon, timeZone);
      if (pos && pos.altitude > 0) {
        const shadow = computeShadowSweep(
          northSouthElev,
          gridWidth,
          gridHeight,
          pos.azimuth,
          pos.altitude,
          cellSizeX,
          cellSizeY,
          currentScratch,
        );

        for (let i = 0; i < N; i++) {
          if (shadow[i] < 128) {
            cumulative[i] += dt;
          }
        }
      }

      t = nextT;

      // Save keyframe snapshot
      const snap = new Float32Array(cumulative);
      timeSteps.push(t);
      snapshots.push(snap);
      transferBuffers.push(snap.buffer);
    }

    const response: PrecalcResponse = {
      type: 'precalc-done',
      id,
      dateStr,
      sunriseMinutes: sunriseM,
      sunsetMinutes: sunsetM,
      timeSteps,
      snapshots,
    };

    ctx.postMessage(response, transferBuffers);
  } catch (err: unknown) {
    const errorMsg: PrecalcError = {
      type: 'precalc-error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(errorMsg);
  }
};
