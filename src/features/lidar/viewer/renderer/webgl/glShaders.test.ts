import { describe, expect, it } from 'vitest';
import * as shaders from './glShaders';
import { fitGridToTextureSize } from './glUtils';

const sources = Object.entries(shaders).filter((entry): entry is [string, string] => typeof entry[1] === 'string');

describe('WebGL 2 shaders', () => {
  it('declare GLSL ES 3.00 on their first line', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const [name, source] of sources) {
      // Quoi que ce soit avant #version (même un saut de ligne) fait échouer la compilation.
      expect(source.startsWith('#version 300 es\n'), name).toBe(true);
    }
  });

  it('declare the scene block identically in every stage that uses it', () => {
    const blocks = new Set(sources
      .map(([, source]) => /layout\(std140\) uniform Scene \{[\s\S]*?\} camera;/.exec(source)?.[0])
      .filter(Boolean));
    expect(blocks.size).toBe(1);
  });

  it('avoid GLSL reversed-edge smoothstep (undefined behaviour)', () => {
    for (const [name, source] of sources) {
      for (const match of source.matchAll(/smoothstep\(\s*([\d.]+)\s*,\s*([\d.]+)/g)) {
        expect(Number(match[1]), name).toBeLessThan(Number(match[2]));
      }
    }
  });
});

describe('fitGridToTextureSize', () => {
  it('leaves grids that fit untouched', () => {
    const data = new Float32Array([1, 2, 3, 4]);
    expect(fitGridToTextureSize(data, 2, 2, 1, 2048).data).toBe(data);
  });

  it('keeps the first and last nodes of each axis (same edge-to-edge span)', () => {
    const width = 5;
    const height = 3;
    const data = new Float32Array(width * height).map((_, i) => i);
    const fitted = fitGridToTextureSize(data, width, height, 1, 3);
    expect(fitted.width).toBe(3);
    expect(fitted.height).toBe(3);
    // Coins de la grille source.
    expect(fitted.data[0]).toBe(0);
    expect(fitted.data[2]).toBe(4);
    expect(fitted.data[6]).toBe(10);
    expect(fitted.data[8]).toBe(14);
  });

  it('resamples multi-channel grids per node', () => {
    const rgba = new Uint8Array([10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33]);
    const fitted = fitGridToTextureSize(rgba, 3, 1, 4, 2);
    expect(fitted.data).toBeInstanceOf(Uint8Array);
    expect([...fitted.data]).toEqual([10, 11, 12, 13, 30, 31, 32, 33]);
  });
});
