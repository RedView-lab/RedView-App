// @vitest-environment happy-dom
import { useEffect } from 'react';
import { describe, it, expect } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import { useKeyedValue } from './useKeyedValue';

interface Props {
  id: string;
  signature: string;
  items: string[];
}

const useInput = ({ id, signature, items }: Props) => useKeyedValue({ id, items }, [id, signature]);

describe('useKeyedValue', () => {
  it('keeps the first object while the keys are unchanged, even when a new one is built', () => {
    const { result, rerender } = renderHook(useInput, {
      initialProps: { id: 'a', signature: 's1', items: ['x'] },
    });
    const first = result.current;
    expect(first).toEqual({ id: 'a', items: ['x'] });
    // New array with the same signature: same object handed back.
    rerender({ id: 'a', signature: 's1', items: ['x'] });
    expect(result.current).toBe(first);
  });

  it('takes the new value as soon as one key changes, then holds it', () => {
    const { result, rerender } = renderHook(useInput, {
      initialProps: { id: 'a', signature: 's1', items: ['x'] },
    });
    rerender({ id: 'a', signature: 's2', items: ['x', 'y'] });
    const second = result.current;
    expect(second).toEqual({ id: 'a', items: ['x', 'y'] });
    rerender({ id: 'a', signature: 's2', items: ['x', 'y'] });
    expect(result.current).toBe(second);
    rerender({ id: 'b', signature: 's2', items: ['z'] });
    expect(result.current).toEqual({ id: 'b', items: ['z'] });
  });

  it('compares keys with Object.is (NaN equal, object keys by identity)', () => {
    const prediction = { km: 10 };
    const { result, rerender } = renderHook(
      ({ key, n }: { key: object; n: number }) => useKeyedValue({ n }, [key, Number.NaN]),
      { initialProps: { key: prediction, n: 1 } },
    );
    const first = result.current;
    rerender({ key: prediction, n: 2 });
    expect(result.current).toBe(first);
    rerender({ key: { km: 10 }, n: 3 });
    expect(result.current).toEqual({ n: 3 });
  });

  it('runs a dependent effect once per key change, not once per render', () => {
    const runs: string[][] = [];
    const { rerender } = renderHook(
      (props: Props) => {
        const input = useInput(props);
        useEffect(() => {
          runs.push(input.items);
        }, [input]);
      },
      { initialProps: { id: 'a', signature: 's1', items: ['x'] }, strict: true },
    );
    const afterMount = runs.length; // StrictMode mounts effects twice
    rerender({ id: 'a', signature: 's1', items: ['x'] });
    rerender({ id: 'a', signature: 's1', items: ['x'] });
    expect(runs.length).toBe(afterMount);
    rerender({ id: 'a', signature: 's2', items: ['x', 'y'] });
    expect(runs.length).toBe(afterMount + 1);
    expect(runs.at(-1)).toEqual(['x', 'y']);
  });
});
