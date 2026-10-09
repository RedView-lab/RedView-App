import { afterEach, describe, expect, it, vi } from 'vitest';

import { prefersRetinaSatellite, transformMapboxRequest } from './satelliteTiles';

const TILE = 'https://api.mapbox.com/v4/mapbox.satellite/15/16823/11738.webp?sku=abc&access_token=pk';

describe('prefersRetinaSatellite', () => {
  it('garde le @2x sans information sur la connexion (Firefox, Safari) ou sur une bonne connexion', () => {
    expect(prefersRetinaSatellite(undefined)).toBe(true);
    expect(prefersRetinaSatellite({ effectiveType: '4g', downlink: 10 })).toBe(true);
    expect(prefersRetinaSatellite({ effectiveType: '4g' })).toBe(true);
  });

  it('pas de @2x en économie de données, en 2G / 3G ou sous 5 Mbit/s estimés', () => {
    expect(prefersRetinaSatellite({ saveData: true, effectiveType: '4g', downlink: 10 })).toBe(false);
    expect(prefersRetinaSatellite({ effectiveType: '3g', downlink: 8 })).toBe(false);
    expect(prefersRetinaSatellite({ effectiveType: 'slow-2g' })).toBe(false);
    expect(prefersRetinaSatellite({ effectiveType: '4g', downlink: 1.6 })).toBe(false);
  });
});

describe('transformMapboxRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('demande la tuile satellite @2x sur une bonne connexion, l’originale sur une liaison lente', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g', downlink: 10 } });
    expect(transformMapboxRequest(TILE, 'Tile').url).toBe(TILE.replace('11738.webp', '11738@2x.webp'));
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g', downlink: 1.6 } });
    expect(transformMapboxRequest(TILE, 'Tile').url).toBe(TILE);
  });

  it('ne touche ni aux autres ressources ni aux autres tuiles', () => {
    vi.stubGlobal('navigator', {});
    const style = 'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12';
    expect(transformMapboxRequest(style, 'Style').url).toBe(style);
    const vector = 'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/15/16823/11738.vector.pbf';
    expect(transformMapboxRequest(vector, 'Tile').url).toBe(vector);
    expect(transformMapboxRequest(TILE.replace('11738.webp', '11738@2x.webp'), 'Tile').url).toBe(TILE.replace('11738.webp', '11738@2x.webp'));
  });
});
