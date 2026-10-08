import { describe, expect, it } from 'vitest';
import { wheelDeltaPixels } from './camera';

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

describe('wheelDeltaPixels', () => {
  it('keeps pixel deltas (Chrome, Safari, Firefox touchpads)', () => {
    expect(wheelDeltaPixels({ deltaY: 100, deltaMode: PIXEL }, 900)).toBe(100);
    expect(wheelDeltaPixels({ deltaY: -53, deltaMode: PIXEL }, 900)).toBe(-53);
  });

  it('converts Firefox line deltas to about one Chrome notch', () => {
    // Un cran de molette dans Firefox (Linux et Windows) : 3 lignes.
    expect(wheelDeltaPixels({ deltaY: 3, deltaMode: LINE }, 900)).toBe(120);
    expect(wheelDeltaPixels({ deltaY: -3, deltaMode: LINE }, 900)).toBe(-120);
  });

  it('bounds page deltas and flings', () => {
    expect(wheelDeltaPixels({ deltaY: 1, deltaMode: PAGE }, 900)).toBe(300);
    expect(wheelDeltaPixels({ deltaY: -5000, deltaMode: PIXEL }, 900)).toBe(-300);
  });

  it('ignores invalid deltas', () => {
    expect(wheelDeltaPixels({ deltaY: Number.NaN, deltaMode: PIXEL }, 900)).toBe(0);
  });
});
