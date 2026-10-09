import { describe, expect, it, vi } from 'vitest';

/**
 * Sans l'analyse AROME il n'y a pas de champ de neige : son échec arrête le
 * pipeline tout de suite et annule les deux autres sources. Le contexte
 * (stations, BRA, 60 jours de météo) prenait jusqu'à ~16 s à froid en prod,
 * et la personne attendait tout ce temps pour lire « source indisponible ».
 */

const loads = vi.hoisted(() => ({ signals: [] as AbortSignal[] }));

/** Ne se termine qu'à l'annulation de sa requête, comme un fetch lent. */
function pendingUntilAborted(signal?: AbortSignal): Promise<never> {
  if (signal) loads.signals.push(signal);
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

vi.mock('./lib/sources/arome', () => ({
  fetchAromeSnow: async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw Object.assign(new Error('Météo-France fetch failed: HTTP 503 Météo-France source not configured'), { status: 503 });
  },
}));
vi.mock('./lib/sources/context', () => ({
  fetchSnowContext: (_center: unknown, _altitude: number, signal?: AbortSignal) => pendingUntilAborted(signal),
}));
vi.mock('./lib/sources/terrarium', () => ({
  terrariumSupported: () => true,
  farFieldDem: (...args: unknown[]) => pendingUntilAborted(args[5] as AbortSignal | undefined),
  coarseOrography: async () => [],
}));

const { runSnowPipeline } = await import('./index');

describe('runSnowPipeline', () => {
  it('échoue dès qu’AROME échoue, sans attendre le contexte ni le relief lointain, et les annule', async () => {
    const started = performance.now();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(runSnowPipeline({
        data: new Float32Array(4).fill(10),
        width: 2,
        height: 2,
        bounds: { minX: 950_000, minY: 6_499_000, maxX: 951_000, maxY: 6_500_000 },
        crs: 'LAMB93',
        altitudeOffsetM: 1500,
      })).rejects.toThrow(/HTTP 503/);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(loads.signals).toHaveLength(2);
    expect(loads.signals.every((signal) => signal.aborted)).toBe(true);
    expect(unhandled).toEqual([]);
  });
});
