// ============================================
// LiDAR viewer tools — a body sliding or falling down the ground model
// ============================================
//
// Point mass on the DTM surface z = h(x, y), integrated in plan coordinates
// (exact constrained motion of a bead on a height field):
//
//   a_plan = −∇h · (g + uᵀHu) / (1 + |∇h|²) − F · u / V
//
// u the plan velocity, H the Hessian of h, V the 3D speed and F the
// resistance per unit mass. The normal force per unit mass is
// N = (g + uᵀHu) / √(1 + |∇h|²): curvature presses the body into a
// compression (gully floor, foot of a face) and lifts it off a convex break —
// N < 0 means it leaves the ground and flies until it hits it again.
//
// Two resistance models:
//  - `body` (a person): Coulomb friction μ·N plus air drag k·V² — the
//    sliding-block model of avalanche dynamics (Perla–Cheng–McClung) with a
//    person's drag;
//  - `energyLine` (a falling rock): resistance μ·g per horizontal metre, which
//    is exactly the empirical energy-line ("Fahrböschung") model of rockfall
//    runout: the rock stops where the line drawn from its start at
//    atan(μ) below the horizontal meets the ground.
//
// The speed is carried by the energy balance along the path actually followed
// (V² changes by 2g·drop − 2·work), so DTM noise cannot create energy; the
// dynamics only steer the direction. Gravity turns a slow body into the fall
// line; a fast one carries straight on, rides up the side of a bending gully
// or takes off at a convex edge.

import type { TerrainField } from './terrainField';

const G = 9.81;
/** Baseline of the gradient that steers the body: its own scale, above DTM noise (m). */
const GRADIENT_BASELINE_M = 3;
/**
 * Baseline of the curvature that presses the body into the ground or lifts it
 * off (m). A fast body feels the shape of the ground over metres; on a 1 m
 * baseline, 10 cm of DTM noise would throw a 30 m/s body into the air.
 */
const CURVATURE_BASELINE_M = 8;
/** Plan distance covered per integration step at most (m). */
const STEP_M = 0.5;
/** Path samples kept about every (m). */
const RECORD_M = 1;
const MAX_STEPS = 400_000;
const MAX_TIME_S = 900;
/** Below this speed (m/s) a body on ground gentler than its friction angle has stopped. */
const REST_SPEED = 0.05;
/** A flight is reported from this drop (m): smaller ones are bumps. */
const MIN_REPORTED_FLIGHT_DROP_M = 2;

export type SlideMode = 'body' | 'energyLine';

export interface SlideParams {
  mode: SlideMode;
  /** Friction coefficient (body) or tangent of the energy-line angle (rock). */
  mu: number;
  /** Air drag per unit mass k = ρ·Cd·A / 2m (1/m); 0 for the energy line. */
  drag: number;
  /** Friction in forest cells, when a cover grid is given (rock: trees stop blocks). */
  muInForest?: number;
  /** Random turn of the heading, rad per √m of path (micro-topography, tumbling). */
  headingNoise: number;
  maxLengthM: number;
}

/** Ground cover queried along the path (from the point cloud). */
export interface SlideCover {
  isForest(projX: number, projY: number): boolean;
}

type SlideStop = 'stopped' | 'edge' | 'maxLength';

export interface SlideSample {
  projX: number;
  projY: number;
  /** Altitude of the body (above the ground while it flies), m. */
  altitudeM: number;
  /** Ground altitude under the body, m. */
  groundM: number;
  /** Cumulative horizontal distance, m. */
  distanceM: number;
  /** Time since the release, s. */
  timeS: number;
  /** 3D speed, m/s. */
  speed: number;
  /** Ground slope under the body, degrees. */
  slopeDeg: number;
  airborne: boolean;
}

interface SlideFlight {
  /** Indices of the take-off and landing samples. */
  from: number;
  to: number;
  /** Take-off altitude − landing altitude, m. */
  dropM: number;
  /** Speed at landing, m/s. */
  impactSpeed: number;
}

export interface SlideRun {
  samples: SlideSample[];
  stop: SlideStop;
  flights: SlideFlight[];
  maxSpeed: number;
}

export interface Rng {
  next(): number;
  /** Standard normal deviate. */
  gaussian(): number;
}

/** Deterministic generator (mulberry32): the same click gives the same fan. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    gaussian: () => {
      const u = Math.max(1e-12, next());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
  };
}

export function simulateSlide(
  field: TerrainField,
  startX: number,
  startY: number,
  params: SlideParams,
  rng: Rng | null = null,
  cover: SlideCover | null = null,
): SlideRun | null {
  const z0 = field.altitudeAt(startX, startY);
  if (z0 == null) return null;
  const minDt = 1e-3;
  const step = Math.max(STEP_M, field.cell * 0.5);
  const samples: SlideSample[] = [];
  const flights: SlideFlight[] = [];

  let x = startX;
  let y = startY;
  let z = z0;
  let ux = 0;
  let uy = 0;
  /** Vertical velocity while flying. */
  let w = 0;
  let airborne = false;
  let takeoff = { index: 0, z: 0, kinetic: 0, distance: 0 };
  /** Kinetic energy per unit mass, V²/2. */
  let kinetic = 0;
  let distance = 0;
  let time = 0;
  let maxSpeed = 0;
  let lastRecord = -Infinity;
  let stop: SlideStop = 'maxLength';
  let slopeDeg = 0;

  const muAt = (px: number, py: number) => (params.muInForest != null && cover?.isForest(px, py)
    ? params.muInForest
    : params.mu);
  const record = (force: boolean) => {
    if (!force && distance - lastRecord < RECORD_M) return;
    lastRecord = distance;
    const ground = field.altitudeAt(x, y) ?? z;
    samples.push({
      projX: x,
      projY: y,
      altitudeM: airborne ? z : ground,
      groundM: ground,
      distanceM: distance,
      timeS: time,
      speed: Math.sqrt(2 * kinetic),
      slopeDeg,
      airborne,
    });
  };

  for (let iteration = 0; iteration < MAX_STEPS; iteration++) {
    if (distance >= params.maxLengthM) {
      stop = 'maxLength';
      break;
    }
    if (time > MAX_TIME_S) {
      stop = 'stopped';
      break;
    }

    if (airborne) {
      // Ballistic flight with drag (the energy line keeps counting distance).
      const speed = Math.hypot(ux, uy, w);
      const dt = Math.max(minDt, Math.min(0.05, step / Math.max(speed, 1)));
      const dragAcc = params.drag * speed;
      ux -= dragAcc * ux * dt;
      uy -= dragAcc * uy * dt;
      w -= (G + dragAcc * w) * dt;
      const nx = x + ux * dt;
      const ny = y + uy * dt;
      const nz = z + w * dt;
      const ground = field.altitudeAt(nx, ny);
      if (ground == null) {
        stop = 'edge';
        break;
      }
      distance += Math.hypot(nx - x, ny - y);
      time += dt;
      x = nx;
      y = ny;
      if (nz > ground) {
        z = nz;
        kinetic = 0.5 * (ux * ux + uy * uy + w * w);
        maxSpeed = Math.max(maxSpeed, Math.sqrt(2 * kinetic));
        record(false);
        continue;
      }
      // Landing: the normal velocity is lost; Coulomb friction during the
      // impact takes μ·|v_n| off the tangential speed.
      const s = field.surfaceAt(x, y, GRADIENT_BASELINE_M);
      if (!s) {
        stop = 'edge';
        break;
      }
      const q = Math.sqrt(1 + s.gradX * s.gradX + s.gradY * s.gradY);
      const nX = -s.gradX / q, nY = -s.gradY / q, nZ = 1 / q;
      const vn = ux * nX + uy * nY + w * nZ;
      const tx = ux - vn * nX, ty = uy - vn * nY, tz = w - vn * nZ;
      const vt = Math.hypot(tx, ty, tz);
      const impactSpeed = Math.hypot(ux, uy, w);
      const mu = muAt(x, y);
      // Energy line: the speed is read on the line, whatever the flight did.
      const keep = params.mode === 'body'
        ? Math.max(0, vt - mu * Math.abs(vn))
        : Math.sqrt(Math.max(0, 2 * (takeoff.kinetic + G * (takeoff.z - ground) - mu * G * (distance - takeoff.distance))));
      z = ground;
      const scale = vt > 1e-9 ? keep / vt : 0;
      ux = tx * scale;
      uy = ty * scale;
      w = 0;
      airborne = false;
      kinetic = 0.5 * keep * keep;
      record(true);
      const dropM = takeoff.z - ground;
      if (dropM >= MIN_REPORTED_FLIGHT_DROP_M) {
        flights.push({ from: takeoff.index, to: samples.length - 1, dropM, impactSpeed });
      }
      continue;
    }

    const s = field.surfaceAt(x, y, GRADIENT_BASELINE_M);
    const c = field.surfaceAt(x, y, CURVATURE_BASELINE_M);
    if (!s || !c) {
      stop = 'edge';
      break;
    }
    const gx = s.gradX;
    const gy = s.gradY;
    const grad2 = gx * gx + gy * gy;
    const q = 1 + grad2;
    slopeDeg = (Math.atan(Math.sqrt(grad2)) * 180) / Math.PI;
    const mu = muAt(x, y);

    let speed = Math.sqrt(2 * kinetic);
    if (speed < REST_SPEED) {
      // At rest: static friction holds below the friction angle.
      if (Math.sqrt(grad2) <= mu) {
        stop = 'stopped';
        record(true);
        break;
      }
      ux = 0;
      uy = 0;
      kinetic = 0;
      speed = 0;
    }
    record(samples.length === 0);

    const uHu = c.hxx * ux * ux + 2 * c.hxy * ux * uy + c.hyy * uy * uy;
    const pressure = G + uHu;
    if (pressure < 0 && speed > 1) {
      // Convex edge too sharp for the speed: the body leaves the ground.
      airborne = true;
      w = gx * ux + gy * uy;
      takeoff = { index: samples.length, z, kinetic, distance };
      record(true);
      continue;
    }
    const normal = Math.max(0, pressure) / Math.sqrt(q);

    const dt = Math.max(minDt, Math.min(0.25, step / Math.max(speed, 0.5)));
    // Gravity and the surface reaction (frictionless constrained motion).
    let nux = ux - (pressure * gx / q) * dt;
    let nuy = uy - (pressure * gy / q) * dt;
    if (params.headingNoise > 0 && rng) {
      const plan = Math.hypot(nux, nuy);
      const turn = rng.gaussian() * params.headingNoise * Math.sqrt(Math.max(1e-6, plan * dt));
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const rx = nux * cos - nuy * sin;
      nuy = nux * sin + nuy * cos;
      nux = rx;
    }
    const nx = x + nux * dt;
    const ny = y + nuy * dt;
    const nz = field.altitudeAt(nx, ny);
    if (nz == null) {
      stop = 'edge';
      break;
    }
    const run = Math.hypot(nx - x, ny - y);
    const path3 = Math.hypot(run, nz - z);
    // Energy balance over the step actually taken.
    const work = params.mode === 'body'
      ? (mu * normal + params.drag * 2 * kinetic) * path3
      : mu * G * run;
    const nextKinetic = kinetic + G * (z - nz) - work;
    distance += run;
    time += dt;
    x = nx;
    y = ny;
    z = nz;
    if (nextKinetic <= 0) {
      // Stopped within the step (friction, or climbing a counter-slope).
      kinetic = 0;
      ux = 0;
      uy = 0;
      continue;
    }
    kinetic = nextKinetic;
    const v = Math.sqrt(2 * kinetic);
    maxSpeed = Math.max(maxSpeed, v);
    // Plan speed of a 3D speed v moving along the surface in this direction.
    const plan = Math.hypot(nux, nuy);
    if (plan < 1e-9) {
      ux = 0;
      uy = 0;
      continue;
    }
    const dirX = nux / plan;
    const dirY = nuy / plan;
    const along = gx * dirX + gy * dirY;
    const planSpeed = v / Math.sqrt(1 + along * along);
    ux = dirX * planSpeed;
    uy = dirY * planSpeed;
  }
  if (samples.length === 0 || samples[samples.length - 1]!.distanceM < distance) record(true);
  if (stop === 'maxLength' && distance < params.maxLengthM && time <= MAX_TIME_S) stop = 'stopped';
  return { samples, stop, flights, maxSpeed };
}
