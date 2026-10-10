import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

// Les courbes de niveau sont calculées par un script classique du Service
// Worker (public/sw-dem/processing/contours.js), chargé ici dans un contexte vm
// comme le SW l'importScripts(). La tuile MVT est relue par un petit décodeur
// protobuf indépendant, pour vérifier ce que lit Mapbox.
type Neighbours = Partial<Record<'e' | 's' | 'se', Float32Array>>;
type SwContours = {
  buildContourTileBytes: (own: Float32Array, neighbours: Neighbours, z: number, dz?: number, qx?: number, qy?: number) => Uint8Array;
  computeContourLines: (own: Float32Array, neighbours: Neighbours, interval: number) => Map<number, number[][]>;
  contourBaseInterval: (z: number) => number;
};

function loadSwContours(): SwContours {
  const context = vm.createContext({ Math, Float32Array, Uint8Array, Map, TextEncoder });
  const full = path.resolve(import.meta.dirname, '../../public/sw-dem/processing/contours.js');
  vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
  return context as unknown as SwContours;
}

const sw = loadSwContours();
const SIZE = 256;
const EXTENT = 4096;

/** Altitudes d'une tuile (tx, ty) d'un relief continu `f(x, y)` en pixels globaux. */
function tile(f: (gx: number, gy: number) => number, tx = 0, ty = 0): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) out[y * SIZE + x] = f(tx * SIZE + x, ty * SIZE + y);
  }
  return out;
}

// ── Décodeur MVT minimal ────────────────────────────────────────────────

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
    }
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

const unzigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);

interface DecodedFeature {
  tags: number[];
  type: number;
  lines: Array<Array<[number, number]>>;
}

function decodeTile(bytes: Uint8Array) {
  const layers: Array<{ name: string; extent: number; version: number; keys: string[]; values: number[]; features: DecodedFeature[] }> = [];
  const top = new Reader(bytes);
  while (top.pos < bytes.length) {
    const key = top.varint();
    expect(key).toBe((3 << 3) | 2);
    const lr = new Reader(top.bytes());
    const layer = { name: '', extent: 4096, version: 1, keys: [] as string[], values: [] as number[], features: [] as DecodedFeature[] };
    while (lr.pos < lr.buf.length) {
      const k = lr.varint();
      const field = k >> 3;
      if (field === 15) layer.version = lr.varint();
      else if (field === 1) layer.name = new TextDecoder().decode(lr.bytes());
      else if (field === 3) layer.keys.push(new TextDecoder().decode(lr.bytes()));
      else if (field === 5) layer.extent = lr.varint();
      else if (field === 4) {
        const vr = new Reader(lr.bytes());
        const vk = vr.varint();
        expect(vk).toBe((6 << 3) | 0);
        layer.values.push(unzigzag(vr.varint()));
      } else if (field === 2) {
        const fr = new Reader(lr.bytes());
        const feature: DecodedFeature = { tags: [], type: 0, lines: [] };
        while (fr.pos < fr.buf.length) {
          const fk = fr.varint();
          const ff = fk >> 3;
          if (ff === 1) fr.varint();
          else if (ff === 3) feature.type = fr.varint();
          else if (ff === 2 || ff === 4) {
            const packed = new Reader(fr.bytes());
            const ints: number[] = [];
            while (packed.pos < packed.buf.length) ints.push(packed.varint());
            if (ff === 2) feature.tags = ints;
            else {
              let i = 0;
              let x = 0;
              let y = 0;
              while (i < ints.length) {
                const cmd = ints[i] & 7;
                const count = ints[i] >> 3;
                i++;
                if (cmd === 1) feature.lines.push([]);
                for (let c = 0; c < count; c++) {
                  x += unzigzag(ints[i++]);
                  y += unzigzag(ints[i++]);
                  feature.lines[feature.lines.length - 1].push([x, y]);
                }
              }
            }
          } else throw new Error(`champ inattendu ${ff}`);
        }
        layer.features.push(feature);
      } else throw new Error(`champ de couche inattendu ${field}`);
    }
    layers.push(layer);
  }
  return layers;
}

function featureEle(layer: ReturnType<typeof decodeTile>[number], feature: DecodedFeature): number {
  const props: Record<string, number> = {};
  for (let i = 0; i < feature.tags.length; i += 2) props[layer.keys[feature.tags[i]]] = layer.values[feature.tags[i + 1]];
  return props.ele;
}

/**
 * Altitude de la surface que dessine Mapbox au point (x, y) en pixels DEM :
 * sommet (i, j) = pixel (i, j) (bordure est / sud = voisine, ou bord recopié),
 * cellules coupées de haut-droite à bas-gauche, linéaire par triangle.
 */
function meshHeight(own: Float32Array, neighbours: Neighbours, x: number, y: number): number {
  const node = (i: number, j: number) => {
    if (i < SIZE && j < SIZE) return own[j * SIZE + i];
    if (i >= SIZE && j >= SIZE) return neighbours.se ? neighbours.se[0] : own[SIZE * SIZE - 1];
    if (i >= SIZE) return neighbours.e ? neighbours.e[j * SIZE] : own[j * SIZE + SIZE - 1];
    return neighbours.s ? neighbours.s[i] : own[(SIZE - 1) * SIZE + i];
  };
  const cx = Math.min(SIZE - 1, Math.floor(x));
  const cy = Math.min(SIZE - 1, Math.floor(y));
  const fx = x - cx;
  const fy = y - cy;
  const tl = node(cx, cy), tr = node(cx + 1, cy), bl = node(cx, cy + 1), br = node(cx + 1, cy + 1);
  if (fx + fy <= 1) return tl + fx * (tr - tl) + fy * (bl - tl);
  return br + (1 - fx) * (bl - br) + (1 - fy) * (tr - br);
}

/** Relief alpin : crêtes, une falaise (marche de 40 m) et un bruit de surface de type MNS. */
function alpine(gx: number, gy: number): number {
  let h = 1500 + 300 * Math.sin(gx / 37) * Math.cos(gy / 29) + 0.8 * gy + 2.5 * Math.sin(gx * 1.7 + gy * 2.3);
  if (gx > 300) h += 40;
  return h;
}

describe('courbes de niveau du Service Worker', () => {
  it('encode une couche contour MVT v2 lisible, une entité multiligne par niveau', () => {
    const plane = (gx: number) => 1000 + gx * 0.5; // 127,5 m de dénivelé du sommet 0 au sommet 255
    const layers = decodeTile(sw.buildContourTileBytes(tile(plane), {}, 15));
    expect(layers).toHaveLength(1);
    const [layer] = layers;
    expect(layer).toMatchObject({ name: 'contour', extent: EXTENT, version: 2 });
    expect(layer.keys).toEqual(['ele', 'index']);
    const eles = layer.features.map((f) => featureEle(layer, f));
    expect(eles).toEqual([1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100, 1110, 1120]);
    for (const feature of layer.features) {
      expect(feature.type).toBe(2);
      // Le pixel i est le sommet de position i : 1010 m au sommet 20 → x = 20 / 256 de la tuile.
      if (featureEle(layer, feature) === 1010) {
        for (const line of feature.lines) for (const [x] of line) expect(x).toBe(320);
      }
    }
  });

  it('place chaque sommet de chaque courbe à son altitude exacte sur le maillage de Mapbox', () => {
    const own = tile(alpine, 1, 1);
    const neighbours: Neighbours = { e: tile(alpine, 2, 1), s: tile(alpine, 1, 2), se: tile(alpine, 2, 2) };
    const lines = sw.computeContourLines(own, neighbours, 10);
    let checked = 0;
    for (const [level, ls] of lines) {
      for (const line of ls) {
        for (let i = 0; i < line.length; i += 2) {
          expect(Math.abs(meshHeight(own, neighbours, line[i], line[i + 1]) - level)).toBeLessThan(1e-3);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('suit le maillage entre ses sommets à la tolérance de simplification près', () => {
    const own = tile(alpine);
    const lines = sw.computeContourLines(own, {}, 10);
    let worst = 0;
    for (const [level, ls] of lines) {
      for (const line of ls) {
        for (let i = 0; i + 3 < line.length; i += 2) {
          for (const t of [0.25, 0.5, 0.75]) {
            const x = line[i] + t * (line[i + 2] - line[i]);
            const y = line[i + 1] + t * (line[i + 3] - line[i + 1]);
            worst = Math.max(worst, Math.abs(meshHeight(own, {}, x, y) - level));
          }
        }
      }
    }
    // Douglas-Peucker à 0,1 px sur une pente de quelques m/px (falaise comprise).
    expect(worst).toBeLessThan(5);
  });

  it('ferme les courbes autour d’un sommet', () => {
    const peak = (gx: number, gy: number) => 2000 - Math.hypot(gx - 128, gy - 128) * 0.8;
    const rings = sw.computeContourLines(tile(peak), {}, 10).get(1950)!;
    expect(rings).toHaveLength(1);
    const ring = rings[0];
    expect(ring[0]).toBe(ring[ring.length - 2]);
    expect(ring[1]).toBe(ring[ring.length - 1]);
    // Rayon de (2000 − 1950) / 0,8 = 62,5 px autour du sommet 128.
    for (let i = 0; i < ring.length; i += 2) {
      expect(Math.abs(Math.hypot(ring[i] - 128, ring[i + 1] - 128) - 62.5)).toBeLessThan(0.3);
    }
  });

  it('raccorde exactement les courbes de deux tuiles voisines', () => {
    const left = sw.computeContourLines(tile(alpine, 1, 1), { e: tile(alpine, 2, 1), s: tile(alpine, 1, 2), se: tile(alpine, 2, 2) }, 10);
    const right = sw.computeContourLines(tile(alpine, 2, 1), { e: tile(alpine, 3, 1), s: tile(alpine, 2, 2), se: tile(alpine, 3, 2) }, 10);
    // Les lignes s'arrêtent sur le bord : extrémités à x = 256 (gauche) / x = 0 (droite).
    const ends = (lines: Map<number, number[][]>, edgeX: number) => {
      const out: string[] = [];
      for (const [level, ls] of lines) {
        for (const line of ls) {
          for (const i of [0, line.length - 2]) if (line[i] === edgeX) out.push(`${level}@${line[i + 1]}`);
        }
      }
      return out.sort();
    };
    const a = ends(left, SIZE);
    const b = ends(right, 0);
    expect(a.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
  });

  it('recopie le bord de la tuile quand une voisine manque, comme la texture DEM de Mapbox', () => {
    const own = tile(alpine);
    const lines = sw.computeContourLines(own, {}, 10);
    for (const [level, ls] of lines) {
      for (const line of ls) {
        for (let i = 0; i < line.length; i += 2) {
          expect(Math.abs(meshHeight(own, {}, line[i], line[i + 1]) - level)).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('rend une tuile vide sur du plat et saute les triangles sans donnée', () => {
    expect(sw.buildContourTileBytes(tile(() => 1234.5), {}, 15)).toHaveLength(0);
    const holes = tile((gx, gy) => (gx > 100 && gx < 140 && gy > 100 && gy < 140 ? -10000 : 800 + gx));
    const lines = sw.computeContourLines(holes, {}, 10);
    for (const ls of lines.values()) {
      for (const line of ls) {
        for (let i = 0; i < line.length; i += 2) {
          expect(line[i] > 100 && line[i] < 140 && line[i + 1] > 100 && line[i + 1] < 140).toBe(false);
        }
      }
    }
  });

  it('prend une équidistance de 20 m jusqu’à z12', () => {
    expect(sw.contourBaseInterval(12)).toBe(20);
    expect(sw.contourBaseInterval(13)).toBe(10);
    const plane = (gx: number) => 1000 + gx * 0.5;
    const levels = [...sw.computeContourLines(tile(plane), {}, 20).keys()].sort((p, q) => p - q);
    expect(levels).toEqual([1020, 1040, 1060, 1080, 1100, 1120]);
  });

  it('découpe le quart de la tuile DEM couvert par une tuile vectorielle plus profonde', () => {
    // Tuile vectorielle z16 (1, 0) = quart haut-droit de la tuile DEM z15.
    const own = tile(alpine);
    const [layer] = decodeTile(sw.buildContourTileBytes(own, {}, 16, 1, 1, 0));
    let checked = 0;
    for (const feature of layer.features) {
      const ele = featureEle(layer, feature);
      for (const line of feature.lines) {
        for (const [x, y] of line) {
          expect(x).toBeGreaterThanOrEqual(-80);
          expect(x).toBeLessThanOrEqual(EXTENT + 80);
          expect(y).toBeGreaterThanOrEqual(-80);
          expect(y).toBeLessThanOrEqual(EXTENT + 80);
          if (x <= 0 || y <= 0 || x >= EXTENT || y >= EXTENT) continue;
          // Retour aux pixels DEM de la tuile parente : x / 32 + 128, y / 32 ; l'arrondi
          // MVT (1/32 px) laisse au plus quelques centimètres sur ce relief.
          expect(Math.abs(meshHeight(own, {}, x / 32 + 128, y / 32) - ele)).toBeLessThan(0.5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});
