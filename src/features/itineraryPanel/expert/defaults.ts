/**
 * Defaults for Expert Mode.
 *
 * `createDefaultExpertState()` returns the same values as the stock
 * `trekking.brf` would: turning the toggle on without changing anything
 * yields the same route as basic mode (modulo the basic-mode mapping
 * heuristics).
 */
import { ALL_PARAMETERS } from './parameters';
import type { ExpertProfileState, ParameterValue } from './types';

export function createDefaultExpertValues(): Record<string, ParameterValue> {
  const out: Record<string, ParameterValue> = {};
  for (const p of ALL_PARAMETERS) out[p.id] = p.default;
  return out;
}

export function createDefaultExpertState(): ExpertProfileState {
  return {
    enabled: false,
    values: createDefaultExpertValues(),
  };
}
