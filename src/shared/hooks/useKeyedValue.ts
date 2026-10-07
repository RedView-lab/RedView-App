import { useState } from 'react';

/**
 * `value` as it was on the render where `keys` last changed (compared one by
 * one with `Object.is`): later renders give back that same object even when
 * they build a new one, until a key changes.
 *
 * For an object whose identity drives an effect and must follow a narrower
 * notion of change than its own fields (e.g. an upload list compared by its
 * signature). Unlike `useMemo`, whose cache React may drop, the identity is
 * guaranteed. Stored as state (« information from previous renders »): the
 * render where a key changes is restarted once by React before its children.
 */
export function useKeyedValue<T>(value: T, keys: readonly unknown[]): T {
  const [entry, setEntry] = useState(() => ({ value, keys }));
  if (sameKeys(entry.keys, keys)) return entry.value;
  setEntry({ value, keys });
  return value;
}

function sameKeys(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((key, index) => Object.is(key, b[index]));
}
