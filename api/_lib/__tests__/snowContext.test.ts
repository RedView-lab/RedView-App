import { gzipSync } from 'node:zlib';

import { describe, it, expect, vi, afterEach } from 'vitest';

import type { ApiRequest, ApiResponse } from '../types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadModule() {
  vi.resetModules();
  return import('../../snow-context');
}

function call(handler: (req: ApiRequest, res: ApiResponse) => unknown, query: Record<string, string>): Promise<number> {
  let status = 200;
  const res = {
    status(code: number) { status = code; return res; },
    setHeader() { return res; },
    json() { return res; },
    end() { return res; },
  } as unknown as ApiResponse;
  return Promise.resolve(handler({ method: 'GET', query, headers: {} } as unknown as ApiRequest, res)).then(() => status);
}

describe('api/snow-context', () => {
  it('ne suit que des URL de fichiers Météo-France sur un hôte connu, en https (A11-2)', async () => {
    const { isAllowedMfFileUrl } = await loadModule();
    expect(isAllowedMfFileUrl('https://meteofrance.s3.sbg.io.cloud.ovh.net/clim/H_74_latest-2025-2026.csv.gz')).toBe(true);
    expect(isAllowedMfFileUrl('https://object.files.data.gouv.fr/meteofrance/H_74_latest-2025-2026.csv.gz')).toBe(true);
    expect(isAllowedMfFileUrl('http://meteofrance.s3.sbg.io.cloud.ovh.net/H_74_latest-2025-2026.csv.gz')).toBe(false);
    expect(isAllowedMfFileUrl('https://169.254.169.254/latest/H_74_latest-2025-2026.csv.gz')).toBe(false);
    expect(isAllowedMfFileUrl('https://evil.example/H_74_latest-2025-2026.csv.gz')).toBe(false);
    expect(isAllowedMfFileUrl('https://user:pw@meteofrance.s3.sbg.io.cloud.ovh.net/H_74_latest-2025-2026.csv.gz')).toBe(false);
    expect(isAllowedMfFileUrl('https://meteofrance.s3.sbg.io.cloud.ovh.net:8443/H_74_latest-2025-2026.csv.gz')).toBe(false);
    expect(isAllowedMfFileUrl('pas une url')).toBe(false);
  });

  it('des coordonnées qui tournent sur 30 départements ne font relire chaque fichier qu’une fois (A11-1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const csv = gzipSync('NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMMJJHH;NEIGETOT\n1;X;45.1;6.1;1800;2026101006;12\n');
    const depts = Array.from({ length: 30 }, (_, index) => String(10 + index));
    const fileFetches = new Map<string, number>();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://geo.api.gouv.fr/')) {
        // Département choisi par la latitude : un département par dixième de degré.
        const lat = Number(new URL(url).searchParams.get('lat'));
        const dept = depts[Math.min(29, Math.max(0, Math.round((lat - 44) * 10)))];
        return Response.json([{ codeDepartement: dept }]);
      }
      if (url.startsWith('https://www.data.gouv.fr/')) {
        return Response.json({ resources: [
          ...depts.map((dept) => ({ url: `https://object.files.data.gouv.fr/meteofrance/H_${dept}_latest-2025-2026.csv.gz` })),
          { url: 'https://evil.example/H_99_latest-2025-2026.csv.gz' },
        ] });
      }
      const file = /H_(\d+)_latest/.exec(url);
      if (file) {
        fileFetches.set(file[1], (fileFetches.get(file[1]) ?? 0) + 1);
        return new Response(csv, { status: 200 });
      }
      return new Response('down', { status: 503 });
    }));
    const { default: handler } = await loadModule();
    for (let round = 0; round < 2; round += 1) {
      for (let index = 0; index < 30; index += 1) {
        const lat = (44 + index / 10).toFixed(4);
        expect(await call(handler, { lat, lon: '6.0', radiusKm: '5' })).toBe(200);
      }
    }
    expect(fileFetches.size).toBe(30);
    expect([...fileFetches.values()].every((count) => count === 1)).toBe(true);
  });
});
