/**
 * Single source of truth for `profile:xxx` URL overrides.
 *
 * BRouter standalone parses every `profile:xxx=value` query argument
 * through `Float.parseFloat`, so:
 *   • booleans MUST be encoded as "1" / "0" (sending "true"/"false"
 *     makes the server reject the value → HTTP 422 from our proxy),
 *   • only parameters declared as a global `assign` in the base BRF
 *     profile (here, stock `trekking.brf`) can be overridden via URL —
 *     anything else triggers a server-side "unknown variable" error.
 *
 * Both the basic Traçage panel and the Expert Mode go through
 * `safeOverride()` so they can never diverge on encoding rules again.
 */

import type { BrouterParamOverrides } from '../types';

export type ParamPrimitive = string | number | boolean;

/**
 * Parameters declared as `assign` in the global section of the stock
 * `trekking.brf` shipped with BRouter — therefore safe to override via
 * the `profile:<id>=value` URL syntax. Everything else must go through
 * a custom BRF upload (Expert Mode → "Téléverser le profil complet").
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

/** Encode any primitive into the BRouter URL wire format. */
export function encodeParamValue(value: ParamPrimitive): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '0';
    return Number.isInteger(value)
      ? String(value)
      : value.toFixed(4).replace(/\.?0+$/, '');
  }
  // Strings: trust the caller, but normalise the common boolean spellings
  // so legacy call-sites that still send "true"/"false" don't crash the
  // server. Anything else is forwarded as-is.
  const s = value.trim();
  if (/^true$/i.test(s)) return '1';
  if (/^false$/i.test(s)) return '0';
  return s;
}

/**
 * Set `out[id] = encodeParamValue(value)` only when `id` is whitelisted
 * AND the value is non-null/non-empty. Returns `out` for chaining.
 *
 * `out` is mutated in place — this is the intended ergonomic in
 * basicStateToOverrides where we build the bag incrementally.
 */
export function safeOverride(
  out: BrouterParamOverrides,
  id: string,
  value: ParamPrimitive | null | undefined,
): BrouterParamOverrides {
  if (value === null || value === undefined) return out;
  if (!URL_SAFE_PARAMETER_IDS.has(id)) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[BRouter] paramètre "${id}" non déclaré comme assign global ` +
          `dans trekking.brf — ignoré (utilisez un profil custom).`,
      );
    }
    return out;
  }
  const encoded = encodeParamValue(value);
  if (encoded === '') return out;
  out[id] = encoded;
  return out;
}

/**
 * Sanitize an externally-built overrides bag (e.g. coming from a UI
 * import or stored preferences). Drops unknown keys and re-encodes
 * any "true"/"false" string values to "1"/"0".
 */
export function sanitizeOverrides(
  raw: BrouterParamOverrides,
): BrouterParamOverrides {
  const out: BrouterParamOverrides = {};
  for (const [k, v] of Object.entries(raw)) {
    safeOverride(out, k, v);
  }
  return out;
}
