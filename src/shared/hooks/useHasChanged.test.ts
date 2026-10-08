// @vitest-environment happy-dom
import { useState } from 'react';
import { describe, it, expect } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import { useHasChanged } from './useHasChanged';

describe('useHasChanged', () => {
  it('is false on mount and while the value stays the same', () => {
    const { result, rerender } = renderHook((value: number) => useHasChanged(value), { initialProps: 1 });
    expect(result.current).toBe(false);
    rerender(1);
    expect(result.current).toBe(false);
  });

  it('reports a change on one committed render only (the restarted render sees none)', () => {
    const seen: boolean[] = [];
    const { rerender } = renderHook(
      (value: string) => {
        const changed = useHasChanged(value);
        seen.push(changed);
        return changed;
      },
      { initialProps: 'a' },
    );
    seen.length = 0;
    rerender('b');
    // Rendu avec le changement, puis relance immédiate de React sans lui.
    expect(seen).toEqual([true, false]);
    seen.length = 0;
    rerender('b');
    expect(seen).toEqual([false]);
  });

  it('compares with Object.is', () => {
    const { result, rerender } = renderHook((value: number) => useHasChanged(value), { initialProps: Number.NaN });
    rerender(Number.NaN);
    expect(result.current).toBe(false);
  });

  it('lets a component reset its own state during render when a prop changes', () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        const [armed, setArmed] = useState(true);
        const enabledChanged = useHasChanged(enabled);
        if (enabledChanged && !enabled) setArmed(false);
        return armed;
      },
      { initialProps: { enabled: true }, strict: true },
    );
    expect(result.current).toBe(true);
    rerender({ enabled: false });
    expect(result.current).toBe(false);
    rerender({ enabled: true });
    expect(result.current).toBe(false);
  });
});
