import { afterEach, describe, expect, it, vi } from 'vitest';

const runSnowPipeline = vi.fn();
vi.mock('@/features/snow', () => ({ runSnowPipeline }));
vi.mock('@/shared/lib/analytics', () => ({ trackAnalyticsEvent: vi.fn() }));

import { AromeFetchError } from '@/features/snow/lib/sources/arome';

import { SNOW_SOURCE_INACTIVE_MESSAGE, SNOW_UNAVAILABLE_MESSAGE } from './snowStatus';
import { ViewerSnowController, type SnowSceneContext } from './viewerSnowController';

function context(overrides: Partial<SnowSceneContext> = {}) {
  const renderer = { setSnow: vi.fn(), setSnowMode: vi.fn() };
  const onSnowStatus = vi.fn();
  const ctx = {
    renderer,
    pointCloud: { bounds: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 100, maxZ: 10 } },
    terrainMesh: { heightGrid: new Float32Array(4), gridWidth: 2, gridHeight: 2 },
    crs: 'LAMB93',
    cx: 50,
    cy: 50,
    cz: 0,
    onProgressState: vi.fn(),
    onSnowStatus,
    requestRender: vi.fn(),
    ...overrides,
  } as unknown as SnowSceneContext;
  return { ctx, renderer, onSnowStatus };
}

const field = {
  data: new Float32Array([10, 20, 30, 40]),
  width: 2,
  height: 2,
  stats: { meanCm: 25, maxCm: 40, coveragePct: 100, elapsedMs: 1 },
  arome: { source: 'arome', timestamp: '2026-10-09T12:00:00Z' },
  diagnostics: {
    assimilation: { stations: [], precipitationFactor: 1, braUsed: false },
    wind: { source: 'none', redistributedPct: 0 },
    gravity: { movedPct: 0 },
    melt: { flatMeltCm: 0 },
  },
  sources: {},
};

afterEach(() => {
  runSnowPipeline.mockReset();
  vi.restoreAllMocks();
});

describe('ViewerSnowController', () => {
  it('tells the user when the snow field cannot be computed (no AROME), instead of silently switching off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runSnowPipeline.mockRejectedValue(new Error('Météo-France fetch failed: HTTP 502'));
    const { ctx, renderer, onSnowStatus } = context();
    const modes: string[] = [];

    await new ViewerSnowController().handleSnowModeChange('cover', ctx, (mode) => modes.push(mode));

    expect(onSnowStatus).toHaveBeenCalledWith(SNOW_UNAVAILABLE_MESSAGE);
    expect(modes).toEqual(['off']);
    expect(renderer.setSnowMode).toHaveBeenCalledWith(0);
  });

  it('says the source is not active when the server has no Météo-France key (503)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runSnowPipeline.mockRejectedValue(new AromeFetchError(503, 'Météo-France source not configured'));
    const { ctx, onSnowStatus } = context();

    await new ViewerSnowController().handleSnowModeChange('cover', ctx, () => {});

    expect(onSnowStatus).toHaveBeenCalledWith(SNOW_SOURCE_INACTIVE_MESSAGE);
  });

  it('keeps the general message for an outage or an area outside AROME (502)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runSnowPipeline.mockRejectedValue(new AromeFetchError(502, 'Météo-France WCS fetch failed'));
    const { ctx, onSnowStatus } = context();

    await new ViewerSnowController().handleSnowModeChange('cover', ctx, () => {});

    expect(onSnowStatus).toHaveBeenCalledWith(SNOW_UNAVAILABLE_MESSAGE);
  });

  it('clears the message once the snow field loads (retry after a failure)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new ViewerSnowController();
    const { ctx, onSnowStatus } = context();

    runSnowPipeline.mockRejectedValueOnce(new Error('HTTP 502'));
    await controller.handleSnowModeChange('cover', ctx, () => {});
    runSnowPipeline.mockResolvedValueOnce(field);
    const modes: string[] = [];
    await controller.handleSnowModeChange('cover', ctx, (mode) => modes.push(mode));

    expect(onSnowStatus.mock.calls.map(([message]) => message)).toEqual([SNOW_UNAVAILABLE_MESSAGE, null]);
    expect(modes).toEqual(['cover']);
  });
});
