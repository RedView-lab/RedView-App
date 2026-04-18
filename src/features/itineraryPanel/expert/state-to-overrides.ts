/**
 * Convert an Expert Mode state into BRouter `profile:xxx` URL overrides.
 *
 * We diff the user values against the parameter defaults: only changed
 * values are sent over the wire, keeping URLs short and the cache hit
 * ratio high.
 */
import { ALL_PARAMETERS } from './parameters';
import type { ExpertProfileState, ParameterValue } from './types';

function fmt(v: ParameterValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? String(v)
      : v.toFixed(4).replace(/\.?0+$/, '');
  }
  return String(v);
}

function eq(a: ParameterValue, b: ParameterValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-6;
  }
  return a === b;
}

export function expertStateToOverrides(
  state: ExpertProfileState,
): Record<string, string> {
  if (!state.enabled) return {};
  const out: Record<string, string> = {};
  for (const param of ALL_PARAMETERS) {
    const v = state.values[param.id];
    if (v === undefined || v === null) continue;
    if (eq(v, param.default)) continue;
    out[param.id] = fmt(v);
  }
  return out;
}
