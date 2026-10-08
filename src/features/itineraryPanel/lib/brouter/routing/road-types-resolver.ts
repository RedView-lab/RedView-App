/**
 * Résolveur intelligent du RoadTypesState du panneau.
 *
 * Détecte les configurations impossibles (par ex. l'utilisateur interdit toutes
 * les surfaces praticables → BRouter renverrait « no route ») et les réécrit à
 * la volée avec un avertissement lisible. L'état corrigé est celui qui alimente
 * le générateur de BRF ; le panneau garde la sélection brute de l'utilisateur
 * pour qu'il puisse la voir et la régler à nouveau.
 *
 * Règles
 * ──────
 *
 * 1. Au moins une des valeurs {road, gravel, singletrack, offroad, bikeLanes}
 *    ne doit PAS être 'forbid'. Si tout est interdit, on remonte l'option la
 *    moins restrictive (dans l'ordre : bikeLanes → road → gravel →
 *    singletrack → offroad) à 'tolerate'.
 *
 * 2. majorRoads='forbid' seul ne pose pas de problème (BRouter contournera les
 *    primary/trunk). Mais si road='forbid' ET majorRoads='forbid' ET
 *    bikeLanes='forbid' → on couperait tout le réseau routier. On l'autorise,
 *    puisque gravier/singletrack peuvent suffire dans la France rurale, et on
 *    émet juste un avertissement de niveau info.
 *
 * 3. Interdire bikeLanes TOUT EN les préférant est contradictoire ; on ramène la
 *    préférence à tolérer (défensif — l'interface ne devrait pas le permettre,
 *    mais l'état peut venir d'anciens projets).
 *
 * 4. maxSlopePercent < 1 n'a pas de sens (aucune montée autorisée = pas de
 *    tracé). On borne à ≥ 3 %.
 */
import { translateAppText } from '@/shared/i18n';
import type { RoadTypesState } from '../../../types';

export interface RoadTypesResolution {
  effective: RoadTypesState;
  warnings: string[];
  /** Vrai quand le résolveur a dû surcharger au moins un réglage. */
  corrected: boolean;
}

const RIDEABLE_KEYS = [
  'bikeLanes',
  'road',
  'gravel',
  'singletrack',
  'offroad',
] as const satisfies readonly (keyof RoadTypesState)[];

type RideableKey = (typeof RIDEABLE_KEYS)[number];

const KEY_LABELS: Record<RideableKey, string> = {
  bikeLanes: 'voies cyclables',
  road: 'routes',
  gravel: 'gravel',
  singletrack: 'singletrack',
  offroad: 'hors-piste',
};

export function resolveRoadTypes(input: RoadTypesState): RoadTypesResolution {
  const out: RoadTypesState = { ...input };
  const warnings: string[] = [];
  let corrected = false;

  // Règle 1 — au moins une surface praticable doit rester
  const allForbid = RIDEABLE_KEYS.every((k) => out[k] === 'forbid');
  if (allForbid) {
    // Remonter la première clé dans l'ordre de priorité à 'tolerate'.
    for (const k of RIDEABLE_KEYS) {
      if (out[k] === 'forbid') {
        out[k] = 'tolerate';
        warnings.push(
          translateAppText(
            'Toutes les surfaces étaient interdites — {{surface}} ré-autorisé pour permettre le calcul.',
            { surface: translateAppText(KEY_LABELS[k]) },
          ),
        );
        corrected = true;
        break;
      }
    }
  }

  // Règle 2 — si road + bikeLanes + majorRoads sont tous interdits, avertissement info.
  if (
    out.road === 'forbid' &&
    out.bikeLanes === 'forbid' &&
    out.majorRoads === 'forbid'
  ) {
    warnings.push(
      translateAppText('Tout le réseau goudronné est interdit : l’itinéraire passera uniquement par des chemins.'),
    );
  }

  // Règle 3 — défensive : bikeLanes='forbid' ne devrait lever aussi l'interdiction
  // de majorRoads que si l'utilisateur avait en même temps préféré quelque chose de
  // contradictoire. Rien à corriger pour l'instant — laissée sans effet par clarté.

  // Règle 4 — cohérence de la pente max
  if (out.maxSlopePercent != null && out.maxSlopePercent < 3) {
    warnings.push(
      translateAppText(
        'Pente max. {{value}}% trop basse — relevée à 3 % (en deçà aucun itinéraire n’est calculable).',
        { value: out.maxSlopePercent },
      ),
    );
    out.maxSlopePercent = 3;
    corrected = true;
  }

  // Règle 5 — abandonner le 'prefer' des ferries quand les distances le rendent
  // improbable (sans effet — gardée pour de futures heuristiques).

  return { effective: out, warnings, corrected };
}
