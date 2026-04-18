/**
 * Convert an Expert Mode state into BRouter `profile:xxx` URL overrides.
 *
 * We diff the user values against the parameter defaults: only changed
 * values are sent over the wire, keeping URLs short and the cache hit
 * ratio high.
 */
import { ALL_PARAMETERS } from './parameters';
import type { ExpertProfileState, ParameterValue } from './types';

/**
 * Whitelist of parameters declared as `assign` in the global section of
 * the stock `trekking.brf` shipped with BRouter. Only these can be
 * overridden via the `profile:<id>=value` URL syntax — anything else
 * triggers a server-side "unknown variable" error (HTTP 422 from our
 * proxy). For the remaining knobs the user must upload a full custom
 * profile (Expert Mode → "Téléverser le profil complet").
 */
export const URL_SAFE_PARAMETER_IDS: ReadonlySet<string> = new Set([
  // Behaviour switches
  'allow_steps',
  'allow_ferries',
  'ignore_cycleroutes',
  'stick_to_cycleroutes',
  'use_proposed_cycleroutes',
  'avoid_unsafe',
  'add_beeline',
  'consider_noise',
  'consider_river',
  'consider_forest',
  'consider_town',
  'consider_traffic',
  // Elevation
  'consider_elevation',
  'downhillcost',
  'downhillcutoff',
  'uphillcost',
  'uphillcutoff',
  // Kinematic model
  'totalMass',
  'maxSpeed',
  'S_C_x',
  'C_r',
  'bikerPower',
  // Turn instructions
  'turnInstructionMode',
  'turnInstructionCatchingRange',
  'turnInstructionRoundabouts',
  'considerTurnRestrictions',
  // Engine
  'correctMisplacedViaPoints',
  'correctMisplacedViaPointsDistance',
  'processUnusedTags',
]);

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
  const skipped: string[] = [];
  for (const param of ALL_PARAMETERS) {
    const v = state.values[param.id];
    if (v === undefined || v === null) continue;
    if (eq(v, param.default)) continue;
    if (!URL_SAFE_PARAMETER_IDS.has(param.id)) {
      skipped.push(param.id);
      continue;
    }
    out[param.id] = fmt(v);
  }
  if (skipped.length > 0 && typeof console !== 'undefined') {
    console.warn(
      '[BRouter expert] Ces paramètres ne sont pas déclarés comme `assign` global ' +
        'dans trekking.brf — utilisez "Téléverser le profil complet" pour les appliquer:',
      skipped,
    );
  }
  return out;
}
