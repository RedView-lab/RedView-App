import { describe, expect, it } from 'vitest';

import { planFitSelection } from './files';

const fit = (name: string, size = 100) => new File([new Uint8Array(size)], name, { lastModified: 1_700_000_000_000 });

describe('planFitSelection', () => {
  it('adds the readable files and names every refused one', () => {
    const plan = planFitSelection([], [fit('a.fit'), fit('trace.gpx'), fit('vide.fit', 0)], [null, 'not-fit', 'empty'], 20);
    expect(plan.nextFitFiles.map((file) => file.name)).toEqual(['a.fit']);
    expect(plan.added).toBe(1);
    expect(plan.rejected.map(({ file, reason }) => [file.name, reason])).toEqual([['trace.gpx', 'not-fit'], ['vide.fit', 'empty']]);
    expect(plan.overLimit).toEqual([]);
  });

  it('names the files beyond the limit instead of dropping them silently', () => {
    const current = Array.from({ length: 19 }, (_, i) => fit(`old-${i}.fit`));
    const plan = planFitSelection(current, [fit('x.fit'), fit('y.fit'), fit('z.fit')], [null, null, null], 20);
    expect(plan.nextFitFiles).toHaveLength(20);
    expect(plan.added).toBe(1);
    expect(plan.overLimit.map((file) => file.name)).toEqual(['y.fit', 'z.fit']);
  });

  it('adds nothing for duplicates or a full list (no upload, no recompute)', () => {
    const current = [fit('a.fit')];
    expect(planFitSelection(current, [fit('a.fit')], [null], 20).added).toBe(0);
    const full = Array.from({ length: 20 }, (_, i) => fit(`f-${i}.fit`));
    const plan = planFitSelection(full, [fit('new.fit')], [null], 20);
    expect(plan.added).toBe(0);
    expect(plan.overLimit.map((file) => file.name)).toEqual(['new.fit']);
  });

  it('never removes files already loaded above a lowered limit', () => {
    const current = Array.from({ length: 22 }, (_, i) => fit(`f-${i}.fit`));
    expect(planFitSelection(current, [], [], 20).nextFitFiles).toHaveLength(22);
  });
});
