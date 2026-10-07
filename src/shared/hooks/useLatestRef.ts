import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Ref that always holds the value of the last committed render, for callbacks
 * that outlive the render (map events, timers, worker messages) and must read
 * the current props without being re-created.
 *
 * Written in a layout effect, never during render (react-hooks/refs): a render
 * React discards (concurrent rendering, StrictMode's second pass) never leaks
 * into it. Layout effects run before every passive effect of the same commit,
 * so the component's and its children's `useEffect`s already read the new value.
 * Not for reading during render: use the value itself there.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
