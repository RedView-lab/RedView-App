// ============================================
// LiDAR HD — WebGL Sunlight Controller
// ============================================
// Accurate solar ephemeris, horizon-sweep cast shadows,
// cumulative sunlight (insolation) map with background precalculation worker,
// and 3D celestial trajectory.

import {
  getSunPositionForLocalDateTime,
  getSunPositionForLocalMinutes,
  resolveSunTimesForLocalDay,
} from '@/features/sunlight/lib/sun-calc';
import {
  computeShadowSweep,
  createShadowSweepScratch,
  type ShadowSweepScratch,
} from '@/features/sunlight/lib/shadowSweep';
import type { SunlightBand, SunlightState } from '@/features/controlPanel/types';
import type { PointCloudBounds } from '../types';
import type { PrecalcResponse, PrecalcError } from './sunlightPrecalcWorker';

export interface SunlightControllerOptions {
  bounds: PointCloudBounds;
  centerX: number;
  centerY: number;
  centerZ: number;
  centerLon: number;
  centerLat: number;
  heightGrid: Float32Array; // row 0 = South, row H-1 = North
  gridWidth: number;
  gridHeight: number;
  timeZone?: string;
  onRequestRender?: () => void;
}

export interface SolarRenderState {
  enabled: boolean;
  sunDir: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  skyColor: [number, number, number];
  ambientFactor: number;
  exposure: number;
  sunAltitudeDeg: number;
  sunAzimuthDeg: number;
  shadowEnabled: boolean;
  shadowOpacity: number;
  shadowMapData: Uint8Array | null;
  shadowMapWidth: number;
  shadowMapHeight: number;
  sunlightMapEnabled: boolean;
  sunlightMapOpacity: number;
  sunlightMapRgba: Uint8Array | null;
  sunlightMapWidth: number;
  sunlightMapHeight: number;
  trajectoryEnabled: boolean;
  trajectoryVertices: Float32Array | null; // line strip of pos.xyz + color.rgba
  trajectoryVertexCount: number;
  sunDiscPos: [number, number, number] | null;
  sunDiscRadius: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16) / 255;
    const g = parseInt(clean.slice(2, 4), 16) / 255;
    const b = parseInt(clean.slice(4, 6), 16) / 255;
    return [r, g, b];
  }
  return [1, 1, 1];
}

function sunColorFromAltitude(altDeg: number): [number, number, number] {
  if (altDeg <= -2) return [1.0, 0.45, 0.15];
  if (altDeg <= 5) return [1.0, 0.68, 0.35]; // Heure dorée
  if (altDeg <= 15) return [1.0, 0.84, 0.58]; // Matin / Soir
  if (altDeg <= 30) return [1.0, 0.94, 0.82];
  return [1.0, 0.98, 0.95]; // Midi
}

function parseClockMinutes(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return 720;
  return Number(match[1]) * 60 + Number(match[2]);
}

function computeAtmosphericSkyColor(altitudeDeg: number): [number, number, number] {
  if (altitudeDeg <= -18) {
    // Nuit astronomique profonde (bleu nuit foncé)
    return [0.03, 0.05, 0.12];
  }
  if (altitudeDeg <= -6) {
    // Crépuscule nautique
    const t = (altitudeDeg - (-18)) / 12;
    return [
      0.03 + t * 0.08,
      0.05 + t * 0.08,
      0.12 + t * 0.16,
    ];
  }
  if (altitudeDeg <= 0) {
    // Crépuscule civil (transition indigo vers lueur d'aube)
    const t = (altitudeDeg - (-6)) / 6;
    return [
      0.11 + t * 0.58,
      0.13 + t * 0.32,
      0.28 + t * 0.12,
    ];
  }
  if (altitudeDeg <= 8) {
    // Lever / Coucher de soleil (lueur chaude dorée/ambrée)
    const t = altitudeDeg / 8;
    return [
      0.69 + t * 0.05,
      0.45 + t * 0.28,
      0.40 + t * 0.45,
    ];
  }
  if (altitudeDeg <= 25) {
    // Matinée / fin d'après-midi douce
    const t = (altitudeDeg - 8) / 17;
    return [
      0.74 + t * 0.02,
      0.73 + t * 0.14,
      0.85 + t * 0.11,
    ];
  }
  // Plein midi (bleu alpin pur)
  return [0.76, 0.87, 0.96];
}

export class SunlightController {
  readonly bounds: PointCloudBounds;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly centerLon: number;
  readonly centerLat: number;
  readonly timeZone: string;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly cellSizeX: number;
  readonly cellSizeY: number;
  readonly extent: number;
  onRequestRender?: () => void;

  /** Heightmap with row 0 = North, row H-1 = South for horizon sweep */
  private northSouthElev: Float32Array;
  private shadowScratch: ShadowSweepScratch;

  // Caches for shadow and sunlight map
  private lastShadowAzimuth = -999;
  private lastShadowAltitude = -999;
  private lastShadowResult: Uint8Array | null = null;

  // Background Precalculation Worker
  private precalcWorker: Worker | null = null;
  private precalcRequestId = 0;
  private precalculatedDate = '';
  private precalculatedTimeline: {
    sunriseMinutes: number;
    sunsetMinutes: number;
    timeSteps: number[];
    snapshots: Float32Array[];
  } | null = null;

  // Cumulative exposure synchronous fallback cache
  private cachedDate = '';
  private cachedExposure: Float32Array | null = null;
  private cachedExposureMinutes = 0;
  private cachedSunlightMapRgba: Uint8Array | null = null;
  private lastBandsSignature = '';
  private lastColorizedMinutes = -1;

  constructor(opts: SunlightControllerOptions) {
    this.bounds = opts.bounds;
    this.centerX = opts.centerX;
    this.centerY = opts.centerY;
    this.centerZ = opts.centerZ;
    this.centerLon = opts.centerLon;
    this.centerLat = opts.centerLat;
    this.timeZone = opts.timeZone || 'Europe/Paris';
    this.gridWidth = opts.gridWidth;
    this.gridHeight = opts.gridHeight;
    this.onRequestRender = opts.onRequestRender;

    const rangeX = opts.bounds.maxX - opts.bounds.minX;
    const rangeY = opts.bounds.maxY - opts.bounds.minY;
    const rangeZ = opts.bounds.maxZ - opts.bounds.minZ;
    this.extent = Math.max(rangeX, rangeY, rangeZ);

    this.cellSizeX = rangeX / Math.max(1, opts.gridWidth - 1);
    this.cellSizeY = rangeY / Math.max(1, opts.gridHeight - 1);

    const N = opts.gridWidth * opts.gridHeight;
    this.northSouthElev = new Float32Array(N);

    // Flip South→North heightGrid into North→South for shadow sweep
    for (let y = 0; y < opts.gridHeight; y++) {
      const srcRow = (opts.gridHeight - 1 - y) * opts.gridWidth;
      const dstRow = y * opts.gridWidth;
      for (let x = 0; x < opts.gridWidth; x++) {
        this.northSouthElev[dstRow + x] = opts.heightGrid[srcRow + x];
      }
    }

    this.shadowScratch = createShadowSweepScratch(N);

    this.initWorker();
  }

  private initWorker() {
    try {
      this.precalcWorker = new Worker(
        new URL('./sunlightPrecalcWorker.ts', import.meta.url),
        { type: 'module' },
      );

      this.precalcWorker.onmessage = (e: MessageEvent<PrecalcResponse | PrecalcError>) => {
        const data = e.data;
        if (!data) return;
        if (data.type === 'precalc-done' && data.id === this.precalcRequestId) {
          this.precalculatedDate = data.dateStr;
          this.precalculatedTimeline = {
            sunriseMinutes: data.sunriseMinutes,
            sunsetMinutes: data.sunsetMinutes,
            timeSteps: data.timeSteps,
            snapshots: data.snapshots,
          };
          this.lastColorizedMinutes = -1; // Force immediate refresh with precalculated data
          this.onRequestRender?.();
        }
      };
    } catch (err) {
      console.warn('[SunlightController] Precalculation worker could not be started, using synchronous engine.', err);
      this.precalcWorker = null;
    }
  }

  private triggerPrecalculation(dateStr: string) {
    if (this.precalculatedDate === dateStr && this.precalculatedTimeline) return;
    if (!this.precalcWorker) return;

    this.precalcRequestId += 1;
    const id = this.precalcRequestId;

    // Send a copy of the elevation grid to the worker
    const elevCopy = new Float32Array(this.northSouthElev);
    this.precalcWorker.postMessage(
      {
        type: 'precalc',
        id,
        dateStr,
        gridWidth: this.gridWidth,
        gridHeight: this.gridHeight,
        cellSizeX: this.cellSizeX,
        cellSizeY: this.cellSizeY,
        northSouthElev: elevCopy,
        centerLat: this.centerLat,
        centerLon: this.centerLon,
        timeZone: this.timeZone,
        stepMinutes: 10,
      },
      [elevCopy.buffer],
    );
  }

  compute(state: SunlightState): SolarRenderState {
    const isEnabled = state.enabled;
    const dateStr = state.date || new Date().toISOString().slice(0, 10);
    const timeStr = state.time || '12:00';
    const currentMinutes = parseClockMinutes(timeStr);

    // Déclencher le précalcul en tâche de fond pour cette journée
    if (isEnabled && dateStr !== this.precalculatedDate) {
      this.triggerPrecalculation(dateStr);
    }

    // 1. Position solaire astronomique précise
    const sunPos = getSunPositionForLocalDateTime(dateStr, timeStr, this.centerLat, this.centerLon, this.timeZone);
    const sunAzimuthDeg = sunPos ? sunPos.azimuth : 180;
    const sunAltitudeDeg = sunPos ? sunPos.altitude : 45;

    // 2. Conversion en coordonnées cartésiennes 3D du visualiseur (+X Est, +Y Haut, +Z Sud, -Z Nord)
    const azRad = (sunAzimuthDeg * Math.PI) / 180;
    const altRad = (sunAltitudeDeg * Math.PI) / 180;
    const cosAlt = Math.cos(altRad);

    const sunDir: [number, number, number] = [
      cosAlt * Math.sin(azRad),         // +X = Est
      Math.sin(altRad),                 // +Y = Haut
      -cosAlt * Math.cos(azRad),        // +Z = Sud, -Z = Nord
    ];

    // 3. Modélisation physique de la lumière et du ciel
    const isAboveHorizon = sunAltitudeDeg > 0;
    const sunColor = sunColorFromAltitude(sunAltitudeDeg);

    let sunIntensity = 0;
    if (sunAltitudeDeg > 0) {
      sunIntensity = Math.min(1.0, Math.sin(altRad) * 1.1 + 0.1);
    }

    const skyRgb = computeAtmosphericSkyColor(sunAltitudeDeg);

    let ambientFactor = 0.35;
    let exposure = 1.05;
    if (!isEnabled) {
      ambientFactor = 0.35;
      exposure = 1.05;
    } else if (sunAltitudeDeg > 15) {
      ambientFactor = 0.32;
      exposure = 1.05;
    } else if (sunAltitudeDeg > 0) {
      ambientFactor = 0.38;
      exposure = 1.02;
    } else if (sunAltitudeDeg > -6) {
      ambientFactor = 0.28;
      exposure = 0.92;
    } else if (sunAltitudeDeg > -12) {
      ambientFactor = 0.22;
      exposure = 0.82;
    } else {
      ambientFactor = 0.18;
      exposure = 0.72;
    }

    // 4. Calcul de l'ombre portée 3D (Horizon Sweep)
    let shadowMapData: Uint8Array | null = null;
    if (isEnabled && state.shadowEnabled && isAboveHorizon && state.shadowOpacity > 0) {
      const azDiff = Math.abs(sunAzimuthDeg - this.lastShadowAzimuth);
      const altDiff = Math.abs(sunAltitudeDeg - this.lastShadowAltitude);

      if (!this.lastShadowResult || azDiff > 0.05 || altDiff > 0.05) {
        const shadow = computeShadowSweep(
          this.northSouthElev,
          this.gridWidth,
          this.gridHeight,
          sunAzimuthDeg,
          sunAltitudeDeg,
          this.cellSizeX,
          this.cellSizeY,
          this.shadowScratch,
        );
        this.lastShadowResult = new Uint8Array(shadow);
        this.lastShadowAzimuth = sunAzimuthDeg;
        this.lastShadowAltitude = sunAltitudeDeg;
      }
      shadowMapData = this.lastShadowResult;
    }

    // 5. Calcul de la Carte d'Ensoleillement Cumulée (Insolation Précalculée & Fluide)
    let sunlightMapRgba: Uint8Array | null = null;
    if (isEnabled && state.sunlightMapEnabled && state.sunlightMapOpacity > 0) {
      sunlightMapRgba = this.computeCumulativeSunlightMap(dateStr, currentMinutes, state.bands);
    }

    // 6. Visualisation de la Trajectoire Solaire 3D et Disque Céleste
    let trajectoryVertices: Float32Array | null = null;
    let trajectoryVertexCount = 0;
    let sunDiscPos: [number, number, number] | null = null;

    // Rétrécissement du rayon céleste pour cadrer parfaitement dans la vue sans avoir à dézoomer
    const planSpan = Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY);
    const skyRadius = Math.max(planSpan * 0.48, this.extent * 0.46);

    if (isEnabled && state.trajectoryEnabled) {
      const traj = this.buildTrajectoryGeometry(dateStr, skyRadius, sunAzimuthDeg, sunAltitudeDeg);
      trajectoryVertices = traj.vertices;
      trajectoryVertexCount = traj.vertexCount;
      sunDiscPos = traj.currentSunPos;
    }

    return {
      enabled: isEnabled,
      sunDir,
      sunColor,
      sunIntensity: isEnabled ? sunIntensity : 1.0,
      skyColor: isEnabled ? skyRgb : [0.76, 0.87, 0.96],
      ambientFactor,
      exposure,
      sunAltitudeDeg,
      sunAzimuthDeg,
      shadowEnabled: isEnabled && state.shadowEnabled,
      shadowOpacity: state.shadowOpacity / 100,
      shadowMapData,
      shadowMapWidth: this.gridWidth,
      shadowMapHeight: this.gridHeight,
      sunlightMapEnabled: isEnabled && state.sunlightMapEnabled,
      sunlightMapOpacity: state.sunlightMapOpacity / 100,
      sunlightMapRgba,
      sunlightMapWidth: this.gridWidth,
      sunlightMapHeight: this.gridHeight,
      trajectoryEnabled: isEnabled && state.trajectoryEnabled,
      trajectoryVertices,
      trajectoryVertexCount,
      sunDiscPos,
      sunDiscRadius: Math.max(10, skyRadius * 0.022),
    };
  }

  private computeCumulativeSunlightMap(
    dateStr: string,
    currentMinutes: number,
    bands: SunlightBand[],
  ): Uint8Array {
    const N = this.gridWidth * this.gridHeight;
    const bandsSignature = JSON.stringify(bands);

    // OPTION A : Chemin haute performance précalculé (0ms CPU, 60+ FPS)
    if (this.precalculatedTimeline && this.precalculatedDate === dateStr) {
      const { sunriseMinutes, sunsetMinutes, timeSteps, snapshots } = this.precalculatedTimeline;

      const needsRecolor =
        !this.cachedSunlightMapRgba ||
        this.lastBandsSignature !== bandsSignature ||
        this.lastColorizedMinutes !== currentMinutes;

      if (needsRecolor) {
        let exposure: Float32Array;

        if (currentMinutes <= sunriseMinutes || snapshots.length === 0) {
          exposure = snapshots[0] ?? new Float32Array(N);
        } else if (currentMinutes >= sunsetMinutes) {
          exposure = snapshots[snapshots.length - 1] ?? new Float32Array(N);
        } else {
          // Recherche dichotomique / indexation directe de la tranche précalculée
          let idx = 0;
          for (let i = 0; i < timeSteps.length - 1; i++) {
            if (currentMinutes >= timeSteps[i] && currentMinutes < timeSteps[i + 1]) {
              idx = i;
              break;
            }
          }
          exposure = snapshots[idx] ?? snapshots[snapshots.length - 1];
        }

        this.cachedSunlightMapRgba = this.colorizeExposure(exposure, bands);
        this.lastBandsSignature = bandsSignature;
        this.lastColorizedMinutes = currentMinutes;
      }

      return this.cachedSunlightMapRgba ?? new Uint8Array(N * 4);
    }

    // OPTION B : Chemin synchrone incrémental (utilisé pendant les 50 premières ms avant le worker)
    const stepMinutes = 10;
    const dateChanged = this.cachedDate !== dateStr;

    if (dateChanged || !this.cachedExposure || currentMinutes < this.cachedExposureMinutes) {
      this.cachedDate = dateStr;
      this.cachedExposure = new Float32Array(N);
      this.cachedExposureMinutes = 0;
    }

    const exposure = this.cachedExposure;
    let t = this.cachedExposureMinutes;

    while (t < currentMinutes) {
      const nextT = Math.min(currentMinutes, t + stepMinutes);
      const dt = nextT - t;
      const midT = t + dt * 0.5;

      const pos = getSunPositionForLocalMinutes(dateStr, midT, this.centerLat, this.centerLon, this.timeZone);
      if (pos && pos.altitude > 0) {
        const shadow = computeShadowSweep(
          this.northSouthElev,
          this.gridWidth,
          this.gridHeight,
          pos.azimuth,
          pos.altitude,
          this.cellSizeX,
          this.cellSizeY,
          this.shadowScratch,
        );

        for (let i = 0; i < N; i++) {
          if (shadow[i] < 128) {
            exposure[i] += dt;
          }
        }
      }

      t = nextT;
    }

    this.cachedExposureMinutes = currentMinutes;

    const needsRecolor =
      !this.cachedSunlightMapRgba ||
      this.lastBandsSignature !== bandsSignature ||
      this.lastColorizedMinutes !== currentMinutes;

    if (needsRecolor) {
      this.cachedSunlightMapRgba = this.colorizeExposure(exposure, bands);
      this.lastBandsSignature = bandsSignature;
      this.lastColorizedMinutes = currentMinutes;
    }

    return this.cachedSunlightMapRgba ?? new Uint8Array(N * 4);
  }

  private colorizeExposure(exposure: Float32Array, bands: SunlightBand[]): Uint8Array {
    const N = this.gridWidth * this.gridHeight;
    const rgba = new Uint8Array(N * 4);

    const bandColors = bands.map((b) => {
      const rgb = hexToRgb(b.color);
      const minMins = b.minMinutes ?? 0;
      const maxMins = b.maxMinutes ?? 240;
      return {
        minMins,
        maxMins,
        r: Math.round(rgb[0] * 255),
        g: Math.round(rgb[1] * 255),
        b: Math.round(rgb[2] * 255),
        visible: b.visible,
      };
    });

    for (let i = 0; i < N; i++) {
      const mins = exposure[i];
      if (mins <= 0) continue;

      let matched = null;
      for (let bi = 0; bi < bandColors.length; bi++) {
        const b = bandColors[bi];
        if (bi === bandColors.length - 1 || (mins >= b.minMins && mins < b.maxMins)) {
          matched = b;
          break;
        }
      }

      if (matched && matched.visible) {
        const off = i * 4;
        rgba[off] = matched.r;
        rgba[off + 1] = matched.g;
        rgba[off + 2] = matched.b;
        rgba[off + 3] = 255;
      }
    }

    return rgba;
  }

  private buildTrajectoryGeometry(
    dateStr: string,
    skyRadius: number,
    currentAzDeg: number,
    currentAltDeg: number,
  ): {
    vertices: Float32Array;
    vertexCount: number;
    currentSunPos: [number, number, number];
  } {
    const times = resolveSunTimesForLocalDay(dateStr, this.centerLat, this.centerLon, this.timeZone);
    const startM = times.sunriseTime && times.sunriseTime !== '--:--' ? parseClockMinutes(times.sunriseTime) : 360;
    const endM = times.sunsetTime && times.sunsetTime !== '--:--' ? parseClockMinutes(times.sunsetTime) : 1260;

    const SAMPLES = 64;
    const FLOATS = 7;
    const vertices = new Float32Array(SAMPLES * FLOATS);

    for (let i = 0; i < SAMPLES; i++) {
      const m = startM + (i / (SAMPLES - 1)) * (endM - startM);
      const pos = getSunPositionForLocalMinutes(dateStr, m, this.centerLat, this.centerLon, this.timeZone);
      const az = pos ? pos.azimuth : 180;
      const alt = pos ? Math.max(0, pos.altitude) : 0;

      const azRad = (az * Math.PI) / 180;
      const altRad = (alt * Math.PI) / 180;
      const cosA = Math.cos(altRad);

      const px = skyRadius * cosA * Math.sin(azRad);
      const py = skyRadius * Math.sin(altRad);
      const pz = -skyRadius * cosA * Math.cos(azRad);

      const idx = i * FLOATS;
      vertices[idx] = px;
      vertices[idx + 1] = py;
      vertices[idx + 2] = pz;

      vertices[idx + 3] = 1.0;
      vertices[idx + 4] = 0.82;
      vertices[idx + 5] = 0.35;
      vertices[idx + 6] = 0.65;
    }

    const curAzRad = (currentAzDeg * Math.PI) / 180;
    const curAltRad = (currentAltDeg * Math.PI) / 180;
    const curCosA = Math.cos(curAltRad);

    const currentSunPos: [number, number, number] = [
      skyRadius * curCosA * Math.sin(curAzRad),
      skyRadius * Math.sin(curAltRad),
      -skyRadius * curCosA * Math.cos(curAzRad),
    ];

    return {
      vertices,
      vertexCount: SAMPLES,
      currentSunPos,
    };
  }

  destroy(): void {
    if (this.precalcWorker) {
      this.precalcWorker.terminate();
      this.precalcWorker = null;
    }
  }
}
