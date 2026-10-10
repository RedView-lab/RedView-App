import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrouterBusyError } from '../brouter/api/client';

/**
 * Revêtements d'une trace importée (surfaceAnalysis.ts) : une file BRouter
 * saturée arrête l'analyse comme un 429 — scinder les tronçons multipliait les
 * requêtes vers un serveur plein. Un autre échec scinde toujours le tronçon.
 */

const brouter = vi.hoisted(() => ({ fetchBrouterRoute: vi.fn() }));
vi.mock('../brouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brouter')>()),
  fetchBrouterRoute: brouter.fetchBrouterRoute,
}));

const { analyzeGpxSurfaces } = await import('./surfaceAnalysis');

/** ~110 km plein nord, un point tous les ~110 m : plusieurs tronçons de 35 km. */
const points = Array.from({ length: 1001 }, (_, i) => ({ lat: 44 + i * 0.001, lon: 6, elevationM: 500 }));

afterEach(() => {
  brouter.fetchBrouterRoute.mockReset();
});

describe('analyzeGpxSurfaces : refus de BRouter', () => {
  it('file saturée : analyse arrêtée, aucun tronçon scindé ni relancé', async () => {
    brouter.fetchBrouterRoute.mockRejectedValue(new BrouterBusyError('BRouter HTTP 503'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(analyzeGpxSurfaces(points, { maxConcurrency: 1 })).rejects.toBeInstanceOf(BrouterBusyError);
    expect(brouter.fetchBrouterRoute).toHaveBeenCalledTimes(1);
  });

  it('autre échec : le tronçon est scindé en deux et réessayé', async () => {
    brouter.fetchBrouterRoute.mockRejectedValue(new Error('BRouter HTTP 500: target island detected'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await analyzeGpxSurfaces(points.slice(0, 200), { maxConcurrency: 1 });
    expect(brouter.fetchBrouterRoute.mock.calls.length).toBeGreaterThan(1);
    expect(result.surfaceBreakdownKm.unknown).toBeGreaterThan(0);
  });
});
