import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFixtureCog, decodeRgbaPng, fixtureFetch } from './operaFixture';

type OperaModule = typeof import('../opera-radar.mjs');

/** Module neuf (caches vides) pour chaque test. */
async function loadOpera(): Promise<OperaModule> {
  vi.resetModules();
  return import('../opera-radar.mjs');
}

const NOW = new Date(Date.UTC(2026, 9, 9, 13, 22));
/** Une image toutes les 5 minutes de 11:55 à 13:20 UTC. */
const FRAMES = Array.from({ length: 18 }, (_, i) => {
  const minutes = 11 * 60 + 55 + i * 5;
  return `20261009T${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
});

/** Pixel (dans la tuile z/x/y de 512 px) d'un point lon/lat. */
function pixelOf(lon: number, lat: number, z: number, x: number, y: number) {
  const world = 512 * 2 ** z;
  const px = ((lon + 180) / 360) * world - x * 512;
  const mercY = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const py = ((1 - mercY / Math.PI) / 2) * world - y * 512;
  return Math.floor(py) * 512 + Math.floor(px);
}

describe('projection OPERA (azimutale équivalente de Lambert, 55° N 10° E)', () => {
  it('place le centre de la projection sur les fausses coordonnées', async () => {
    const { projectToOpera } = await loadOpera();
    const [e, n] = projectToOpera(10, 55);
    expect(e).toBeCloseTo(1_950_000, 3);
    expect(n).toBeCloseTo(-2_100_000, 3);
  });

  it('respecte les distances près du centre (1° de longitude ≈ 64 km à 55° N)', async () => {
    const { projectToOpera } = await loadOpera();
    const [e] = projectToOpera(11, 55);
    expect(e - 1_950_000).toBeGreaterThan(63_500);
    expect(e - 1_950_000).toBeLessThan(64_500);
  });
});

describe('images et chemins', () => {
  it('ne garde que les composites de réflectivité en GeoTIFF', async () => {
    const { parseFrameListing } = await loadOpera();
    const xml = '<Key>2026/10/09/OPERA/COMP/OPERA@20261009T1315@0@DBZH.tiff</Key><Key>2026/10/09/OPERA/COMP/OPERA@20261009T1315@0@DBZH.h5</Key><Key>2026/10/09/OPERA/COMP/OPERA@20261009T1315@0@RATE.tiff</Key>';
    expect(parseFrameListing(xml)).toEqual(['20261009T1315']);
  });

  it('n’accepte qu’un chemin /opera/AAAAMMJJTHHMM', async () => {
    const { operaFrameFromPath } = await loadOpera();
    expect(operaFrameFromPath('/opera/20261009T1315')).toBe('20261009T1315');
    expect(operaFrameFromPath('opera/20261009T1315')).toBe('20261009T1315');
    for (const path of ['/opera/../../etc', '/v2/radar/1700000000', '/opera/20261009T1315/x', '', null]) {
      expect(operaFrameFromPath(path)).toBeNull();
    }
  });

  it('convertit la réflectivité en pluie avec Marshall-Palmer (Z = 200 R^1,6)', async () => {
    const { rainRateFromDbz } = await loadOpera();
    expect(rainRateFromDbz(10 * Math.log10(200))).toBeCloseTo(1, 6);
    expect(rainRateFromDbz(40)).toBeCloseTo(11.53, 1);
  });
});

describe('lecture du COG et tuiles', () => {
  let cog: Buffer;
  let fetchMock: ReturnType<typeof vi.fn<ReturnType<typeof fixtureFetch>>>;

  beforeEach(() => {
    cog = buildFixtureCog();
    fetchMock = vi.fn(fixtureFetch(cog, FRAMES));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lit les niveaux, l’origine et la taille de pixel d’un GeoTIFF tuilé', async () => {
    const { parseCogHeader } = await loadOpera();
    const header = parseCogHeader(cog);
    expect(header.pixelSize).toBe(1000);
    expect(header.levels).toHaveLength(1);
    expect(header.levels[0]).toMatchObject({ width: 1024, height: 1024, tileWidth: 512, tileHeight: 512, samples: 2 });
    expect(header.levels[0].tileOffsets).toHaveLength(4);
  });

  it('demande un en-tête plus long quand ses tableaux dépassent les octets lus', async () => {
    const { parseCogHeader } = await loadOpera();
    let error: unknown;
    try {
      parseCogHeader(cog.subarray(0, 100));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RangeError);
    expect((error as { needBytes: number }).needBytes).toBeGreaterThan(100);
  });

  it('propose la dernière heure (12 images), la plus récente en dernier, gardée une minute', async () => {
    const { listOperaFrames } = await loadOpera();
    const frames = await listOperaFrames(NOW);
    expect(frames).toHaveLength(12);
    expect(frames.at(-1)).toEqual({ time: Date.UTC(2026, 9, 9, 13, 20) / 1000, path: '/opera/20261009T1320' });
    expect(frames[0].path).toBe('/opera/20261009T1225');
    await listOperaFrames(NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dessine la pluie, laisse transparents « rien détecté » et « hors couverture », et ne lit que ce qu’il faut', async () => {
    const { renderOperaTile } = await loadOpera();
    const png = await renderOperaTile('20261009T1320', 6, 32, 22, '');
    const { width, pixels } = decodeRgbaPng(png);
    expect(width).toBe(512);
    const alphaAt = (lon: number, lat: number) => pixels[pixelOf(lon, lat, 6, 32, 22) * 4 + 3];
    expect(alphaAt(1, 47.5)).toBe(255); // 40 dBZ
    expect(alphaAt(4, 47.5)).toBe(0); // NaN : couvert, rien détecté
    expect(alphaAt(1, 45.5)).toBe(0); // hors couverture
    expect(alphaAt(4, 45.5)).toBe(255); // 20 dBZ
    const colorAt = (lon: number, lat: number) => [...pixels.subarray(pixelOf(lon, lat, 6, 32, 22) * 4, pixelOf(lon, lat, 6, 32, 22) * 4 + 3)];
    expect(colorAt(1, 47.5)).not.toEqual(colorAt(4, 45.5));

    // En-tête (une plage) + les 4 tuiles du COG, chacune lue une seule fois.
    const ranges = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('range'));
    expect(ranges.filter(Boolean)).toHaveLength(5);
    await renderOperaTile('20261009T1320', 6, 32, 22, '');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('image hors de la fenêtre du bucket (trop vieille, future) : aucune requête amont (A12-1)', async () => {
    const { renderOperaTile } = await loadOpera();
    await expect(renderOperaTile('20250101T0000', 6, 32, 22, '')).rejects.toThrow(/outside/);
    await expect(renderOperaTile('20261010T1300', 6, 32, 22, '')).rejects.toThrow(/outside/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('image absente : l’échec est gardé, les tuiles suivantes ne rappellent pas le bucket (A12-1)', async () => {
    const { renderOperaTile } = await loadOpera();
    fetchMock.mockImplementation(async () => new Response('nope', { status: 404 }));
    for (const [x, y] of [[32, 22], [33, 22], [32, 23]]) {
      await expect(renderOperaTile('20261009T1317', 6, x, y, '')).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('colore avec la palette de l’utilisateur', async () => {
    const { renderOperaTile } = await loadOpera();
    const red = decodeRgbaPng(await renderOperaTile('20261009T1320', 6, 32, 22, 'fill:ff0000_0_100'));
    const at = pixelOf(1, 47.5, 6, 32, 22) * 4;
    expect([...red.pixels.subarray(at, at + 4)]).toEqual([255, 0, 0, 255]);
  });
});
