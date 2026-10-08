// ============================================
// Outils du viewer LiDAR — écoulement avalancheux Flow-Py, visé sur un point
// ============================================
//
// Portage du modèle cellulaire Flow-Py (D'Amboise et al., 2022 ; com4FlowPy
// dans AvaFrame) : chaque cellule de départ envoie un « flux » unitaire vers
// le bas de la grille.
//  - Ligne d'énergie : d'une cellule à sa voisine n, la hauteur d'énergie
//    cinétique zδ_n = zδ + (z − z_n) − tan α · s_n (s_n le pas en plan) —
//    l'écoulement s'arrête là où la ligne tracée depuis le départ à l'angle α
//    rencontre le sol ; zδ est plafonnée à 270 m (≈ 73 m/s) et représente la
//    vitesse (v ≈ √(2 g zδ)).
//  - Routage : directions d'écoulement multiples de Holmgren (1994),
//    T_n ∝ tan(φ_n)^8 avec φ_n = (ψ_n + 90°) / 2 (ψ_n l'angle de descente vers
//    n : les pas plats ou en légère montée restent possibles), multiplié par
//    la persistance — le zδ des parents poussé tout droit et, à 0,707, vers
//    les deux directions voisines — si bien qu'un écoulement rapide garde son
//    cap, traverse les replats et remonte les contre-pentes.
//  - Un flux inférieur à 0,003 n'est plus routé : il va aux voisines routées.
//  - Forêt (FSI = couvert / 100) : α augmente jusqu'à 10°·FSI (au moins 2°)
//    pour un écoulement lent, l'effet s'estompant vers 30 m/s ; une petite
//    part du flux est retenue dans chaque cellule.
// Les cellules sont traitées génération par génération ; une cellule atteinte
// de nouveau par une génération non traitée cumule le flux, les parents et le
// plus grand zδ.
//
// Les cellules de départ sont lancées une à une et indépendamment, comme dans
// Flow-Py, mais seules celles qui peuvent atteindre la cible sont lancées.
// L'énergie dont un écoulement a besoin dans une cellule pour y arriver
// encore, E(x) = max(0, min_n E(n) − (z_x − z_n) + tan α·s), est résolue une
// fois à rebours depuis la cible (tout chemin et tout cap ; la forêt ne fait
// qu'augmenter α : c'est un minorant) ; une cellule de départ commence avec
// zδ = 0, donc une cellule où E > 0 ne peut jamais y arriver. Cela écarte les
// autres couloirs et l'autre versant des crêtes sans changer le résultat. Au
// cours d'un lancement, une cellule qui arrive avec zδ < E n'alimente que des
// cellules elles aussi à court d'énergie : le lancement s'arrête dès qu'aucune
// cellule en attente n'en a assez (les cellules à court d'énergie sont tout de
// même traitées jusque-là : leur flux, donc le routage, rejoint des cellules
// qui peuvent y arriver). Les chemins qui atteignent la cible sont remontés
// jusqu'à leur cellule de départ (le rétro-calcul de Flow-Py) pour l'affichage.

import {
  FLOWPY_EXPONENT,
  FLOWPY_FLUX_THRESHOLD,
  FLOWPY_FOREST_DETRAINMENT,
  FLOWPY_FOREST_FRICTION,
  FLOWPY_MAX_Z_DELTA_M,
} from './params';

const G = 9.81;
/** Neighbours in ring order: opposite = k + 4, ring neighbours = k ± 1. */
const DC = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DR = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const DS = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2] as const;
/** Flux minimal qu'une cellule garde après la rétention (plancher de Flow-Py). */
const MIN_FLUX_AFTER_DETRAINMENT = 0.0003;
/** Plafond du nombre de cellules suivies depuis une cellule de départ (grilles pathologiques). */
const MAX_RECORDS_PER_START = 300_000;
/**
 * Plafond du nombre de cellules suivies sur tout un lancement (≈ 10 s d'un
 * cœur à ~0,2 µs par cellule, 2026-10-06) : les cellules de départ les plus
 * basses sont laissées de côté.
 */
export const MAX_RECORDS_PER_RUN = 56_000_000;

export interface FlowPyGrid {
  width: number;
  height: number;
  cell: number;
  altitude: Float32Array;
}

/** Termes ne dépendant que du terrain, partagés par tous les lancements sur une grille. */
export interface FlowPyTerrain {
  /** La cellule et ses 8 voisines ont du sol (Flow-Py saute les cellules voisines de l'absence de données). */
  interior: Uint8Array;
  /** Poids de Holmgren tan(φ)^exp vers chaque voisine, 8 par cellule. */
  routing: Float32Array;
}

export interface FlowPyTarget {
  /** Cellules de la grille comptées comme « le point » (un petit disque autour). */
  cells: Int32Array;
}

export interface FlowPyRun {
  alphaDeg: number;
  /** Suit chaque lancement jusqu'au bout (pas d'arrêt anticipé) : référence pour les contrôles. */
  exhaustive?: boolean;
  /** Indice de structure forestière par cellule (0–1), `null` sans données de forêt. */
  fsi: Float32Array | null;
  /** Cellules de départ (1) du scénario. */
  release: Uint8Array;
}

export interface FlowPyResult {
  /** Cellules de départ dont l'écoulement atteint la cible. */
  startCells: Int32Array;
  /** Angle de parcours du chemin d'écoulement à la cible pour chacune d'elles, en degrés. */
  startTravelAngleDeg: Float32Array;
  /** Plus grand angle de parcours d'un chemin d'écoulement à la cible, en degrés (`null` : non atteinte). */
  travelAngleDeg: number | null;
  /** Plus grande hauteur d'énergie cinétique à la cible, m. */
  zDeltaM: number | null;
  /** Plus grand flux de routage cumulé sur les cellules de départ, dans une cellule de la cible (routFluxSum). */
  routFluxSum: number;
  /** Cellules des chemins d'écoulement qui mènent à la cible, avec leur plus grand zδ (m). */
  pathCells: Int32Array;
  pathZDelta: Float32Array;
  /** Cellules de départ dont la ligne d'énergie peut atteindre la cible. */
  candidates: number;
  /** Cells processed over all release cells (cost). */
  processed: number;
  /** Le lancement s'est arrêté à son plafond de coût avant les cellules de départ les plus basses. */
  incomplete: boolean;
}

export function prepareFlowPyTerrain(grid: FlowPyGrid): FlowPyTerrain {
  const { width, height, cell, altitude } = grid;
  const count = width * height;
  const interior = new Uint8Array(count);
  const routing = new Float32Array(count * 8);
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const i = row * width + col;
      const z = altitude[i]!;
      if (!Number.isFinite(z)) continue;
      let ok = true;
      for (let k = 0; k < 8; k++) {
        const zn = altitude[i + DR[k]! * width + DC[k]!]!;
        if (!Number.isFinite(zn)) {
          ok = false;
          break;
        }
        // φ = (ψ + 90°) / 2, ψ l'angle de descente vers la voisine.
        const phi = (Math.atan((z - zn) / (DS[k]! * cell)) + Math.PI / 2) / 2;
        routing[i * 8 + k] = Math.pow(Math.tan(phi), FLOWPY_EXPONENT);
      }
      if (ok) interior[i] = 1;
    }
  }
  return { interior, routing };
}

/** Stockage extensible des enregistrements de l'écoulement d'une cellule de départ (réutilisé d'une cellule à l'autre). */
class Records {
  capacity = 0;
  cell = new Int32Array(0);
  flux = new Float64Array(0);
  zDelta = new Float64Array(0);
  minDist = new Float64Array(0);
  firstParent = new Int32Array(0);
  /** Compté parmi les enregistrements en attente qui ont encore l'énergie d'atteindre la cible. */
  viable = new Uint8Array(0);
  edgeHead = new Int32Array(0);
  edgeCapacity = 0;
  edgeParent = new Int32Array(0);
  /** Direction du pas parent → enregistrement. */
  edgeDir = new Int8Array(0);
  edgeNext = new Int32Array(0);
  count = 0;
  edges = 0;

  reset(): void {
    this.count = 0;
    this.edges = 0;
  }

  add(cell: number, flux: number, zDelta: number, parent: number, dir: number): number {
    if (this.count === this.capacity) this.grow();
    const r = this.count++;
    this.cell[r] = cell;
    this.flux[r] = flux;
    this.zDelta[r] = zDelta;
    this.minDist[r] = 0;
    this.firstParent[r] = parent;
    this.viable[r] = 0;
    this.edgeHead[r] = -1;
    if (parent >= 0) this.addParent(r, parent, dir);
    return r;
  }

  addParent(record: number, parent: number, dir: number): void {
    if (this.edges === this.edgeCapacity) {
      this.edgeCapacity = Math.max(4096, this.edgeCapacity * 2);
      this.edgeParent = grown(this.edgeParent, this.edgeCapacity);
      this.edgeDir = grown(this.edgeDir, this.edgeCapacity);
      this.edgeNext = grown(this.edgeNext, this.edgeCapacity);
    }
    const e = this.edges++;
    this.edgeParent[e] = parent;
    this.edgeDir[e] = dir;
    this.edgeNext[e] = this.edgeHead[record]!;
    this.edgeHead[record] = e;
  }

  private grow(): void {
    this.capacity = Math.max(4096, this.capacity * 2);
    this.cell = grown(this.cell, this.capacity);
    this.flux = grown(this.flux, this.capacity);
    this.zDelta = grown(this.zDelta, this.capacity);
    this.minDist = grown(this.minDist, this.capacity);
    this.firstParent = grown(this.firstParent, this.capacity);
    this.viable = grown(this.viable, this.capacity);
    this.edgeHead = grown(this.edgeHead, this.capacity);
  }
}

function grown<T extends Int8Array | Uint8Array | Int32Array | Float64Array>(array: T, capacity: number): T {
  const next = new (array.constructor as new (n: number) => T)(capacity);
  next.set(array);
  return next;
}

/**
 * Énergie (m de zδ) dont un écoulement a besoin dans chaque cellule pour
 * atteindre encore la cible sur une ligne d'énergie de pente `tanAlpha`
 * (tout chemin, tout cap) ; Infinity là où même le plafond de 270 m ne
 * suffit pas.
 */
function energyToReach(grid: FlowPyGrid, terrain: FlowPyTerrain, targetCells: Int32Array, tanAlpha: number): Float32Array {
  const { width, cell, altitude } = grid;
  const count = altitude.length;
  const need = new Float32Array(count).fill(Infinity);
  const queued = new Uint8Array(count);
  const queue = new Int32Array(count + 1);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    queued[i] = 1;
    queue[tail] = i;
    tail = tail === count ? 0 : tail + 1;
  };
  for (const i of targetCells) {
    need[i] = 0;
    push(i);
  }
  // Recherche à correction d'étiquettes (les coûts des arêtes peuvent être
  // négatifs en descente ; tout cycle coûte tan α · longueur > 0, donc elle
  // converge).
  while (head !== tail) {
    const n = queue[head]!;
    head = head === count ? 0 : head + 1;
    queued[n] = 0;
    const needN = need[n]!;
    const zn = altitude[n]!;
    for (let k = 0; k < 8; k++) {
      // x → n est le pas de direction k depuis x, c'est-à-dire que x se trouve en −k depuis n.
      const x = n - DR[k]! * width - DC[k]!;
      if (x < 0 || x >= count || !terrain.interior[x]) continue;
      if (Math.abs((x % width) - (n % width)) > 1) continue;
      let required = needN - (altitude[x]! - zn) + tanAlpha * DS[k]! * cell;
      if (required < 0) required = 0;
      if (required > FLOWPY_MAX_Z_DELTA_M || required >= need[x]! - 1e-6) continue;
      need[x] = required;
      if (!queued[x]) push(x);
    }
  }
  return need;
}

/** Cellules de départ d'un lancement qui peuvent atteindre la cible, et l'énergie dont elles ont besoin en chemin. */
export interface FlowPyPlan {
  /** Cellules de départ dont la ligne d'énergie peut atteindre la cible, les plus hautes d'abord (ordre de Flow-Py). */
  starts: Int32Array;
  /** Énergie dont un écoulement a besoin dans chaque cellule pour atteindre encore la cible (voir `energyToReach`). */
  need: Float32Array;
}

export function planFlowPyRun(grid: FlowPyGrid, terrain: FlowPyTerrain, target: FlowPyTarget, run: FlowPyRun): FlowPyPlan {
  const { altitude } = grid;
  const tanAlpha = Math.tan((run.alphaDeg * Math.PI) / 180);
  const need = energyToReach(grid, terrain, target.cells, tanAlpha);
  const starts: number[] = [];
  for (let i = 0; i < altitude.length; i++) if (run.release[i] && terrain.interior[i] && need[i]! <= 0) starts.push(i);
  starts.sort((a, b) => altitude[b]! - altitude[a]!);
  return { starts: Int32Array.from(starts), need };
}

/**
 * Cellules de départ par bloc. Chaque cellule de départ est lancée seule, donc
 * un bloc peut tourner n'importe où (un autre worker) ; les blocs sont
 * fusionnés dans l'ordre des départs, ce qui donne exactement le résultat
 * séquentiel, quel que soit ce qui les a exécutés.
 */
export const FLOWPY_BLOCK_STARTS = 64;

/** Ce que les cellules de départ `starts[from, to)` d'un plan apportent à un lancement. */
export interface FlowPyBlock {
  from: number;
  to: number;
  /** Cells processed (cost). */
  processed: number;
  /** Cellules de départ qui atteignent la cible, dans l'ordre des départs, et leur angle de parcours à la cible. */
  startCells: Int32Array;
  startAngles: Float64Array;
  /** Plus grand zδ d'un enregistrement de la cible atteint (-Infinity : aucun). */
  bestZDelta: number;
  /** Flux à la cible, enregistrement par enregistrement (cumulés dans cet ordre) : cellule et flux. */
  fluxCells: Int32Array;
  fluxValues: Float64Array;
  /** Cellules des chemins dans l'ordre de première apparition dans le bloc, avec leur plus grand zδ. */
  pathCells: Int32Array;
  pathZDelta: Float32Array;
}

/** Exécute des blocs de cellules de départ d'un plan (garde sa mémoire de travail d'un bloc à l'autre). */
export type FlowPyBlockRunner = (from: number, to: number) => FlowPyBlock;

export function createFlowPyBlockRunner(
  grid: FlowPyGrid,
  terrain: FlowPyTerrain,
  target: FlowPyTarget,
  run: FlowPyRun,
  plan: FlowPyPlan,
): FlowPyBlockRunner {
  const { width, cell, altitude } = grid;
  const count = altitude.length;
  const tanAlpha = Math.tan((run.alphaDeg * Math.PI) / 180);
  const { fsi } = run;
  const { interior, routing: routeWeight } = terrain;
  const { starts, need } = plan;

  const isTarget = new Uint8Array(count);
  for (const i of target.cells) isTarget[i] = 1;

  const records = new Records();
  const pendingOf = new Int32Array(count).fill(-1);
  const touched: number[] = [];
  const pathZDelta = new Float32Array(count);

  const zdn = new Float64Array(8);
  const persistence = new Float64Array(8);
  const routing = new Float64Array(8);
  const dist = new Float64Array(8);
  const order = new Int8Array(8);
  const reached: number[] = [];
  // Par direction : décalage d'indice vers la voisine et pas en plan (m).
  const offset = new Int32Array(8);
  const step = new Float64Array(8);
  for (let k = 0; k < 8; k++) {
    offset[k] = DR[k]! * width + DC[k]!;
    step[k] = DS[k]! * cell;
  }

  const noFrictionZ = (FLOWPY_FOREST_FRICTION.velocityLimit ** 2) / (Math.SQRT2 * G);
  const noDetrainmentZ = (FLOWPY_FOREST_DETRAINMENT.velocityLimit ** 2) / (Math.SQRT2 * G);

  return (from, to) => {
    const startCells: number[] = [];
    const startAngles: number[] = [];
    const fluxCells: number[] = [];
    const fluxValues: number[] = [];
    const pathCells: number[] = [];
    let bestZDelta = -Infinity;
    let processed = 0;

    for (let s = from; s < to; s++) {
      const start = starts[s]!;
      records.reset();
      for (const i of touched) pendingOf[i] = -1;
      touched.length = 0;
      reached.length = 0;
      const startZ = altitude[start]!;
      records.add(start, 1, 0, -1, 0);
      records.viable[0] = 1;
      let viable = 1;
      let startAngle = -Infinity;

      for (let r = 0; r < records.count; r++) {
        // Plus aucune cellule en attente n'a l'énergie d'y arriver : une cellule
        // à court d'énergie n'alimente que des cellules à court d'énergie, donc
        // rien d'autre ne peut atteindre la cible.
        if (viable === 0 && !run.exhaustive) break;
        const i = records.cell[r]!;
        if (pendingOf[i] === r) pendingOf[i] = -1;
        if (records.viable[r]) viable--;
        const z = altitude[i]!;
        const zDelta = records.zDelta[r]!;
        const isStart = r === 0;

        // Plus court chemin en plan depuis la cellule de départ (angle de parcours).
        if (!isStart) {
          let best = Infinity;
          for (let e = records.edgeHead[r]!; e >= 0; e = records.edgeNext[e]!) {
            const d = records.minDist[records.edgeParent[e]!]! + step[records.edgeDir[e]!]!;
            if (d < best) best = d;
          }
          records.minDist[r] = best;
        }

        // Ligne d'énergie vers chaque voisine, α augmenté en forêt (jamais à la cellule de départ).
        const forest = fsi ? fsi[i]! : 0;
        let alphaTan = tanAlpha;
        if (!isStart && forest > 0) {
          const { maxAddedDeg, minAddedDeg } = FLOWPY_FOREST_FRICTION;
          let added: number = minAddedDeg;
          if (zDelta < noFrictionZ) {
            const rest = maxAddedDeg * forest;
            const slope = (rest - minAddedDeg) / -noFrictionZ;
            added = Math.max(minAddedDeg, slope * zDelta + rest);
          }
          alphaTan = Math.tan(((run.alphaDeg + added) * Math.PI) / 180);
        }

        // Persistance : l'écoulement garde le cap avec lequel il est arrivé.
        const firstParent = records.firstParent[r]!;
        if (isStart || firstParent === 0) {
          for (let k = 0; k < 8; k++) persistence[k] = 1;
        } else {
          for (let k = 0; k < 8; k++) persistence[k] = 0;
          let blocked = 0;
          for (let e = records.edgeHead[r]!; e >= 0; e = records.edgeNext[e]!) {
            const ahead = records.edgeDir[e]!;
            const weight = records.zDelta[records.edgeParent[e]!]!;
            blocked |= 1 << ((ahead + 4) & 7); // jamais vers un parent
            persistence[ahead]! += weight;
            persistence[(ahead + 1) & 7]! += 0.707 * weight;
            persistence[(ahead + 7) & 7]! += 0.707 * weight;
          }
          for (let k = 0; k < 8; k++) if (blocked & (1 << k)) persistence[k] = 0;
        }

        // Hauteur d'énergie à chaque voisine, puis routage selon le terrain
        // (Holmgren) multiplié par la persistance sur les voisines atteignables.
        let weighted = 0;
        for (let k = 0; k < 8; k++) {
          const value = zDelta + (z - altitude[i + offset[k]!]!) - step[k]! * alphaTan;
          const zk = value < 0 ? 0 : value > FLOWPY_MAX_Z_DELTA_M ? FLOWPY_MAX_Z_DELTA_M : value;
          zdn[k] = zk;
          const p = persistence[k]!;
          const weight = zk > 0 && p > 0 ? routeWeight[i * 8 + k]! * p : 0;
          routing[k] = weight;
          weighted += weight;
        }

        let flux = records.flux[r]!;
        if (!isStart) {
          if (fsi) {
            // Rétention (dans chaque cellule d'un lancement qui a une couche de forêt, comme dans Flow-Py).
            const { max, min } = FLOWPY_FOREST_DETRAINMENT;
            const rest = max * forest;
            const slope = (rest - min) / -noDetrainmentZ;
            flux = Math.max(MIN_FLUX_AFTER_DETRAINMENT, flux - Math.max(min, slope * zDelta + rest));
            records.flux[r] = flux;
          }
          if (isTarget[i]) {
            const angle = (Math.atan((startZ - z) / records.minDist[r]!) * 180) / Math.PI;
            if (angle > startAngle) startAngle = angle;
          }
        } else if (isTarget[i]) {
          startAngle = Math.max(startAngle, 0);
        }
        if (isTarget[i]) {
          reached.push(r);
          fluxCells.push(i);
          fluxValues.push(flux);
          if (zDelta > bestZDelta) bestZDelta = zDelta;
        }

        // Répartition R_n = T_n·P_n / Σ(T·P) · flux ; les parts sous le seuil vont aux autres.
        if (weighted <= 0) continue;
        let kept = 0;
        let below = 0;
        for (let k = 0; k < 8; k++) {
          dist[k] = (routing[k]! / weighted) * flux;
          if (dist[k]! >= FLOWPY_FLUX_THRESHOLD) kept++;
          else below += dist[k]!;
        }
        if (kept === 0) continue; // tout se dépose ici
        let total = 0;
        for (let k = 0; k < 8; k++) {
          if (dist[k]! >= FLOWPY_FLUX_THRESHOLD) dist[k]! += below / kept;
          else dist[k] = 0;
          total += dist[k]!;
        }
        if (total !== flux) {
          const correction = (flux - total) / kept;
          for (let k = 0; k < 8; k++) if (dist[k]! > 0) dist[k]! += correction;
        }

        // Enfants, plus petit zδ d'abord (ordre de Flow-Py) : tri par insertion
        // stable des directions qui reçoivent une part (trier les 8 puis sauter
        // les autres donne le même ordre : zδ est fini autour d'une cellule
        // intérieure).
        let routed = 0;
        for (let k = 0; k < 8; k++) {
          if (dist[k]! < FLOWPY_FLUX_THRESHOLD) continue;
          let j = routed++;
          while (j > 0 && zdn[order[j - 1]!]! > zdn[k]!) {
            order[j] = order[j - 1]!;
            j--;
          }
          order[j] = k;
        }
        for (let o = 0; o < routed; o++) {
          const k = order[o]!;
          const share = dist[k]!;
          const n = i + offset[k]!;
          const pending = pendingOf[n]!;
          if (pending > r) {
            records.flux[pending]! += share;
            records.addParent(pending, r, k);
            if (zdn[k]! > records.zDelta[pending]!) {
              records.zDelta[pending] = zdn[k]!;
              if (!records.viable[pending] && zdn[k]! >= need[n]! - 1e-6) {
                records.viable[pending] = 1;
                viable++;
              }
            }
            continue;
          }
          if (!interior[n] || records.count >= MAX_RECORDS_PER_START) continue;
          const child = records.add(n, share, zdn[k]!, r, k);
          pendingOf[n] = child;
          touched.push(n);
          if (zdn[k]! >= need[n]! - 1e-6) {
            records.viable[child] = 1;
            viable++;
          }
        }
      }


      processed += records.count;
      if (reached.length === 0) continue;
      startCells.push(start);
      startAngles.push(startAngle);
      traceBack(records, reached, pathZDelta, pathCells);
    }

    const block: FlowPyBlock = {
      from,
      to,
      processed,
      startCells: Int32Array.from(startCells),
      startAngles: Float64Array.from(startAngles),
      bestZDelta,
      fluxCells: Int32Array.from(fluxCells),
      fluxValues: Float64Array.from(fluxValues),
      pathCells: Int32Array.from(pathCells),
      pathZDelta: Float32Array.from(pathCells, (i) => pathZDelta[i]!),
    };
    for (const i of pathCells) pathZDelta[i] = 0;
    return block;
  };
}

/**
 * Fusionne les blocs dans l'ordre des départs en un résultat de lancement.
 * Cesse de prendre des blocs une fois le plafond de coût atteint (`full`) :
 * les cellules de départ les plus basses sont alors laissées de côté, à la
 * granularité du bloc.
 */
export class FlowPyMerger {
  private readonly target: FlowPyTarget;
  private readonly plan: FlowPyPlan;
  private readonly maxRecords: number;
  private readonly targetFlux: Float64Array;
  private readonly pathZDelta: Float32Array;
  private readonly pathCells: number[] = [];
  private readonly startCells: number[] = [];
  private readonly startAngles: number[] = [];
  private bestAngle = -Infinity;
  private bestZDelta = -Infinity;
  private processed = 0;
  private next = 0;
  private incomplete = false;

  constructor(count: number, target: FlowPyTarget, plan: FlowPyPlan, maxRecords = MAX_RECORDS_PER_RUN) {
    this.target = target;
    this.plan = plan;
    this.maxRecords = maxRecords;
    this.targetFlux = new Float64Array(count);
    this.pathZDelta = new Float32Array(count);
  }

  /** Le prochain bloc voulu : aucun une fois tous les départs fusionnés ou le plafond de coût atteint. */
  get done(): boolean {
    return this.incomplete || this.next >= this.plan.starts.length;
  }

  /** Indice du premier départ du prochain bloc à fusionner. */
  get nextStart(): number {
    return this.next;
  }

  add(block: FlowPyBlock): void {
    if (block.from !== this.next) throw new Error(`Flow-Py block out of order: ${block.from}, expected ${this.next}`);
    if (this.done) return;
    this.next = block.to;
    this.processed += block.processed;
    for (let k = 0; k < block.startCells.length; k++) {
      this.startCells.push(block.startCells[k]!);
      const angle = block.startAngles[k]!;
      this.startAngles.push(angle);
      if (angle > this.bestAngle) this.bestAngle = angle;
    }
    if (block.bestZDelta > this.bestZDelta) this.bestZDelta = block.bestZDelta;
    for (let k = 0; k < block.fluxCells.length; k++) this.targetFlux[block.fluxCells[k]!] += block.fluxValues[k]!;
    for (let k = 0; k < block.pathCells.length; k++) {
      const i = block.pathCells[k]!;
      const z = block.pathZDelta[k]!;
      if (this.pathZDelta[i] === 0) this.pathCells.push(i);
      if (z > this.pathZDelta[i]!) this.pathZDelta[i] = z;
    }
    if (this.next < this.plan.starts.length && this.processed >= this.maxRecords) this.incomplete = true;
  }

  result(): FlowPyResult {
    const { startCells, pathCells } = this;
    let routFluxSum = 0;
    for (const i of this.target.cells) routFluxSum = Math.max(routFluxSum, this.targetFlux[i]!);
    return {
      startCells: Int32Array.from(startCells),
      startTravelAngleDeg: Float32Array.from(this.startAngles),
      travelAngleDeg: startCells.length > 0 ? this.bestAngle : null,
      zDeltaM: startCells.length > 0 ? Math.max(0, this.bestZDelta) : null,
      routFluxSum,
      pathCells: Int32Array.from(pathCells),
      pathZDelta: Float32Array.from(pathCells, (i) => this.pathZDelta[i]!),
      candidates: this.plan.starts.length,
      processed: this.processed,
      incomplete: this.incomplete,
    };
  }
}

/** Lance Flow-Py depuis chaque cellule de départ qui peut atteindre la cible, ici, bloc après bloc. */
export function runFlowPyToTarget(grid: FlowPyGrid, terrain: FlowPyTerrain, target: FlowPyTarget, run: FlowPyRun): FlowPyResult {
  const plan = planFlowPyRun(grid, terrain, target, run);
  const runBlock = createFlowPyBlockRunner(grid, terrain, target, run, plan);
  const merger = new FlowPyMerger(grid.altitude.length, target, plan);
  while (!merger.done) {
    const from = merger.nextStart;
    merger.add(runBlock(from, Math.min(plan.starts.length, from + FLOWPY_BLOCK_STARTS)));
  }
  return merger.result();
}

/** Marque les cellules de chaque chemin entre la cellule de départ et les enregistrements de la cible atteints. */
function traceBack(records: Records, reached: readonly number[], pathZDelta: Float32Array, pathCells: number[]): void {
  const seen = new Uint8Array(records.count);
  const stack = [...reached];
  for (const r of reached) seen[r] = 1;
  while (stack.length > 0) {
    const r = stack.pop()!;
    const i = records.cell[r]!;
    const z = Math.max(records.zDelta[r]!, 1e-3);
    if (pathZDelta[i] === 0) pathCells.push(i);
    if (z > pathZDelta[i]!) pathZDelta[i] = z;
    for (let e = records.edgeHead[r]!; e >= 0; e = records.edgeNext[e]!) {
      const p = records.edgeParent[e]!;
      if (!seen[p]) {
        seen[p] = 1;
        stack.push(p);
      }
    }
  }
}
