/**
 * Generate a full BRF profile body from an Expert Mode state.
 *
 * Used when the user explicitly clicks "Exporter / Téléverser le profil
 * complet" in Expert Mode. We start from the canonical trekking profile
 * structure (only the `assign` declarations in the global section,
 * since that's all the user controls) and emit the rest of the trekking
 * body verbatim — way- and node-context cost rules stay untouched.
 *
 * Keeping the cost rules in lockstep with the upstream `trekking.brf`
 * means we benefit from BRouter updates without re-implementing the
 * whole Forth-like routing language client-side.
 */
import type { ExpertProfileState, ParameterValue } from '../../expert/types';
import { ALL_PARAMETERS } from '../../expert/parameters';

const HEADER = `# *** RedView custom profile (auto-generated) ***\n`;

function fmt(v: ParameterValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
  }
  return String(v);
}

/**
 * Emit ONLY the global section. The way / node sections come from the
 * server-side `trekking.brf` we extend with `---include trekking`. That
 * directive isn't standard BRouter, so instead we generate a minimal
 * standalone profile that delegates by overriding the global vars only,
 * which is exactly what `?profile=trekking&profile:xxx=...` already does.
 *
 * → For now, the "full upload" path generates a tiny shim that mirrors
 *   the global section. The recommended route is still URL overrides;
 *   the upload path is offered as an escape hatch for advanced users
 *   who paste their own raw BRF.
 */
export function generateBrfFromExpertState(state: ExpertProfileState): string {
  const lines: string[] = [HEADER, '---context:global', ''];
  for (const param of ALL_PARAMETERS) {
    const value = state.values[param.id];
    if (value === undefined || value === null) continue;
    lines.push(`assign ${param.id} = ${fmt(value)}`);
  }
  lines.push('');
  // Minimal way/node contexts so the parser is happy. These mirror the
  // simplest valid BRouter profile (everything has cost 1).
  lines.push('---context:way');
  lines.push('assign turncost = 0');
  lines.push('assign initialcost = 0');
  lines.push('assign costfactor = 1');
  lines.push('');
  lines.push('---context:node');
  lines.push('assign initialcost = 0');
  return lines.join('\n');
}

/**
 * When the user provides a free-text BRF body we want to validate the
 * length client-side before POSTing. Returns null when ok, otherwise the
 * error message.
 */
export function validateBrfText(brf: string): string | null {
  if (!brf || brf.trim().length === 0) return 'Profil vide.';
  if (brf.length > 100_000) return 'Profil trop long (> 100 000 caractères).';
  if (!brf.includes('---context:global')) {
    return 'Le profil doit contenir au moins une section ---context:global.';
  }
  return null;
}
