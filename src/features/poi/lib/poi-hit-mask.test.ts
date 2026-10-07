import { describe, expect, it } from 'vitest';
import { buildPoiHitMask, pickPoiHit, poiHitDistancePx, type PoiHitMask } from './poi-hit-mask';

/**
 * Synthetic sprite, like `rasterizePoiSprite` lays them out: a canvas made
 * symmetric around the anchor, a drawn shape and a soft shadow ring.
 */
function sprite(
  halfW: number,
  halfH: number,
  pixelRatio: number,
  alphaAt: (x: number, y: number) => number,
): PoiHitMask {
  const width = halfW * 2 * pixelRatio;
  const height = halfH * 2 * pixelRatio;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      // Device px centre → CSS px relative to the anchor.
      const x = (px + 0.5) / pixelRatio - halfW;
      const y = (py + 0.5) / pixelRatio - halfH;
      rgba[(py * width + px) * 4 + 3] = alphaAt(x, y);
    }
  }
  return buildPoiHitMask(rgba, width, height, pixelRatio, halfW, halfH);
}

/** Round POI: 10.5 px disc in a 66 px image, shadow ring up to 16 px. */
const disc = (pixelRatio = 2) => sprite(33, 33, pixelRatio, (x, y) => {
  const r = Math.hypot(x, y);
  if (r <= 10.5) return 255;
  if (r <= 16) return 80;
  return 0;
});

/** Favourite pin: head circle above the tip (anchor), in an 88×126 image. */
const pin = (pixelRatio = 2) => sprite(44, 63, pixelRatio, (x, y) => {
  const head = Math.hypot(x, y + 17.7) <= 14.3;
  const tip = y <= 0.8 && y >= -8 && Math.abs(x) <= (0.8 - y) * 0.9;
  return head || tip ? 255 : 0;
});

describe('buildPoiHitMask', () => {
  it('keeps the drawn shape and drops the soft shadow', () => {
    const mask = disc();
    expect(mask.bounds).not.toBeNull();
    expect(mask.bounds!.minX).toBeGreaterThanOrEqual(-11);
    expect(mask.bounds!.maxX).toBeLessThanOrEqual(11);
    expect(mask.bounds!.minY).toBeGreaterThanOrEqual(-11);
    expect(mask.bounds!.maxY).toBeLessThanOrEqual(11);
  });

  it('measures distances to the drawn pixels', () => {
    const mask = disc();
    expect(poiHitDistancePx(mask, 0, 0)).toBe(0);
    expect(poiHitDistancePx(mask, 9, 0)).toBe(0);
    expect(poiHitDistancePx(mask, 20, 0)).toBeGreaterThan(8);
    expect(poiHitDistancePx(mask, 20, 0)).toBeLessThan(11);
    // Outside the image entirely: still a finite, larger distance.
    expect(poiHitDistancePx(mask, 60, 0)).toBeGreaterThan(40);
  });

  it('places a pin above its anchor, not around it', () => {
    const mask = pin();
    expect(mask.bounds!.maxY).toBeLessThanOrEqual(2);
    expect(mask.bounds!.minY).toBeLessThan(-30);
    expect(poiHitDistancePx(mask, 0, -18)).toBe(0);
    // 20 px under the tip: inside the old image box, far from the drawing.
    expect(poiHitDistancePx(mask, 0, 20)).toBeGreaterThan(15);
  });

  it('is independent of the rasterisation density', () => {
    for (const ratio of [2, 3, 4]) {
      const mask = disc(ratio);
      expect(mask.width).toBe(66);
      expect(poiHitDistancePx(mask, 0, 0)).toBe(0);
      expect(poiHitDistancePx(mask, 0, 15)).toBeGreaterThan(3);
    }
  });

  it('has no bounds for an empty sprite', () => {
    const mask = sprite(10, 10, 2, () => 40);
    expect(mask.bounds).toBeNull();
    expect(poiHitDistancePx(mask, 0, 0)).toBe(Infinity);
  });
});

describe('pickPoiHit', () => {
  const round = disc();
  const fav = pin();

  it('ignores the transparent padding of the image', () => {
    const candidates = [{ key: 'r', mask: round, drawRank: 0, placements: [{ x: 100, y: 100, scale: 1 }] }];
    expect(pickPoiHit(candidates, { x: 100, y: 100 }, 3)).toBe('r');
    expect(pickPoiHit(candidates, { x: 100, y: 125 }, 3)).toBeNull();
    expect(pickPoiHit(candidates, { x: 125, y: 100 }, 3)).toBeNull();
  });

  it('accepts a click just outside the edge, within the tolerance', () => {
    const candidates = [{ key: 'r', mask: round, drawRank: 0, placements: [{ x: 100, y: 100, scale: 1 }] }];
    expect(pickPoiHit(candidates, { x: 112.5, y: 100 }, 3)).toBe('r');
    expect(pickPoiHit(candidates, { x: 116, y: 100 }, 3)).toBeNull();
  });

  it('gives a favourite drawn above an overlapping round POI', () => {
    // Round POI 22 px right of the pin tip: its old image box covered the pin head.
    const candidates = [
      { key: 'round', mask: round, drawRank: 0, placements: [{ x: 122, y: 100, scale: 1 }] },
      { key: 'fav', mask: fav, drawRank: 5, placements: [{ x: 100, y: 100, scale: 1 }] },
    ];
    expect(pickPoiHit(candidates, { x: 100, y: 82 }, 3)).toBe('fav');
    // On the round disc itself, outside the pin: the round POI.
    expect(pickPoiHit(candidates, { x: 128, y: 100 }, 3)).toBe('round');
  });

  it('gives the topmost POI where two drawings overlap', () => {
    const candidates = [
      { key: 'below', mask: round, drawRank: 1, placements: [{ x: 100, y: 100, scale: 1 }] },
      { key: 'above', mask: round, drawRank: 2, placements: [{ x: 106, y: 100, scale: 1 }] },
    ];
    expect(pickPoiHit(candidates, { x: 103, y: 100 }, 3)).toBe('above');
    expect(pickPoiHit(candidates, { x: 92, y: 100 }, 3)).toBe('below');
  });

  it('prefers the nearest POI when none is directly under the pointer', () => {
    const candidates = [
      { key: 'a', mask: round, drawRank: 9, placements: [{ x: 100, y: 100, scale: 1 }] },
      { key: 'b', mask: round, drawRank: 0, placements: [{ x: 124, y: 100, scale: 1 }] },
    ];
    // 1 px from b's edge, 2 px from a's: b despite its lower rank.
    expect(pickPoiHit(candidates, { x: 112.2, y: 100 }, 3)).toBe('b');
  });

  it('scales the mask with the icon size', () => {
    const candidates = [{ key: 'r', mask: round, drawRank: 0, placements: [{ x: 100, y: 100, scale: 0.5 }] }];
    expect(pickPoiHit(candidates, { x: 104, y: 100 }, 0)).toBe('r');
    expect(pickPoiHit(candidates, { x: 110, y: 100 }, 0)).toBeNull();
  });

  it('keeps the hovered POI under the pointer on both of its placements', () => {
    // Hovered: drawn lifted by 4 px and scaled ×1.03; its resting place still counts.
    const placements = [
      { x: 100, y: 100, scale: 1 },
      { x: 100, y: 96, scale: 1.03 },
    ];
    const candidates = [{ key: 'h', mask: round, drawRank: 0, placements }];
    expect(pickPoiHit(candidates, { x: 100, y: 110 }, 0)).toBe('h');
    expect(pickPoiHit(candidates, { x: 100, y: 85 }, 0)).toBe('h');
  });
});
