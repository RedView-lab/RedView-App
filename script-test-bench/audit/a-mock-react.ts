/**
 * Audit A — React minimal pour exécuter un hook « une fois » hors rendu
 * (a-persistence-sim.ts, scénarios H*) : refs persistantes, callbacks tels
 * quels, effets exécutés immédiatement (nettoyages ignorés).
 */
export function useRef<T>(initial: T): { current: T } {
  return { current: initial };
}
export function useCallback<T>(fn: T): T {
  return fn;
}
export function useMemo<T>(factory: () => T): T {
  return factory();
}
export function useEffect(effect: () => void | (() => void)): void {
  effect();
}
export const useLayoutEffect = useEffect;
export function useState<T>(initial: T | (() => T)): [T, (next: T) => void] {
  const value = typeof initial === 'function' ? (initial as () => T)() : initial;
  return [value, () => undefined];
}
export function useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T): T {
  return getSnapshot();
}
export function createContext<T>(defaultValue: T): { _value: T; Provider: unknown } {
  return { _value: defaultValue, Provider: null };
}
export function useContext<T>(context: { _value: T }): T {
  return context._value;
}
export default { createContext, useContext, useRef, useCallback, useMemo, useEffect, useLayoutEffect, useState, useSyncExternalStore };
