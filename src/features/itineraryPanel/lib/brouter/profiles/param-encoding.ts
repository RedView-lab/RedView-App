/**
 * Source unique de vérité des surcharges d'URL `profile:xxx`.
 *
 * BRouter autonome parse chaque argument de requête `profile:xxx=value` avec
 * `Float.parseFloat`, donc :
 *   • les booléens DOIVENT être encodés en "1" / "0" (envoyer "true"/"false"
 *     fait rejeter la valeur par le serveur → HTTP 422 de notre proxy),
 *   • seuls les paramètres déclarés en `assign` global dans le profil BRF de
 *     base (ici, le `trekking.brf` d'origine) peuvent être surchargés par URL —
 *     tout le reste déclenche une erreur « unknown variable » côté serveur.
 *
 * Le panneau Traçage simple et le mode expert passent tous deux par
 * `safeOverride()` pour ne plus jamais diverger sur les règles d'encodage.
 */

import type { BrouterParamOverrides } from '../types';

type ParamPrimitive = string | number | boolean;

/**
 * Paramètres déclarés en `assign` dans la section globale du `trekking.brf`
 * d'origine livré avec BRouter — donc sûrs à surcharger avec la syntaxe d'URL
 * `profile:<id>=value`. Tout le reste doit passer par l'envoi d'un BRF
 * personnalisé (mode expert → « Téléverser le profil complet »).
 */
const URL_SAFE_PARAMETER_IDS: ReadonlySet<string> = new Set([
  // Bascules de comportement
  'allow_steps',
  'allow_ferries',
  'ignore_cycleroutes',
  'stick_to_cycleroutes',
  'use_proposed_cycleroutes',
  'avoid_unsafe',
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
  // Modèle cinématique
  'totalMass',
  'maxSpeed',
  'S_C_x',
  'C_r',
  'bikerPower',
  // Instructions de virage
  'turnInstructionMode',
  'turnInstructionCatchingRange',
  'turnInstructionRoundabouts',
  'considerTurnRestrictions',
  // Engine
  'correctMisplacedViaPoints',
  'correctMisplacedViaPointsDistance',
  'processUnusedTags',
]);

/** Encode toute valeur primitive au format d'URL de BRouter. */
function encodeParamValue(value: ParamPrimitive): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '0';
    return Number.isInteger(value)
      ? String(value)
      : value.toFixed(4).replace(/\.?0+$/, '');
  }
  // Chaînes : faire confiance à l'appelant, mais normaliser les écritures
  // courantes des booléens pour que les anciens appels qui envoient encore
  // "true"/"false" ne fassent pas planter le serveur. Le reste est transmis tel quel.
  const s = value.trim();
  if (/^true$/i.test(s)) return '1';
  if (/^false$/i.test(s)) return '0';
  return s;
}

/**
 * Pose `out[id] = encodeParamValue(value)` seulement si `id` est en liste
 * blanche ET que la valeur n'est ni nulle ni vide. Renvoie `out` pour chaîner.
 *
 * `out` est modifié sur place — c'est l'ergonomie voulue dans
 * basicStateToOverrides, où l'on construit le sac au fur et à mesure.
 */
function safeOverride(
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
 * Assainit un sac de surcharges construit ailleurs (par ex. venant d'un import
 * de l'interface ou de préférences stockées). Écarte les clés inconnues et
 * réencode toute valeur texte "true"/"false" en "1"/"0".
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
