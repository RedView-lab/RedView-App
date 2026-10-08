// ============================================
// Outils du viewer LiDAR — ligne de chute : où va une glissade ou un bloc lâché
// ============================================
//
// Pas seulement la ligne de plus grande pente : ce qu'un corps y fait
// vraiment. Une personne qui glisse est simulée comme un corps qui glisse
// (`fallSlide`) sur quatre types de sol, un bloc lâché avec le modèle
// empirique de la ligne d'énergie :
//
//  - glace / neige très dure  μ 0,08–0,18 (≈ 5–10°) : une glissade ralentit à peine ;
//  - neige ferme, herbe       μ 0,20–0,36 (≈ 11–20°) : vêtements de ski sur
//    mouillée                   neige mesurés à μ 0,19–0,48 (« Kinetic
//                               Friction of Sport Fabrics on Snow »,
//                               Lubricants 2016) ; l'herbe mouillée se couche
//                               vers l'aval sous le corps ;
//  - herbe sèche, neige       μ 0,40–0,62 (≈ 22–32°) : le corps s'enfonce ou
//    molle, éboulis             roule sur les pierres instables, angle de
//                               repos des éboulis ;
//  - rocher (ligne d'énergie) 28,5–37°, médiane 33,5° : part des blocs arrêtés
//    au-delà de 28,5° / 32° / 33,5° = 100 / 72 / 50 % (Onofri & Candian 1979) ;
//    les angles de ligne d'énergie des versants boisés vont de 37 à 44°
//    contre ≈ 36° sans forêt (études Rockyfor3D), d'où +6° en forêt. Les
//    modèles en cône utilisent 27–37° (Jaboyedoff & Labiouse 2011).
//
// Chaque cas est lancé comme un éventail de trajectoires (Monte-Carlo :
// point de départ dans la précision du picking et du MNT, frottement et
// traînée sur toute leur plage, bruit de cap aléatoire représentant le
// micro-relief et les culbutes), si bien que le résultat dit où va une chute
// *et* avec quelle certitude : un départ sur une côte convexe se partage
// entre deux couloirs, une chute au-dessus d'une barre rocheuse la franchit
// dans 90 % des lancers ou dans 10 %. Les conséquences suivent l'échelle
// d'exposition Toponeige des topos de ski de randonnée français (E1 la pente
// elle-même, E2 des obstacles, E3 une barre — mort probable, E4 mort certaine).

import { createRng, simulateSlide, type SlideMode, type SlideParams, type SlideRun, type SlideSample } from './fallSlide';
import type { FallCover } from './fallCover';
import type { TerrainField } from './terrainField';

export type FallScenarioId = 'ice' | 'firm' | 'rough' | 'rock';

export interface FallScenarioSpec {
  id: FallScenarioId;
  mode: SlideMode;
  /** Coefficient de frottement : bas, nominal, haut (roche : angle de la ligne d'énergie, degrés). */
  range: readonly [number, number, number];
  color: string;
}

export const FALL_SCENARIOS: readonly FallScenarioSpec[] = [
  { id: 'ice', mode: 'body', range: [0.08, 0.12, 0.18], color: '#7fd3ff' },
  { id: 'firm', mode: 'body', range: [0.2, 0.28, 0.36], color: '#ffffff' },
  { id: 'rough', mode: 'body', range: [0.4, 0.5, 0.62], color: '#d9b47a' },
  { id: 'rock', mode: 'energyLine', range: [28.5, 33.5, 37], color: '#a9a9a9' },
];

const DEFAULT_FALL_SCENARIO: FallScenarioId = 'firm';

type FallEnd = 'noSlide' | 'runout' | 'trap' | 'water' | 'edge' | 'maxLength';
/** Exposition Toponeige (conséquence d'une chute), `none` quand rien ne glisse. */
export type FallExposure = 'none' | 'E1' | 'E2' | 'E3' | 'E4';

type FallHazardKind = 'cliff' | 'trees' | 'building' | 'rough' | 'water';

interface FallHazard {
  kind: FallHazardKind;
  /** Distance horizontale depuis le départ, m. */
  distanceM: number;
  /** Vitesse en l'atteignant (barre : à l'impact), m/s. */
  speed: number;
  /** Hauteur de la chute (barre), m. */
  heightM?: number;
}

interface FallQuantiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface FallScenarioResult {
  id: FallScenarioId;
  /** Trajectoire nominale (paramètres centraux, sans bruit). */
  samples: SlideSample[];
  end: FallEnd;
  /** Longueur horizontale, m. */
  lengthM: number;
  dropM: number;
  maxSpeed: number;
  /** Pente la plus raide tenue sur 10 m du parcours, en degrés. */
  maxSlopeDeg: number;
  /** Angle moyen de tout le parcours (Fahrböschung), en degrés. */
  pathAngleDeg: number;
  /** Dangers rencontrés par la trajectoire nominale, dans l'ordre du parcours. */
  hazards: FallHazard[];
  /** Longueur horizontale des lancers de l'éventail. */
  runoutM: FallQuantiles;
  runs: number;
  /** Part des lancers qui sortent de la zone chargée (ou de la limite de longueur) : arrêt inconnu. */
  shareBeyond: number;
  /** Part des lancers qui chutent de ≥ 3 / 10 / 30 m. */
  shareFall3: number;
  shareFall10: number;
  shareFall30: number;
  /** Part des lancers qui heurtent des arbres, un bâtiment ou des blocs à ≥ 20 km/h. */
  shareObstacle: number;
  shareWater: number;
  exposure: FallExposure;
  /** Lancers qui traversent chaque cellule du couloir (indice dans `FallLineResult.corridor`). */
  corridor: Map<number, number>;
}

interface FallCorridorLattice {
  /** Centre de la cellule (0, 0) dans le SCR. */
  originX: number;
  originY: number;
  cell: number;
  width: number;
}

export interface FallLineResult {
  origin: { projX: number; projY: number; altitudeM: number };
  /** Pente au départ (base de 6 m), en degrés. */
  startSlopeDeg: number;
  startAspectDeg: number;
  scenarios: FallScenarioResult[];
  corridor: FallCorridorLattice;
  /** Couvert lu dans le nuage de points (arbres, bâtiments, eau) — `false` quand indisponible. */
  coverRead: boolean;
  /** `false` : le nuage n'a pas de classe sol, le modèle de terrain inclut la végétation. */
  groundClassified: boolean | null;
}

/** Trajectoires par surface (la nominale comprise). */
const RUNS_PER_SCENARIO = 48;
/** Points de départ répartis sur ce rayon (précision de position du picking + du MNT), m. */
const START_JITTER_M = 1.5;
/** Bruit de cap de l'éventail, rad par √m. */
const HEADING_NOISE = 0.04;
const MAX_LENGTH_M = 5000;
/** Traînée aérodynamique d'une personne par unité de masse, ρ·Cd·A / 2m avec ρ 1,0, Cd·A 0,25–0,6 m², 75 kg (1/m). */
const BODY_DRAG: readonly [number, number, number] = [0.0017, 0.0027, 0.004];
/** Une forêt relève la ligne d'énergie des blocs de cette valeur, en degrés. */
const FOREST_ENERGY_LINE_DEG = 6;
const CORRIDOR_CELL_M = 2;
/** Les obstacles comptent à partir de cette vitesse (m/s ≈ 20 km/h). */
const OBSTACLE_SPEED = 5.5;
/** Les arbres rencontrés plus lentement ne sont pas signalés (m/s). */
const REPORT_SPEED = 2;
/** Relief résiduel (m RMS autour du plan local sur 2 m) des champs de blocs et des ressauts rocheux. */
const ROUGH_RMS_M = 0.3;
const CLIFF_SLOPE_DEG = 55;
const CLIFF_MIN_DROP_M = 5;
/** Autour d'une chute, le relief est le bord de la barre, pas des blocs (m de parcours). */
const FALL_EDGE_M = 8;
const STEEP_WINDOW_M = 10;
/** Un lancer plus court que ceci n'a pas glissé, m. */
const NO_SLIDE_M = 3;
/** Part de l'éventail à partir de laquelle une conséquence compte. */
const LIKELY_SHARE = 0.2;
const MOST_SHARE = 0.5;
/** Budget de temps entre deux rendus de la main à la page, ms. */
const SLICE_MS = 24;

export interface FallLineOptions {
  cover?: FallCover | null;
  /** Trajectoires par scénario (`RUNS_PER_SCENARIO` par défaut ; 1 = la nominale seule). */
  runs?: number;
  /** Laisse respirer la page entre deux lancers ; se résoudre pour continuer. */
  yieldToPage?: () => Promise<void>;
}

export async function computeFallLine(
  field: TerrainField,
  startX: number,
  startY: number,
  options: FallLineOptions = {},
): Promise<FallLineResult | null> {
  const altitude = field.altitudeAt(startX, startY);
  const slope = field.slopeAt(startX, startY);
  if (altitude == null || !slope) return null;
  const cover = options.cover ?? null;
  const runs = Math.max(1, options.runs ?? RUNS_PER_SCENARIO);
  const corridor: FallCorridorLattice = {
    originX: field.minX + CORRIDOR_CELL_M / 2,
    originY: field.minY + CORRIDOR_CELL_M / 2,
    cell: CORRIDOR_CELL_M,
    width: Math.ceil((field.maxX - field.minX) / CORRIDOR_CELL_M) + 1,
  };
  const seed = (Math.round(startX * 10) * 73856093) ^ (Math.round(startY * 10) * 19349663);
  let sliceStart = performance.now();

  const scenarios: FallScenarioResult[] = [];
  for (const spec of FALL_SCENARIOS) {
    const rng = createRng(seed ^ hashId(spec.id));
    const runStats: RunStats[] = [];
    let nominal: { run: SlideRun; stats: RunStats } | null = null;
    const cells = new Map<number, number>();
    for (let k = 0; k < runs; k++) {
      const jitter = k === 0 ? null : disc(rng, START_JITTER_M);
      const params = k === 0 ? nominalParams(spec) : sampledParams(spec, rng);
      const run = simulateSlide(field, startX + (jitter?.[0] ?? 0), startY + (jitter?.[1] ?? 0), params, k === 0 ? null : rng, cover);
      if (!run) continue;
      const stats = runStatistics(field, run, cover, k === 0);
      runStats.push(stats);
      if (k === 0) nominal = { run, stats };
      markCorridor(run.samples, corridor, cells);
      if (options.yieldToPage && performance.now() - sliceStart > SLICE_MS) {
        await options.yieldToPage();
        sliceStart = performance.now();
      }
    }
    if (!nominal) continue;
    scenarios.push(summarise(spec, nominal.run, nominal.stats, runStats, cells));
  }
  if (scenarios.length === 0) return null;
  return {
    origin: { projX: startX, projY: startY, altitudeM: altitude },
    startSlopeDeg: slope.slopeDeg,
    startAspectDeg: slope.aspectDeg,
    scenarios,
    corridor,
    coverRead: cover != null,
    groundClassified: cover ? cover.groundClassified : null,
  };
}

/**
 * Type de sol dessiné en 3D : neige ferme / herbe mouillée, le cas
 * défavorable courant, sauf si rien n'y glisse — alors le plus glissant sur
 * lequel ça glisse (une pente de 7° tient sur neige ferme mais part sur la glace).
 */
export function displayedFallScenario(result: FallLineResult): FallScenarioId {
  const slides = (id: FallScenarioId) => result.scenarios.some((s) => s.id === id && s.end !== 'noSlide');
  if (slides(DEFAULT_FALL_SCENARIO)) return DEFAULT_FALL_SCENARIO;
  return (['ice', 'rough', 'rock'] as const).find(slides) ?? DEFAULT_FALL_SCENARIO;
}

/** Emprise en plan des trajectoires nominales de tous les scénarios, agrandie de `marginM`. */
export function fallLineBounds(result: FallLineResult, marginM: number) {
  let minX = result.origin.projX;
  let maxX = minX;
  let minY = result.origin.projY;
  let maxY = minY;
  for (const scenario of result.scenarios) {
    for (const s of scenario.samples) {
      if (s.projX < minX) minX = s.projX;
      if (s.projX > maxX) maxX = s.projX;
      if (s.projY < minY) minY = s.projY;
      if (s.projY > maxY) maxY = s.projY;
    }
  }
  return { minX: minX - marginM, minY: minY - marginM, maxX: maxX + marginM, maxY: maxY + marginM };
}

// ── Parameters ─────────────────────────────────────────────────────────────

function toParams(spec: FallScenarioSpec, value: number, drag: number, noise: number): SlideParams {
  if (spec.mode === 'energyLine') {
    const angle = (value * Math.PI) / 180;
    return {
      mode: 'energyLine',
      mu: Math.tan(angle),
      drag: 0,
      muInForest: Math.tan(angle + (FOREST_ENERGY_LINE_DEG * Math.PI) / 180),
      headingNoise: noise,
      maxLengthM: MAX_LENGTH_M,
    };
  }
  return { mode: 'body', mu: value, drag, headingNoise: noise, maxLengthM: MAX_LENGTH_M };
}

function nominalParams(spec: FallScenarioSpec): SlideParams {
  return toParams(spec, spec.range[1], BODY_DRAG[1], 0);
}

function sampledParams(spec: FallScenarioSpec, rng: ReturnType<typeof createRng>): SlideParams {
  const [lo, mode, hi] = spec.range;
  const drag = BODY_DRAG[0] + (BODY_DRAG[2] - BODY_DRAG[0]) * rng.next();
  return toParams(spec, triangular(rng.next(), lo, mode, hi), drag, HEADING_NOISE);
}

function triangular(u: number, lo: number, mode: number, hi: number): number {
  const f = (mode - lo) / (hi - lo);
  return u < f ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
}

function disc(rng: ReturnType<typeof createRng>, radius: number): [number, number] {
  const r = radius * Math.sqrt(rng.next());
  const a = 2 * Math.PI * rng.next();
  return [r * Math.cos(a), r * Math.sin(a)];
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
  return h >>> 0;
}

// ── Un lancer ──────────────────────────────────────────────────────────────

interface RunStats {
  end: FallEnd;
  lengthM: number;
  /** Plus haute chute (vol ou barre rocheuse), m. */
  maxFallM: number;
  /** Arbres, bâtiment ou blocs heurtés à ≥ OBSTACLE_SPEED. */
  obstacle: boolean;
  water: boolean;
  /** Lancer nominal seulement. */
  hazards: FallHazard[];
}

function runStatistics(field: TerrainField, run: SlideRun, cover: FallCover | null, detailed: boolean): RunStats {
  const { samples } = run;
  const last = samples[samples.length - 1]!;
  const hazards: FallHazard[] = [];
  const seen = new Set<FallHazardKind>();
  let maxFallM = 0;
  let obstacle = false;
  let water = false;

  /** Tronçons de parcours en chute : leurs bords ne sont pas un champ de blocs. */
  const falls: Array<[number, number]> = [];
  for (const flight of run.flights) {
    maxFallM = Math.max(maxFallM, flight.dropM);
    falls.push([samples[flight.from]!.distanceM, samples[flight.to]!.distanceM]);
    if (detailed && flight.dropM >= CLIFF_MIN_DROP_M) {
      hazards.push({ kind: 'cliff', distanceM: samples[flight.from]!.distanceM, speed: flight.impactSpeed, heightM: flight.dropM });
    }
  }
  for (const band of cliffBands(samples)) {
    maxFallM = Math.max(maxFallM, band.dropM);
    falls.push([band.distanceM, band.footDistanceM]);
    if (detailed) hazards.push({ kind: 'cliff', distanceM: band.distanceM, speed: band.speed, heightM: band.dropM });
  }
  const nearFall = (d: number) => falls.some(([from, to]) => d >= from - FALL_EDGE_M && d <= to + FALL_EDGE_M);

  for (let k = 0; k < samples.length; k++) {
    const s = samples[k]!;
    if (s.airborne) continue;
    const report = (kind: FallHazardKind) => {
      if (detailed && !seen.has(kind)) {
        seen.add(kind);
        hazards.push({ kind, distanceM: s.distanceM, speed: s.speed });
      }
    };
    if (cover) {
      if (cover.hasWater(s.projX, s.projY)) {
        water = true;
        report('water');
      }
      if (s.speed >= REPORT_SPEED) {
        const tree = cover.hasTree(s.projX, s.projY);
        const building = cover.hasBuilding(s.projX, s.projY);
        if (tree) report('trees');
        if (building) report('building');
        if ((tree || building) && s.speed >= OBSTACLE_SPEED) obstacle = true;
      }
    }
    // Champs de blocs et ressauts rocheux : lus là où le corps va vite (coût).
    if (s.speed >= (detailed ? REPORT_SPEED : OBSTACLE_SPEED) && !nearFall(s.distanceM)
      && roughness(field, s.projX, s.projY) >= ROUGH_RMS_M) {
      report('rough');
      if (s.speed >= OBSTACLE_SPEED) obstacle = true;
    }
  }
  hazards.sort((a, b) => a.distanceM - b.distanceM);

  let end: FallEnd;
  if (run.stop === 'edge') end = 'edge';
  else if (run.stop === 'maxLength') end = 'maxLength';
  else if (last.distanceM < NO_SLIDE_M) end = 'noSlide';
  else if (cover?.hasWater(last.projX, last.projY)) end = 'water';
  else if (isClosedHollow(field, last.projX, last.projY, last.groundM)) end = 'trap';
  else end = 'runout';
  return { end, lengthM: last.distanceM, maxFallM, obstacle, water, hazards };
}

interface CliffBand {
  distanceM: number;
  footDistanceM: number;
  dropM: number;
  speed: number;
}

/** Barres rocheuses franchies au sol (assez raides et hautes ; les vols sont comptés à part). */
function cliffBands(samples: readonly SlideSample[]): CliffBand[] {
  const out: CliffBand[] = [];
  let top: SlideSample | null = null;
  const close = (foot: SlideSample) => {
    if (top && top.groundM - foot.groundM >= CLIFF_MIN_DROP_M) {
      out.push({ distanceM: top.distanceM, footDistanceM: foot.distanceM, dropM: top.groundM - foot.groundM, speed: foot.speed });
    }
    top = null;
  };
  for (const s of samples) {
    if (!s.airborne && s.slopeDeg >= CLIFF_SLOPE_DEG) {
      if (!top) top = s;
      continue;
    }
    if (top) close(s);
  }
  if (top) close(samples[samples.length - 1]!);
  return out;
}

/** Distance RMS (m) du sol à son plan local sur ±1 m : blocs, ressauts. */
function roughness(field: TerrainField, x: number, y: number): number {
  const r = Math.max(1, field.cell);
  const z: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const v = field.altitudeAt(x + dx * r, y + dy * r);
      if (v == null) return 0;
      z.push(v);
    }
  }
  // Plan des moindres carrés sur le pochoir 3 × 3 : moyenne + pentes séparables.
  const mean = z.reduce((a, b) => a + b, 0) / 9;
  const sx = (z[2]! + z[5]! + z[8]! - z[0]! - z[3]! - z[6]!) / 6;
  const sy = (z[6]! + z[7]! + z[8]! - z[0]! - z[1]! - z[2]!) / 6;
  let sum = 0;
  let k = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const d = z[k++]! - (mean + sx * dx + sy * dy);
      sum += d * d;
    }
  }
  return Math.sqrt(sum / 9);
}

/** Le sol remonte autour du point dans (presque) toutes les directions : une cuvette fermée. */
function isClosedHollow(field: TerrainField, x: number, y: number, z: number): boolean {
  const directions = 16;
  let closed = 0;
  for (let k = 0; k < directions; k++) {
    const a = (k / directions) * Math.PI * 2;
    for (let r = 3; r <= 30; r += 3) {
      const v = field.altitudeAt(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (v != null && v >= z + 1) {
        closed++;
        break;
      }
    }
  }
  return closed >= directions - 2;
}

function markCorridor(samples: readonly SlideSample[], lattice: FallCorridorLattice, cells: Map<number, number>): void {
  const mine = new Set<number>();
  const mark = (x: number, y: number) => {
    const col = Math.round((x - lattice.originX) / lattice.cell);
    const row = Math.round((y - lattice.originY) / lattice.cell);
    if (col >= 0 && row >= 0 && col < lattice.width) mine.add(row * lattice.width + col);
  };
  for (let k = 0; k < samples.length; k++) {
    const b = samples[k]!;
    const a = samples[k - 1];
    if (!a) {
      mark(b.projX, b.projY);
      continue;
    }
    const steps = Math.max(1, Math.ceil(Math.hypot(b.projX - a.projX, b.projY - a.projY) / (lattice.cell * 0.5)));
    for (let s = 1; s <= steps; s++) {
      mark(a.projX + ((b.projX - a.projX) * s) / steps, a.projY + ((b.projY - a.projY) * s) / steps);
    }
  }
  for (const i of mine) cells.set(i, (cells.get(i) ?? 0) + 1);
}

// ── Summary ────────────────────────────────────────────────────────────────

function summarise(
  spec: FallScenarioSpec,
  run: SlideRun,
  stats: RunStats,
  all: readonly RunStats[],
  corridor: Map<number, number>,
): FallScenarioResult {
  const samples = run.samples;
  const last = samples[samples.length - 1]!;
  const first = samples[0]!;
  const dropM = first.groundM - last.groundM;
  const n = all.length;
  const share = (test: (s: RunStats) => boolean) => all.filter(test).length / n;
  const lengths = all.map((s) => s.lengthM).sort((a, b) => a - b);
  const quantile = (p: number) => lengths[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))]!;

  const shareFall3 = share((s) => s.maxFallM >= 3);
  const shareFall10 = share((s) => s.maxFallM >= 10);
  const shareFall30 = share((s) => s.maxFallM >= 30);
  const shareObstacle = share((s) => s.obstacle);
  const shareNoSlide = share((s) => s.end === 'noSlide');

  let exposure: FallExposure = 'E1';
  if (shareNoSlide >= MOST_SHARE) exposure = 'none';
  else if (shareFall30 >= MOST_SHARE) exposure = 'E4';
  else if (shareFall10 >= LIKELY_SHARE || shareFall30 >= LIKELY_SHARE) exposure = 'E3';
  else if (shareFall3 >= LIKELY_SHARE || shareObstacle >= LIKELY_SHARE) exposure = 'E2';

  return {
    id: spec.id,
    samples,
    end: stats.end,
    lengthM: last.distanceM,
    dropM,
    maxSpeed: run.maxSpeed,
    maxSlopeDeg: steepestHeldSlope(samples.map((s) => ({ distanceM: s.distanceM, altitudeM: s.groundM })), STEEP_WINDOW_M),
    pathAngleDeg: last.distanceM > 0 ? (Math.atan(dropM / last.distanceM) * 180) / Math.PI : 0,
    hazards: stats.hazards,
    runoutM: { p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9) },
    runs: n,
    shareBeyond: share((s) => s.end === 'edge' || s.end === 'maxLength'),
    shareFall3,
    shareFall10,
    shareFall30,
    shareObstacle,
    shareWater: share((s) => s.water),
    exposure,
    corridor,
  };
}

/** Plus forte pente moyenne sur `window` mètres de distance horizontale. */
export function steepestHeldSlope(
  samples: ReadonlyArray<{ distanceM: number; altitudeM: number }>,
  window: number,
): number {
  let best = 0;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]!;
    if (j < i) j = i;
    while (j < samples.length - 1 && samples[j]!.distanceM - a.distanceM < window) j++;
    const b = samples[j]!;
    const run = b.distanceM - a.distanceM;
    if (run < window * 0.8) break;
    best = Math.max(best, (Math.atan(Math.abs(a.altitudeM - b.altitudeM) / run) * 180) / Math.PI);
  }
  return best;
}
