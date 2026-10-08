import { describe, expect, it } from 'vitest';
import { FrameClock } from '../perf/frameClock';
import { REST_SAMPLES, RestRefinement } from './restRefinement';

const MOVING = 300_000;
const CEILING = 4_000_000;

describe('RestRefinement on a slow GPU', () => {
  it('stops at the first complete still frame slower than the abort threshold', () => {
    const rest = new RestRefinement(true);
    rest.startRefine();
    const stillBudget = rest.budget(MOVING, CEILING);
    // Rastériseur logiciel : une image fixe en pleine résolution prend des secondes.
    rest.onRefineFrame({ lodIdle: true, gpuMs: 3000, budgetLimited: false }, MOVING, CEILING);
    expect(rest.phase).toBe('done');
    expect(rest.pending).toBe(false);
    // La vue fixe suivante démarre plus bas.
    rest.setMoving();
    rest.startRefine();
    expect(rest.budget(MOVING, CEILING)).toBeLessThan(stillBudget);
  });

  it('ignores slow frames while the selection is still loading', () => {
    const rest = new RestRefinement(true);
    rest.startRefine();
    rest.onRefineFrame({ lodIdle: false, gpuMs: 3000, budgetLimited: false }, MOVING, CEILING);
    expect(rest.phase).toBe('refine');
  });

  it('still refines then accumulates every sample on a GPU that keeps up', () => {
    const rest = new RestRefinement(true);
    rest.startRefine();
    for (let i = 0; i < 100 && rest.phase === 'refine'; i++) {
      rest.onRefineFrame({ lodIdle: true, gpuMs: 20, budgetLimited: false }, MOVING, CEILING);
    }
    expect(rest.phase).toBe('accumulate');
    let samples = 0;
    while (rest.phase === 'accumulate' && samples < 100) {
      rest.onAccumulatedFrame(20, MOVING);
      samples++;
    }
    expect(samples).toBe(REST_SAMPLES);
  });
});

describe('FrameClock.lastIntervalMs', () => {
  it('reports slow frames of a continuous run that the cadence treats as pauses', () => {
    const clock = new FrameClock();
    expect(clock.frame(1000)).toBe(0);
    expect(clock.lastIntervalMs).toBe(0);
    expect(clock.frame(1016)).toBe(16);
    expect(clock.lastIntervalMs).toBe(16);
    // Image de 3 s : pas un échantillon de cadence, mais son coût réel.
    expect(clock.frame(4016)).toBe(0);
    expect(clock.lastIntervalMs).toBe(3000);
    clock.pause();
    expect(clock.frame(9000)).toBe(0);
    expect(clock.lastIntervalMs).toBe(0);
  });
});
