// ============================================================================
// Snow engine v2 — wind transport (drift flux divergence)
// ----------------------------------------------------------------------------
// For each sector of the transport-weighted wind rose:
//  1. local wind speed factor S = 1 + γs·Ωs + γc·Ωc − γx·Sx (MicroMet slope
//     and curvature terms, Liston & Elder 2006, plus the upwind shelter of
//     Winstral et al. 2002 at 100 m and 1000 m);
//  2. transport capacity C = ((S·U − Ut)⁺ / (U − Ut))³, 1 on open flat
//     terrain (saltation flux ∝ u*(u*² − u*t²));
//  3. the drift flux is carried downwind and relaxes towards C over a
//     saturation length: where C rises (crests, windward convexities) the
//     wind erodes, where it falls (lee slopes, hollows, behind breaks) it
//     deposits — the flux divergence, mass-conserving by construction.
// The flux entering the scene comes from the same computation on the far-field
// DEM, so a tile sitting in the lee of a big ridge outside it gets loaded.
// The pattern is linear in the flat-terrain flux Q0; Q0 itself is set later
// (physical estimate from the wind history, refined against Helbig's σ).
// ============================================================================

import type { SnowEngineConfig } from './config';
import { boxMean, sampleBilinear, type SceneFrame, type WorkGrid } from './grid';
import { AltitudeSampler, curvatureAtScale, gaussianSmooth, robustAbsQuantile, shelterIndex, terrainGradients, type TerrainFields } from './terrain';
import type { WindRose } from './weatherHistory';
import type { FarDem } from './types';

const RAD = Math.PI / 180;
const SECTOR_DEG = 22.5;

export interface WindSector {
  fromTrueDeg: number;
  weight: number;
  speedMs: number;
  thresholdMs: number;
}

/** Sectors carrying at least `minWeight` of the transport, renormalised. */
export function activeSectors(rose: WindRose, minWeight = 0.04): WindSector[] {
  const out: WindSector[] = [];
  for (let s = 0; s < rose.weights.length; s++) {
    if (rose.weights[s] < minWeight) continue;
    out.push({
      fromTrueDeg: s * SECTOR_DEG,
      weight: rose.weights[s],
      speedMs: rose.speedMs[s] || 12,
      thresholdMs: rose.thresholdMs[s] || 7.5,
    });
  }
  const sum = out.reduce((a, s) => a + s.weight, 0);
  for (const s of out) s.weight /= sum || 1;
  return out;
}

interface CurvaturePair {
  small: Float32Array | null;
  large: Float32Array;
}

function scaledInPlace(a: Float32Array): Float32Array {
  const q = robustAbsQuantile(a, 0.98);
  const k = q > 0 ? 0.5 / q : 0;
  for (let i = 0; i < a.length; i++) a[i] = Math.max(-0.5, Math.min(0.5, a[i] * k));
  return a;
}

export function windCurvatures(grid: WorkGrid, config: SnowEngineConfig): CurvaturePair {
  const ps = grid.ps;
  const small = config.curvatureSmallM >= 2 * ps
    ? scaledInPlace(curvatureAtScale(grid, config.curvatureSmallM, boxMean(grid.z, grid.width, grid.height, Math.max(1, Math.round(config.curvatureSmallM / ps / 3)))))
    : null;
  const large = scaledInPlace(curvatureAtScale(grid, config.curvatureLargeM, boxMean(grid.z, grid.width, grid.height, Math.max(1, Math.round(config.curvatureLargeM / ps / 3)))));
  return { small, large };
}

/**
 * Transport capacity (1 on open flat terrain) for one sector, and the
 * empirical exposure term of the same sector (Winstral Sx and curvature,
 * + sheltered / − exposed, in [−1, 1]).
 */
function sectorFields(
  grid: WorkGrid,
  terrain: TerrainFields,
  curv: CurvaturePair,
  sampler: AltitudeSampler,
  windFromGridDeg: number,
  sector: WindSector,
  config: SnowEngineConfig,
): { capacity: Float32Array; exposure: Float32Array } {
  const n = grid.width * grid.height;
  const local = grid.ps < config.shelterLocalM / 2
    ? shelterIndex(grid, sampler, windFromGridDeg, grid.ps, config.shelterLocalM)
    : new Float32Array(n);
  const outlying = shelterIndex(grid, sampler, windFromGridDeg, Math.max(grid.ps, config.shelterLocalM), config.shelterOutlyingM);
  const omegaS = new Float32Array(n);
  const xi = windFromGridDeg * RAD;
  for (let i = 0; i < n; i++) {
    const beta = Math.atan(Math.hypot(terrain.gx[i], terrain.gy[i]));
    omegaS[i] = beta * Math.cos(xi - terrain.aspectGridDeg[i] * RAD);
  }
  scaledInPlace(omegaS);
  const u = sector.speedMs;
  const ut = sector.thresholdMs;
  const denom = Math.max(0.5, u - ut);
  const cap = new Float32Array(n);
  const exposure = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const omegaC = curv.small ? 0.5 * (curv.small[i] + curv.large[i]) : curv.large[i];
    const sx = 0.6 * local[i] + 0.4 * outlying[i];
    const s = Math.max(0.1, 1
      + config.windSlopeWeight * omegaS[i]
      + config.windCurvatureWeight * omegaC
      - config.windShelterWeight * 0.5 * Math.max(-1, Math.min(1, sx / 15)));
    const excess = Math.max(0, s * u - ut) / denom;
    cap[i] = Math.min(8, excess * excess * excess);
    exposure[i] = Math.max(-1, Math.min(1, 0.7 * Math.max(-1, Math.min(1, sx / 20)) - 0.6 * omegaC));
  }
  return { capacity: cap, exposure };
}

type Inflow = (x: number, y: number) => number;

/**
 * Carries the drift flux across the grid in the travel direction (grid deg).
 * Semi-Lagrangian upwind sweep along the major axis; the flux of a node is
 * split linearly between the two nodes of the next column it lands between
 * (mass-conserving). Returns the deposition per unit flat flux, and the flux
 * entering every node.
 */
function marchFlux(
  w: number, h: number, dx: number, dy: number,
  capacity: Float32Array,
  travelGridDeg: number,
  lambdaM: number,
  inflow: Inflow,
): { deposition: Float32Array; fluxIn: Float32Array } {
  const deposition = new Float32Array(w * h);
  const fluxIn = new Float32Array(w * h);
  const px = Math.sin(travelGridDeg * RAD) / dx;
  const py = Math.cos(travelGridDeg * RAD) / dy;
  const alongX = Math.abs(px) >= Math.abs(py);
  const nSteps = alongX ? w : h;
  const nLines = alongX ? h : w;
  const dir = (alongX ? px : py) > 0 ? 1 : -1;
  const shift = alongX ? py / Math.abs(px) : px / Math.abs(py);
  const ds = alongX ? Math.hypot(dx, shift * dy) : Math.hypot(dy, shift * dx);
  const decay = Math.exp(-ds / lambdaM);
  const node = (s: number, l: number) => (alongX ? l * w + s : s * w + l);
  const coordOf = (s: number, l: number): [number, number] => (alongX ? [s, l] : [l, s]);
  let q = new Float64Array(nLines);
  let next = new Float64Array(nLines);
  const wsum = new Float64Array(nLines);
  const s0 = dir > 0 ? 0 : nSteps - 1;
  for (let l = 0; l < nLines; l++) {
    const [x, y] = coordOf(s0, l);
    q[l] = inflow(x, y);
  }
  for (let k = 0; k < nSteps; k++) {
    const s = dir > 0 ? k : nSteps - 1 - k;
    next.fill(0);
    wsum.fill(0);
    for (let l = 0; l < nLines; l++) {
      const i = node(s, l);
      const c = capacity[i];
      const qi = q[l];
      fluxIn[i] = qi;
      const qo = c + (qi - c) * decay;
      deposition[i] = (qi - qo) / ds;
      const target = l + shift;
      const l0 = Math.floor(target);
      const f = target - l0;
      if (l0 >= 0 && l0 < nLines) { next[l0] += qo * (1 - f); wsum[l0] += 1 - f; }
      if (l0 + 1 >= 0 && l0 + 1 < nLines) { next[l0 + 1] += qo * f; wsum[l0 + 1] += f; }
    }
    if (k < nSteps - 1) {
      const sn = dir > 0 ? s + 1 : s - 1;
      for (let l = 0; l < nLines; l++) {
        if (wsum[l] < 0.999) {
          const [x, y] = coordOf(sn, l);
          next[l] += (1 - wsum[l]) * inflow(x, y);
        }
      }
    }
    const tmp = q; q = next; next = tmp;
  }
  return { deposition, fluxIn };
}

export interface WindPattern {
  /** Deposition (+) / erosion (−), cm per cm·m of flat flux. */
  pattern: Float32Array;
  meanAbs: number;
  /** Transport-weighted empirical exposure (+ sheltered, − exposed). */
  shelter: Float32Array;
  sectors: WindSector[];
}

/** Far-field DEM as a work grid (its own terrain analysis, coarse). */
function farAsGrid(far: FarDem): WorkGrid {
  return {
    width: far.width, height: far.height, dx: far.cell, dy: far.cell, ps: far.cell,
    sizeX: far.cell * (far.width - 1), sizeY: far.cell * (far.height - 1), z: far.data,
  };
}

/**
 * The wind does not see metre-scale roughness (it is buried, and the flow is
 * smooth at that scale): the terrain terms use the DTM smoothed to
 * `windSmoothM`.
 */
export function windTerrain(grid: WorkGrid, config: SnowEngineConfig): { grid: WorkGrid; terrain: TerrainFields } {
  const sigmaPx = config.windSmoothM / grid.ps;
  if (sigmaPx < 0.5) return { grid, terrain: terrainGradients(grid) };
  const smoothed: WorkGrid = { ...grid, z: gaussianSmooth(grid.z, grid.width, grid.height, sigmaPx) };
  return { grid: smoothed, terrain: terrainGradients(smoothed) };
}

export function computeWindPattern(
  sceneGrid: WorkGrid,
  far: FarDem | null,
  frame: SceneFrame,
  rose: WindRose,
  config: SnowEngineConfig,
): WindPattern {
  const { grid, terrain } = windTerrain(sceneGrid, config);
  const sampler = new AltitudeSampler(grid, far);
  const n = grid.width * grid.height;
  const pattern = new Float32Array(n);
  const shelter = new Float32Array(n);
  const sectors = activeSectors(rose);
  const curv = windCurvatures(grid, config);
  const farGrid = far ? farAsGrid(far) : null;
  const farTerrain = farGrid ? terrainGradients(farGrid) : null;
  const farCurv = farGrid ? windCurvatures(farGrid, { ...config, curvatureSmallM: 0 }) : null;
  const farSampler = farGrid ? new AltitudeSampler(farGrid, null) : null;
  const lambda = config.saturationLengthM;

  for (const sector of sectors) {
    const fromGrid = frame.toGridAzimuth(sector.fromTrueDeg);
    const travel = (fromGrid + 180) % 360;
    let inflow: Inflow;
    let fineCap: Float32Array | null = null;
    if (farGrid && farTerrain && farCurv && farSampler && far) {
      const farCap = sectorFields(farGrid, farTerrain, farCurv, farSampler, fromGrid, sector, config).capacity;
      const farRun = marchFlux(far.width, far.height, far.cell, far.cell, farCap, travel, Math.max(lambda, far.cell), (x, y) => farCap[y * far.width + x]);
      inflow = (x, y) => {
        const fx = (x * grid.dx - far.originX) / far.cell;
        const fy = (y * grid.dy - far.originY) / far.cell;
        if (fx < 0 || fy < 0 || fx > far.width - 1 || fy > far.height - 1) return fineCap ? fineCap[y * grid.width + x] : 1;
        return sampleBilinear(farRun.fluxIn, far.width, far.height, fx, fy);
      };
    } else {
      inflow = (x, y) => (fineCap ? fineCap[y * grid.width + x] : 1);
    }
    const fields = sectorFields(grid, terrain, curv, sampler, fromGrid, sector, config);
    fineCap = fields.capacity;
    const run = marchFlux(grid.width, grid.height, grid.dx, grid.dy, fineCap, travel, lambda, inflow);
    for (let i = 0; i < n; i++) {
      pattern[i] += sector.weight * run.deposition[i];
      shelter[i] += sector.weight * fields.exposure[i];
    }
  }
  let meanAbs = 0;
  for (let i = 0; i < n; i++) meanAbs += Math.abs(pattern[i]);
  meanAbs /= n;
  return { pattern, meanAbs, shelter, sectors };
}

/**
 * Applies the wind to the accumulation `acc` (cm) in place, for a flat
 * flux Q0 (cm·m). Two structural hypotheses are blended with equal amplitude:
 * the physical drift flux divergence (additive), and the empirical exposure
 * relation (accumulation × (1 + c·exposure), mass-neutral; Winstral et al.
 * 2002, Grünewald et al. 2013). Erosion cannot strip more than a share of the
 * local snow; deposition is reduced by what could not be eroded.
 * Returns the share of the snow that moved.
 */
export function applyWind(acc: Float32Array, wind: WindPattern, q0: number, config: SnowEngineConfig): number {
  const n = acc.length;
  if (q0 <= 0) return 0;
  let total = 0, weighted = 0, fluxAbs = 0;
  for (let i = 0; i < n; i++) {
    total += acc[i];
    weighted += acc[i] * wind.shelter[i];
    fluxAbs += Math.abs(q0 * wind.pattern[i]);
  }
  if (total <= 0) return 0;
  const centre = weighted / total;
  let statAbs = 0;
  for (let i = 0; i < n; i++) statAbs += acc[i] * Math.abs(wind.shelter[i] - centre);
  const ws = config.windStatisticalWeight;
  const statScale = statAbs > 0 ? fluxAbs / statAbs : 0;
  const delta = new Float32Array(n);
  let pos = 0, neg = 0, negClamped = 0;
  for (let i = 0; i < n; i++) {
    const d = (1 - ws) * q0 * wind.pattern[i] + ws * statScale * acc[i] * (wind.shelter[i] - centre);
    delta[i] = d;
    if (d >= 0) pos += d;
    else {
      neg -= d;
      negClamped += Math.min(-d, config.erosionMaxFraction * acc[i]);
    }
  }
  const posScale = pos > 0 ? Math.max(0, pos - (neg - negClamped)) / pos : 0;
  for (let i = 0; i < n; i++) {
    const d = delta[i];
    if (d >= 0) acc[i] += d * posScale;
    else acc[i] -= Math.min(-d, config.erosionMaxFraction * acc[i]);
  }
  return negClamped / total;
}
