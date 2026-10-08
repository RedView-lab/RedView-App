import { describe, expect, it } from 'vitest';
import type { CopcHierarchyInfo } from '../../types';
import {
  LOD_GRID,
  LOD_POINT_STRIDE,
  LOD_RECORD,
  buildLodTile,
  lodNodeCube,
  type LodNode,
  type LodTile,
  type LodTileInput,
} from './lodTile';

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORIGIN = { x: 965000, y: 6499000, z: 0 };

/** Écrit le point `i` à une position locale avec des attributs tirés d'une graine. */
function fillPoint(input: LodTileInput, i: number, x: number, y: number, z: number, rand: () => number): void {
  input.positions[i * 3] = x;
  input.positions[i * 3 + 1] = y;
  input.positions[i * 3 + 2] = z;
  input.colors[i * 3] = Math.floor(rand() * 256);
  input.colors[i * 3 + 1] = Math.floor(x / 4) & 255;
  input.colors[i * 3 + 2] = Math.floor(y / 4) & 255;
  input.classifications[i] = rand() < 0.3 ? 5 : 2;
  // Des zéros, un corps sur 12 bits et de rares valeurs aberrantes saturées : l'échelle par percentile a du travail.
  input.intensities![i] = rand() < 0.05 ? 0 : Math.floor(rand() * 4096) + (rand() < 0.01 ? 60000 : 0);
}

function emptyInput(count: number): LodTileInput {
  return {
    positions: new Float32Array(count * 3),
    colors: new Uint8Array(count * 3),
    classifications: new Uint8Array(count),
    intensities: new Uint16Array(count),
    count,
    bounds: { minX: 965000, minY: 6499000, minZ: 1000, maxX: 966000, maxY: 6500000, maxZ: 1400 },
    origin: { ...ORIGIN },
    crs: 'LAMB93',
  };
}

/** Tuile LAS simple façon terrain : l'octree additif est construit ici (plusieurs niveaux). */
function additiveInput(count: number, seed: number): LodTileInput {
  const rand = mulberry32(seed);
  const input = emptyInput(count);
  for (let i = 0; i < count; i++) {
    const x = rand() * 1000;
    const y = rand() * 1000;
    fillPoint(input, i, x, y, 1200 + 80 * Math.sin(x / 90) * Math.cos(y / 70) + rand() * 25, rand);
  }
  return input;
}

/**
 * Tuile façon COPC : points groupés par nœud dans l'ordre de la hiérarchie, avec
 * un nœud dont le parent ne contient aucun point (son sous-arbre alimente directement la racine).
 */
function copcInput(seed: number): LodTileInput {
  const rand = mulberry32(seed);
  const cubeSize = 1024;
  const keys: Array<[string, number]> = [
    ['0-0-0-0', 6000],
    ['1-0-0-0', 5000], ['1-1-0-0', 5000], ['1-0-1-0', 4000],
    ['2-0-0-0', 3000], ['2-1-0-0', 3000], ['2-2-1-0', 3000], ['2-1-3-0', 2000],
    // Le parent 1-1-1-0 est absent.
    ['2-3-3-0', 2500], ['2-2-2-1', 1500],
    ['3-0-0-0', 2000], ['3-5-2-0', 2000],
  ];
  const count = keys.reduce((sum, [, n]) => sum + n, 0);
  const input = emptyInput(count);
  let i = 0;
  for (const [key, n] of keys) {
    const [depth, kx, ky, kz] = key.split('-').map(Number) as [number, number, number, number];
    const size = cubeSize / 2 ** depth;
    for (let k = 0; k < n; k++, i++) {
      fillPoint(input, i, (kx + rand()) * size, (ky + rand()) * size, 1000 + (kz + rand()) * size, rand);
    }
  }
  const copc: CopcHierarchyInfo = {
    nodes: keys.map(([key, pointCount]) => ({ key, pointCount })),
    cube: [ORIGIN.x, ORIGIN.y, 1000, ORIGIN.x + cubeSize, ORIGIN.y + cubeSize, 1000 + cubeSize],
    spacing: cubeSize / LOD_GRID,
  };
  return { ...input, copc };
}

/** Deux hachages FNV-1a 32 bits (décalages différents) des octets empaquetés, de la table des nœuds et de l'en-tête. */
function fingerprint(tile: LodTile): string {
  const bytes = [tile.packed, new TextEncoder().encode(JSON.stringify([tile.nodes, tile.header]))];
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const part of bytes) {
    for (let i = 0; i < part.length; i++) {
      a = Math.imul(a ^ part[i]!, 0x01000193);
      b = Math.imul(b ^ part[i]!, 0x01000193) ^ (b >>> 13);
    }
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Force brute du filtre d'attributs : pour chaque nœud ayant des descendants,
 * la moyenne sur tous les points de son sous-arbre situés dans chaque cellule
 * de sa grille, rassemblés point par point (pas de fusion niveau par niveau).
 */
function referenceFilter(tile: LodTile): Map<number, Uint8Array> {
  const { nodes, packed } = tile;
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const nonEmpty = nodes.map((node, i) => ({ node, i })).filter(({ node }) => node.count > 0);
  const parentOf = new Map<number, number>();
  for (const { node, i } of nonEmpty) {
    let best: { j: number; depth: number } | null = null;
    for (const { node: other, i: j } of nonEmpty) {
      const shift = node.depth - other.depth;
      if (shift <= 0) continue;
      if ((node.x >> shift) === other.x && (node.y >> shift) === other.y && (node.z >> shift) === other.z) {
        if (!best || other.depth > best.depth) best = { j, depth: other.depth };
      }
    }
    if (best) parentOf.set(i, best.j);
  }
  const isAncestor = (a: number, d: number) => {
    for (let p = parentOf.get(d); p !== undefined; p = parentOf.get(p)) if (p === a) return true;
    return false;
  };
  const expected = new Map<number, Uint8Array>();
  for (const { node, i } of nonEmpty) {
    const subtree = nonEmpty.filter(({ i: d }) => isAncestor(i, d));
    if (subtree.length === 0) continue;
    const cellOf = (member: LodNode, at: number) => {
      const shift = member.depth - node.depth;
      const axis = (k: number, offset: number) => (((offset << 7) + (view.getUint16(at + 2 * k, true) >> 9)) >> shift);
      return axis(0, member.x - (node.x << shift))
        | (axis(1, member.y - (node.y << shift)) << 7)
        | (axis(2, member.z - (node.z << shift)) << 14);
    };
    const sums = new Map<number, number[]>();
    for (const member of [node, ...subtree.map(({ node: d }) => d)]) {
      for (let k = 0; k < member.count; k++) {
        const at = member.byteOffset + k * LOD_POINT_STRIDE;
        const cell = cellOf(member, at);
        const s = sums.get(cell) ?? [0, 0, 0, 0, 0];
        s[0]! += packed[at + LOD_RECORD.rgb]!;
        s[1]! += packed[at + LOD_RECORD.rgb + 1]!;
        s[2]! += packed[at + LOD_RECORD.rgb + 2]!;
        s[3]! += packed[at + LOD_RECORD.intensity]!;
        s[4]! += 1;
        sums.set(cell, s);
      }
    }
    const out = new Uint8Array(node.count * 4);
    for (let k = 0; k < node.count; k++) {
      const s = sums.get(cellOf(node, node.byteOffset + k * LOD_POINT_STRIDE))!;
      for (let c = 0; c < 4; c++) out[k * 4 + c] = Math.round(s[c]! / s[4]!);
    }
    expected.set(i, out);
  }
  return expected;
}

function filteredOf(tile: LodTile, index: number): Uint8Array {
  const node = tile.nodes[index]!;
  const out = new Uint8Array(node.count * 4);
  for (let k = 0; k < node.count; k++) {
    const at = node.byteOffset + k * LOD_POINT_STRIDE;
    out.set([
      tile.packed[at + LOD_RECORD.filteredRgb]!,
      tile.packed[at + LOD_RECORD.filteredRgb + 1]!,
      tile.packed[at + LOD_RECORD.filteredRgb + 2]!,
      tile.packed[at + LOD_RECORD.filteredIntensity]!,
    ], k * 4);
  }
  return out;
}

describe('buildLodTile', () => {
  it('builds the additive octree byte for byte as before the hot-loop rewrite', () => {
    const tile = buildLodTile(additiveInput(500_000, 7));
    expect(Math.max(...tile.nodes.map((node) => node.depth))).toBeGreaterThanOrEqual(2);
    expect(fingerprint(tile)).toBe('b113674e8d5d209c');
  });

  it('packs a COPC hierarchy byte for byte as before the hot-loop rewrite', () => {
    const tile = buildLodTile(copcInput(11));
    expect(tile.nodes.map((n) => `${n.depth}-${n.x}-${n.y}-${n.z}`)).toEqual(copcInput(11).copc!.nodes.map((n) => n.key));
    expect(fingerprint(tile)).toBe('dd67f8dec693d814');
  });

  it('stores every point once, quantized in its node cube', () => {
    const input = additiveInput(120_000, 3);
    const tile = buildLodTile(input);
    expect(tile.nodes.reduce((sum, node) => sum + node.count, 0)).toBe(input.count);
    const view = new DataView(tile.packed.buffer);
    for (const node of tile.nodes) {
      const cube = lodNodeCube(tile.header, node);
      for (let k = 0; k < node.count; k += 97) {
        const at = node.byteOffset + k * LOD_POINT_STRIDE;
        for (let axis = 0; axis < 3; axis++) {
          const q = view.getUint16(at + axis * 2, true);
          const min = axis === 0 ? cube.minX : axis === 1 ? cube.minY : cube.minZ;
          // Dans le cube, et un pas de quantification valide de celui-ci.
          expect(min + (q / 65535) * cube.size).toBeGreaterThanOrEqual(min - 1e-9);
          expect(q).toBeLessThanOrEqual(65535);
        }
        expect(tile.packed[at + 15]).toBe(0);
      }
    }
  });

  it('maps intensities with the 1st–99th percentile range of the tile', () => {
    const input = additiveInput(50_000, 5);
    const tile = buildLodTile(input);
    const values = Array.from(input.intensities!).filter((v) => v > 0).sort((a, b) => a - b);
    const low = values[Math.ceil(values.length * 0.01) - 1]!;
    const high = values[Math.ceil(values.length * 0.99) - 1]!;
    const expectedOf = (v: number) => (v <= low ? 0 : v >= high ? 255 : Math.round(((v - low) / Math.max(1, high - low)) * 255));
    // La construction additive réordonne les points : comparer les multiensembles de valeurs par classe d'intensité brute.
    const seen = new Map<number, number>();
    for (let i = 0; i < tile.header.pointCount; i++) {
      const value = tile.packed[i * LOD_POINT_STRIDE + LOD_RECORD.intensity]!;
      seen.set(value, (seen.get(value) ?? 0) + 1);
    }
    const expected = new Map<number, number>();
    for (const v of input.intensities!) expected.set(expectedOf(v), (expected.get(expectedOf(v)) ?? 0) + 1);
    expect(seen).toEqual(expected);
  });

  it.each([
    ['additive', () => additiveInput(130_000, 9)],
    ['COPC with a missing parent', () => copcInput(13)],
  ])('filters attributes as the subtree means per cell (%s)', (_name, makeInput) => {
    const tile = buildLodTile(makeInput());
    const expected = referenceFilter(tile);
    expect(expected.size).toBeGreaterThan(0);
    for (const [index, values] of expected) expect(filteredOf(tile, index), `node ${index}`).toEqual(values);
    // Les feuilles gardent leurs propres valeurs (comptées : un `expect` par point coûtait des secondes sur le runner de CI).
    tile.nodes.forEach((node, index) => {
      if (expected.has(index)) return;
      let differing = 0;
      for (let k = 0; k < node.count; k++) {
        const at = node.byteOffset + k * LOD_POINT_STRIDE;
        for (let c = 0; c < 3; c++) if (tile.packed[at + LOD_RECORD.filteredRgb + c] !== tile.packed[at + LOD_RECORD.rgb + c]) differing++;
        if (tile.packed[at + LOD_RECORD.filteredIntensity] !== tile.packed[at + LOD_RECORD.intensity]) differing++;
      }
      expect(differing, `leaf ${index}`).toBe(0);
    });
  });
});
