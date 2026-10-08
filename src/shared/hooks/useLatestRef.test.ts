// @vitest-environment happy-dom
import { Component, act, createElement, useEffect, useLayoutEffect, type ReactNode, type RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';

import { renderHook } from '@/shared/test/renderHook';
import { useLatestRef } from './useLatestRef';

describe('useLatestRef', () => {
  it('holds the initial value on mount and keeps one ref object', () => {
    const { result, rerender } = renderHook((value: number) => useLatestRef(value), { initialProps: 1 });
    const first = result.current;
    expect(first.current).toBe(1);
    rerender(2);
    expect(result.current).toBe(first);
    expect(first.current).toBe(2);
  });

  it('is up to date in every passive effect and later layout effect of the same commit', () => {
    const seenInEffect: string[] = [];
    const seenInLayout: string[] = [];
    const { rerender } = renderHook(
      (value: string) => {
        const ref = useLatestRef(value);
        useLayoutEffect(() => {
          seenInLayout.push(ref.current);
        }, [ref, value]);
        useEffect(() => {
          seenInEffect.push(ref.current);
        }, [ref, value]);
      },
      { initialProps: 'a' },
    );
    rerender('b');
    rerender('c');
    expect(seenInLayout).toEqual(['a', 'b', 'c']);
    expect(seenInEffect).toEqual(['a', 'b', 'c']);
  });

  it('gives a callback created on the first render the latest committed value', () => {
    const { result, rerender } = renderHook(
      (value: { zoom: number }) => {
        const ref = useLatestRef(value);
        // Callback stable, comme celui passé une fois à map.on().
        return { ref, read: () => ref.current.zoom };
      },
      { initialProps: { zoom: 5 } },
    );
    const firstRead = result.current.read;
    rerender({ zoom: 9 });
    expect(firstRead()).toBe(9);
  });

  it('works under StrictMode (double render, effects re-run)', () => {
    const { result, rerender } = renderHook((value: number) => useLatestRef(value), {
      initialProps: 10,
      strict: true,
    });
    rerender(11);
    expect(result.current.current).toBe(11);
  });

  it('never exposes the value of a render that React discarded', () => {
    // Une affectation pendant le rendu (`ref.current = value`) laisserait 'boom'
    // dans la réf alors que ce rendu n'a jamais été validé.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }
    let captured: RefObject<string> | null = null;
    function Probe({ value }: { value: string }) {
      const ref = useLatestRef(value);
      captured ??= ref;
      if (value === 'boom') throw new Error('render failed');
      return null;
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.createElement('div'));
    const tree = (value: string) => createElement(Boundary, null, createElement(Probe, { value }));
    act(() => root.render(tree('ok')));
    act(() => root.render(tree('boom')));
    expect(captured!.current).toBe('ok');
    act(() => root.unmount());
  });
});
