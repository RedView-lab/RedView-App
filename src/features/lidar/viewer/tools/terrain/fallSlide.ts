// ============================================
// Outils du viewer LiDAR — un corps qui glisse ou chute sur le modèle de sol
// ============================================
//
// Masse ponctuelle sur la surface du MNT z = h(x, y), intégrée en coordonnées
// planes (mouvement contraint exact d'une perle sur un champ de hauteurs) :
//
//   a_plan = −∇h · (g + uᵀHu) / (1 + |∇h|²) − F · u / V
//
// u la vitesse en plan, H la hessienne de h, V la vitesse 3D et F la
// résistance par unité de masse. La force normale par unité de masse est
// N = (g + uᵀHu) / √(1 + |∇h|²) : la courbure plaque le corps dans une
// compression (fond de ravine, pied de versant) et le décolle d'une rupture
// convexe — N < 0 signifie qu'il quitte le sol et vole jusqu'à le retoucher.
//
// Deux modèles de résistance :
//  - `body` (une personne) : frottement de Coulomb μ·N plus traînée de l'air
//    k·V² — le modèle de bloc glissant de la dynamique des avalanches
//    (Perla–Cheng–McClung) avec la traînée d'une personne ;
//  - `energyLine` (un rocher qui tombe) : résistance μ·g par mètre horizontal,
//    ce qui est exactement le modèle empirique de la ligne d'énergie
//    (« Fahrböschung ») des distances d'arrêt des chutes de pierres : le rocher
//    s'arrête là où la ligne tirée depuis son départ à atan(μ) sous l'horizontale
//    rencontre le sol.
//
// La vitesse est portée par le bilan d'énergie le long de la trajectoire
// réellement suivie (V² varie de 2g·dénivelé − 2·travail) : le bruit du MNT ne
// peut pas créer d'énergie ; la dynamique ne fait qu'orienter la direction. La
// gravité ramène un corps lent dans la ligne de pente ; un rapide file tout
// droit, remonte le flanc d'une ravine qui tourne ou décolle d'une arête convexe.

import type { TerrainField } from './terrainField';

const G = 9.81;
/** Base du gradient qui oriente le corps : sa propre échelle, au-dessus du bruit du MNT (m). */
const GRADIENT_BASELINE_M = 3;
/**
 * Base de la courbure qui plaque le corps au sol ou le décolle (m). Un corps
 * rapide sent la forme du sol sur des mètres ; sur une base de 1 m, 10 cm de
 * bruit du MNT projetteraient en l'air un corps à 30 m/s.
 */
const CURVATURE_BASELINE_M = 8;
/** Distance en plan maximale parcourue par pas d'intégration (m). */
const STEP_M = 0.5;
/** Échantillons de trajectoire gardés environ tous les (m). */
const RECORD_M = 1;
const MAX_STEPS = 400_000;
const MAX_TIME_S = 900;
/** Sous cette vitesse (m/s), un corps sur un sol moins raide que son angle de frottement s'est arrêté. */
const REST_SPEED = 0.05;
/** Un vol est signalé à partir de cette chute (m) : les plus petites sont des bosses. */
const MIN_REPORTED_FLIGHT_DROP_M = 2;

export type SlideMode = 'body' | 'energyLine';

export interface SlideParams {
  mode: SlideMode;
  /** Coefficient de frottement (corps) ou tangente de l'angle de la ligne d'énergie (roche). */
  mu: number;
  /** Traînée de l'air par unité de masse k = ρ·Cd·A / 2m (1/m) ; 0 pour la ligne d'énergie. */
  drag: number;
  /** Frottement dans les cellules de forêt, quand une grille de couvert est fournie (roche : les arbres arrêtent les blocs). */
  muInForest?: number;
  /** Rotation aléatoire du cap, rad par √m de trajectoire (micro-topographie, rebonds). */
  headingNoise: number;
  maxLengthM: number;
}

/** Couvert du sol interrogé le long de la trajectoire (d'après le nuage de points). */
export interface SlideCover {
  isForest(projX: number, projY: number): boolean;
}

type SlideStop = 'stopped' | 'edge' | 'maxLength';

export interface SlideSample {
  projX: number;
  projY: number;
  /** Altitude du corps (au-dessus du sol pendant qu'il vole), m. */
  altitudeM: number;
  /** Altitude du sol sous le corps, m. */
  groundM: number;
  /** Distance horizontale cumulée, m. */
  distanceM: number;
  /** Temps depuis le départ, s. */
  timeS: number;
  /** 3D speed, m/s. */
  speed: number;
  /** Pente du sol sous le corps, degrés. */
  slopeDeg: number;
  airborne: boolean;
}

interface SlideFlight {
  /** Indices des échantillons de décollage et d'atterrissage. */
  from: number;
  to: number;
  /** Altitude de décollage − altitude d'atterrissage, m. */
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
  /** Variable normale centrée réduite. */
  gaussian(): number;
}

/** Générateur déterministe (mulberry32) : le même clic donne le même éventail. */
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
  /** Vitesse verticale pendant le vol. */
  let w = 0;
  let airborne = false;
  let takeoff = { index: 0, z: 0, kinetic: 0, distance: 0 };
  /** Énergie cinétique par unité de masse, V²/2. */
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
      // Vol balistique avec traînée (la ligne d'énergie continue de compter la distance).
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
      // Atterrissage : la vitesse normale est perdue ; le frottement de Coulomb
      // pendant l'impact retire μ·|v_n| à la vitesse tangentielle.
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
      // Ligne d'énergie : la vitesse est lue sur la ligne, quoi qu'ait fait le vol.
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
      // À l'arrêt : le frottement statique tient sous l'angle de frottement.
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
      // Arête convexe trop vive pour la vitesse : le corps quitte le sol.
      airborne = true;
      w = gx * ux + gy * uy;
      takeoff = { index: samples.length, z, kinetic, distance };
      record(true);
      continue;
    }
    const normal = Math.max(0, pressure) / Math.sqrt(q);

    const dt = Math.max(minDt, Math.min(0.25, step / Math.max(speed, 0.5)));
    // Gravité et réaction de la surface (mouvement contraint sans frottement).
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
    // Bilan d'énergie sur le pas réellement effectué.
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
      // Arrêté dans le pas (frottement, ou remontée d'une contre-pente).
      kinetic = 0;
      ux = 0;
      uy = 0;
      continue;
    }
    kinetic = nextKinetic;
    const v = Math.sqrt(2 * kinetic);
    maxSpeed = Math.max(maxSpeed, v);
    // Vitesse en plan d'une vitesse 3D v se déplaçant le long de la surface dans cette direction.
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
