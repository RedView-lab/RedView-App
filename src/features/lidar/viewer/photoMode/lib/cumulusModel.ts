// ============================================
// Photo mode — cumulus towers modelled as nested spheres (metaballs)
// ============================================
//
// Nubis³ (Schneider, SIGGRAPH 2023) renders its close clouds from a voxel
// "dimensional profile" grown by fluid simulation, metaballs or meshes, and
// only up-rezzes it with noise: the cauliflower structure — rounded turrets
// on turrets, the crevices between them — is in the model, not in the noise.
// Without a simulation, a convective tower is built here as what it is: a
// cluster of rising thermals (columns of spheres from the condensation level
// up to each one's top, leaning with the wind shear), each sphere budding
// smaller turrets on its sky-facing side, down to ~60 m (below, the noise
// up-rez takes over). The cells keep the weather layout of the previous
// model: a jittered grid at the genus' spacing, presence and radius set by
// the cover, a few towers growing to the top of the layer, a clearing and a
// light corridor that keep the subject in the sun.
//
// The spheres are bucketed in a uniform grid over the cloud domain for the
// GPU voxelizer (`MODEL_SHADER`), which takes, per voxel, the smooth union
// of their depths.

/** Floats per sphere: centre x, height above the base, centre z, radius (m). */
export const SPHERE_FLOATS = 4;
/** Cells of the bucketing grid (horizontal, vertical). */
export const CUMULUS_GRID_XZ = 64;
export const CUMULUS_GRID_Y = 16;
/** Smallest turret modelled near the scene / at the domain's edge (m). */
const MIN_TURRET_NEAR_M = 55;
const MIN_TURRET_FAR_M = 160;
/**
 * Tallest tower for its footprint radius (height / radius): small cells stay
 * humilis / mediocris domes, only the big ones tower (the thermals are
 * narrower than the footprint: a ratio of 4 already reads as a chimney on a
 * 400 m cell).
 */
const MIN_TOWER_ASPECT = 1.1;
const MAX_TOWER_ASPECT = 2.3;
/** Upper bound of the sphere count (GPU buffer size). */
export const MAX_CUMULUS_SPHERES = 160_000;

export interface CumulusFieldInput {
  coverage: number;
  /** 0 = layer clouds … 1 = cumulus. */
  type: number;
  seed: number;
  cellSizeM: number;
  domainHalfM: number;
  fullRadiusM: number;
  thicknessM: number;
  /** Clearing kept free of towers on the base plane (render frame x/z, m). */
  clearingX: number;
  clearingZ: number;
  clearingRadiusM: number;
  /** Horizontal direction towards the sun (unit) and the tangent of its altitude. */
  sunX: number;
  sunZ: number;
  sunTanAltitude: number;
  /** Cumulonimbus anvils spread from the tallest towers. */
  anvil: number;
}

interface CumulusAnvil {
  x: number;
  z: number;
  radiusM: number;
}

export interface CumulusField {
  /** `count` spheres of SPHERE_FLOATS floats. */
  spheres: Float32Array<ArrayBuffer>;
  count: number;
  /** Per grid cell (x fastest, then z, then y): first index into `indices`, count. */
  cells: Uint32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  anvils: CumulusAnvil[];
  /** How much of the field is cumulus (0 = only layer clouds). */
  cumulusAmount: number;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Deterministic hash of integers into a 32-bit seed (murmur3 finaliser). */
function hashInts(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    h = Math.imul(h ^ (v | 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for shapes. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

class SphereList {
  readonly data: number[] = [];
  get count(): number {
    return this.data.length / SPHERE_FLOATS;
  }
  push(s: Sphere): boolean {
    if (this.count >= MAX_CUMULUS_SPHERES) return false;
    this.data.push(s.x, s.y, s.z, s.r);
    return true;
  }
}

interface Tower {
  x: number;
  z: number;
  /** Footprint radius at the base (m). */
  radius: number;
  /** Height of the tallest thermal above the base (m). */
  height: number;
  /** Smallest turret (m). */
  minTurret: number;
  seed: number;
}

/** Wind shear: the tops drift downwind (fraction of the height), one direction for the whole sky. */
function shearOf(seed: number): { x: number; z: number } {
  const rng = makeRng(hashInts(seed, 7741));
  const angle = rng() * 2 * Math.PI;
  const amount = mix(0.05, 0.12, rng());
  return { x: Math.cos(angle) * amount, z: Math.sin(angle) * amount };
}

/**
 * The thermals of one tower: the main one reaches the full height, the
 * others stop lower around it; each is a column of spheres from the
 * condensation level up, wobbling and leaning with the shear, capped by a
 * dome. A skirt of wide spheres under them makes the broad flat base.
 */
function towerBodies(tower: Tower, shear: { x: number; z: number }, rng: () => number): Sphere[] {
  const bodies: Sphere[] = [];
  const R = tower.radius;
  const H = tower.height;
  // Skirt: wide spheres sunk under the base (cut flat there).
  const skirt = 6 + Math.floor(rng() * 4);
  for (let k = 0; k < skirt; k++) {
    const angle = rng() * 2 * Math.PI;
    const d = R * Math.sqrt(rng()) * 0.58;
    const r = R * mix(0.45, 0.6, rng());
    bodies.push({ x: tower.x + Math.cos(angle) * d, y: r * mix(0.15, 0.4, rng()) - r * 0.25, z: tower.z + Math.sin(angle) * d, r });
  }
  const thermals: { ox: number; oz: number; h: number; r: number }[] = [
    { ox: R * 0.12 * gaussian(rng), oz: R * 0.12 * gaussian(rng), h: H, r: R * mix(0.6, 0.75, rng()) },
  ];
  const others = 3 + Math.floor(rng() * 4);
  for (let k = 0; k < others; k++) {
    const angle = rng() * 2 * Math.PI;
    // Close enough to the main thermal to merge with it: apart, they made
    // figures with holes.
    const d = R * mix(0.22, 0.5, rng());
    const h = H * mix(0.45, 0.9, rng() * rng() + 0.25 * rng());
    thermals.push({ ox: Math.cos(angle) * d, oz: Math.sin(angle) * d, h, r: R * mix(0.4, 0.6, rng()) });
  }
  // Each thermal: a stem of older bubbles, some pushed out as side lobes,
  // under the rising head — the widest, roundest part of the column.
  for (const th of thermals) {
    const r0 = Math.min(th.r, th.h * 0.5);
    const headR = Math.min(r0 * mix(0.95, 1.15, rng()), th.h * 0.5);
    const headY = Math.max(headR * 0.6, th.h - headR);
    let y = r0 * 0.4;
    let wx = 0;
    let wz = 0;
    while (y < headY - 0.6 * headR) {
      const t = y / th.h;
      const r = r0 * mix(0.5, 1.05, rng()) * (1 - 0.15 * t);
      wx = 0.6 * wx + 0.24 * r0 * gaussian(rng);
      wz = 0.6 * wz + 0.24 * r0 * gaussian(rng);
      const x = tower.x + th.ox + shear.x * y + wx;
      const z = tower.z + th.oz + shear.z * y + wz;
      bodies.push({ x, y, z, r });
      if (rng() < 0.4) {
        const angle = rng() * 2 * Math.PI;
        // Always overlapping the stem (apart, lobes left holes).
        const d = r0 * mix(0.35, 0.6, rng());
        const lobe = r0 * mix(0.45, 0.68, rng());
        bodies.push({ x: x + Math.cos(angle) * d, y: y + lobe * mix(-0.2, 0.3, rng()), z: z + Math.sin(angle) * d, r: lobe });
      }
      y += r * mix(0.55, 0.85, rng());
    }
    bodies.push({ x: tower.x + th.ox + shear.x * headY + wx, y: headY, z: tower.z + th.oz + shear.z * headY + wz, r: headR });
  }
  return bodies;
}

function insideAny(bodies: Sphere[], x: number, y: number, z: number, except: Sphere | null, margin: number): boolean {
  for (const b of bodies) {
    if (b === except) continue;
    const dx = x - b.x;
    const dy = y - b.y;
    const dz = z - b.z;
    const r = b.r * margin;
    if (dx * dx + dy * dy + dz * dz < r * r) return true;
  }
  return false;
}

/**
 * Turrets budding on the sky-facing side of every sphere, recursively, down
 * to `tower.minTurret`: up and outwards from the tower's axis, poking half
 * to most of their radius out of their parent; buds that would end inside
 * the tower's bodies are not kept (nothing to see).
 */
function growTurrets(tower: Tower, bodies: Sphere[], shear: { x: number; z: number }, rng: () => number, out: SphereList): void {
  let level: Sphere[] = bodies;
  let depth = 0;
  while (level.length > 0 && depth < 5) {
    const next: Sphere[] = [];
    const buds = depth === 0 ? 5 : 4;
    for (const parent of level) {
      if (parent.r * 0.5 < tower.minTurret) continue;
      const axisX = tower.x + shear.x * parent.y;
      const axisZ = tower.z + shear.z * parent.y;
      let ox = parent.x - axisX;
      let oz = parent.z - axisZ;
      const ol = Math.hypot(ox, oz);
      if (ol > 1e-3) {
        ox /= ol;
        oz /= ol;
      } else {
        ox = 0;
        oz = 0;
      }
      for (let k = 0; k < buds; k++) {
        let dx = gaussian(rng) + ox * 0.7;
        let dy = gaussian(rng) + 1.0;
        let dz = gaussian(rng) + oz * 0.7;
        const dl = Math.hypot(dx, dy, dz);
        dx /= dl;
        dy /= dl;
        dz /= dl;
        if (dy < -0.3) continue;
        const r = parent.r * (depth === 0 ? mix(0.32, 0.6, rng()) : mix(0.3, 0.52, rng()));
        if (r < tower.minTurret) continue;
        const reach = parent.r - r * mix(0.3, 0.7, rng());
        const c: Sphere = { x: parent.x + dx * reach, y: parent.y + dy * reach, z: parent.z + dz * reach, r };
        if (c.y < r * 0.2 || c.y + r > tower.height * 1.04 + 40) continue;
        if (insideAny(bodies, c.x + dx * r, c.y + dy * r, c.z + dz * r, parent, 0.97)) continue;
        if (!out.push(c)) return;
        next.push(c);
      }
    }
    level = next;
    depth++;
  }
}

/** Builds the towers of the cloud domain and buckets them for the voxelizer. */
export function buildCumulusField(input: CumulusFieldInput): CumulusField {
  const out = new SphereList();
  const anvils: CumulusAnvil[] = [];
  const cov = Math.min(1, Math.max(0, input.coverage));
  const cumulusAmount = smoothstep(0.45, 0.9, input.type);
  const half = input.domainHalfM;
  if (cov > 0.001 && cumulusAmount > 0.01) {
    const spacing = input.cellSizeM;
    const presence = Math.min(1, 0.3 + 0.9 * cov);
    const radiusFactor = Math.sqrt(Math.min(cov, 0.92) / (Math.PI * presence)) * 1.2;
    const clearingStrength = cumulusAmount * (1 - smoothstep(0.55, 0.8, cov));
    const shear = shearOf(input.seed);
    const cells = Math.ceil(half / spacing);
    for (let j = -cells; j < cells; j++) {
      for (let i = -cells; i < cells; i++) {
        const rng = makeRng(hashInts(input.seed, i, j));
        if (rng() > presence) continue;
        const x = (i + 0.2 + 0.6 * rng()) * spacing;
        const z = (j + 0.2 + 0.6 * rng()) * spacing;
        const distance = Math.hypot(x, z);
        if (distance > half * 0.97) continue;
        const falloff = 1 - smoothstep(input.fullRadiusM, half * 0.95, distance);
        const scale = mix(0.7, 1.3, rng());
        let radius = radiusFactor * scale * spacing * mix(0.45, 1.0, falloff);
        const clearingGap = Math.hypot(x - input.clearingX, z - input.clearingZ) - input.clearingRadiusM;
        radius = mix(radius, Math.min(radius, Math.max(clearingGap, 0) / 0.85), clearingStrength);
        if (radius < 120) continue;
        // A few towers shoot up to the top of the layer, most stay lower
        // (mediocris next to congestus); bigger cells grow taller.
        const towering = rng();
        let height = mix(0.28, 1.0, Math.min(1, 0.45 * smoothstep(0.7, 1.3, scale) + 0.75 * towering * towering)) * mix(0.35, 1.0, falloff);
        // Light corridor: a tower between the subject and the sun stays low
        // enough for its shadow to fall short of the subject.
        const toX = x - input.clearingX;
        const toZ = z - input.clearingZ;
        const along = toX * input.sunX + toZ * input.sunZ;
        const lateral = Math.abs(toX * input.sunZ - toZ * input.sunX);
        const corridor = (1 - smoothstep(input.clearingRadiusM + 0.6 * radius, input.clearingRadiusM + 1.1 * radius, lateral))
          * (along >= 0 ? 1 : 0) * clearingStrength;
        const shadowFree = Math.max(0.1, ((along - 0.8 * radius) * input.sunTanAltitude) / Math.max(input.thicknessM, 1));
        height = mix(height, Math.min(height, shadowFree), corridor);
        // Congestus are at most about twice as tall as wide: no chimneys.
        const heightM = Math.max(radius * 0.6, Math.min(height * input.thicknessM, radius * mix(MIN_TOWER_ASPECT, MAX_TOWER_ASPECT, smoothstep(500, 1500, radius))));
        if (input.anvil > 0.5 && scale > 0.95 && height > 0.8) anvils.push({ x, z, radiusM: radius * 2.6 * falloff });
        const tower: Tower = {
          x, z, radius, height: Math.min(heightM, input.thicknessM * 0.85),
          minTurret: mix(MIN_TURRET_FAR_M, MIN_TURRET_NEAR_M, falloff), seed: hashInts(input.seed, i, j, 3),
        };
        const towerRng = makeRng(tower.seed);
        const bodies = towerBodies(tower, shear, towerRng);
        for (const b of bodies) out.push(b);
        growTurrets(tower, bodies, shear, towerRng, out);
      }
    }
  }
  const spheres = new Float32Array(out.data);
  const { cells, indices } = bucketSpheres(spheres, out.count, half, input.thicknessM);
  return { spheres, count: out.count, cells, indices, anvils, cumulusAmount };
}

/** Bucket ranges of the grid cells a sphere overlaps (inclusive). */
function cellRange(spheres: Float32Array, s: number, half: number, thickness: number): [number, number, number, number, number, number] {
  const cx = (2 * half) / CUMULUS_GRID_XZ;
  const cy = thickness / CUMULUS_GRID_Y;
  const x = spheres[s * 4]!;
  const y = spheres[s * 4 + 1]!;
  const z = spheres[s * 4 + 2]!;
  const r = spheres[s * 4 + 3]!;
  const clampXZ = (v: number) => Math.min(CUMULUS_GRID_XZ - 1, Math.max(0, Math.floor(v)));
  const clampY = (v: number) => Math.min(CUMULUS_GRID_Y - 1, Math.max(0, Math.floor(v)));
  return [
    clampXZ((x - r + half) / cx), clampXZ((x + r + half) / cx),
    clampY((y - r) / cy), clampY((y + r) / cy),
    clampXZ((z - r + half) / cx), clampXZ((z + r + half) / cx),
  ];
}

/** Counting sort of the spheres into the cells they overlap. */
function bucketSpheres(spheres: Float32Array, count: number, half: number, thickness: number): { cells: Uint32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const cellCount = CUMULUS_GRID_XZ * CUMULUS_GRID_XZ * CUMULUS_GRID_Y;
  const counts = new Uint32Array(cellCount);
  const cellIndex = (ix: number, iy: number, iz: number) => ix + CUMULUS_GRID_XZ * (iz + CUMULUS_GRID_XZ * iy);
  for (let s = 0; s < count; s++) {
    const [x0, x1, y0, y1, z0, z1] = cellRange(spheres, s, half, thickness);
    for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) counts[cellIndex(ix, iy, iz)]!++;
  }
  const cells = new Uint32Array(cellCount * 2);
  let total = 0;
  for (let c = 0; c < cellCount; c++) {
    cells[c * 2] = total;
    cells[c * 2 + 1] = 0;
    total += counts[c]!;
  }
  const indices = new Uint32Array(Math.max(1, total));
  for (let s = 0; s < count; s++) {
    const [x0, x1, y0, y1, z0, z1] = cellRange(spheres, s, half, thickness);
    for (let iy = y0; iy <= y1; iy++) {
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const c = cellIndex(ix, iy, iz);
          indices[cells[c * 2]! + cells[c * 2 + 1]!] = s;
          cells[c * 2 + 1]!++;
        }
      }
    }
  }
  return { cells, indices };
}
