import { describe, expect, it } from 'vitest';

import { isUniformImage } from './mapThumbnail';

/**
 * Miniature de projet : une capture d'une seule couleur (carte pas encore
 * dessinée, tampon WebGL vidé) n'est pas envoyée — elle remplaçait la bonne.
 */

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return data;
}

describe('isUniformImage', () => {
  it('fond seul (carte pas dessinée) ou bruit d’encodage : uniforme', () => {
    expect(isUniformImage(image(320, 180, () => [20, 20, 20]))).toBe(true);
    expect(isUniformImage(image(320, 180, (x, y) => [20 + ((x + y) % 3), 20, 21]))).toBe(true);
  });

  it('une carte, même sombre et presque unie (océan avec un tracé) : pas uniforme', () => {
    expect(isUniformImage(image(320, 180, (x) => (x > 150 && x < 170 ? [200, 30, 30] : [10, 30, 60])))).toBe(false);
    expect(isUniformImage(image(320, 180, (_x, y) => [Math.round(y / 2), 40, 40]))).toBe(false);
  });
});
