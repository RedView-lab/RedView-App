/**
 * Mode expert — types et métadonnées des paramètres.
 *
 * Le mode expert permet à un utilisateur avancé de régler CHAQUE paramètre
 * BRouter exposé sans quitter le panneau. Chaque paramètre a :
 *
 *   - id          → nom de variable BRF (utilisé pour la surcharge d'URL
 *                   `profile:<id>=<value>` et dans le corps BRF généré).
 *   - label       → libellé d'interface en français.
 *   - hint        → courte infobulle / texte d'aide.
 *   - group       → la section repliable à laquelle il appartient.
 *   - kind        → boolean | number | enum.
 *   - bounds      → min / max / pas numériques (curseurs de l'interface).
 *   - choices     → options d'énumération (listes de l'interface).
 *   - default     → valeur de départ quand l'utilisateur passe en mode expert.
 *   - advanced    → à true, masqué derrière « Afficher tous les paramètres ».
 */

export type ParameterValue = boolean | number | string;

type ParameterKind = 'boolean' | 'number' | 'enum';

type ParameterGroup =
  | 'comportement'
  | 'elevation'
  | 'cinematique'
  | 'instructions'
  | 'moteur';

interface ParameterChoice {
  value: string | number;
  label: string;
}

export interface ParameterDefinition {
  id: string;
  label: string;
  hint?: string;
  group: ParameterGroup;
  kind: ParameterKind;
  default: ParameterValue;
  /** Bornes numériques. Requises quand kind === 'number'. */
  min?: number;
  max?: number;
  step?: number;
  /** Suffixe affiché après la saisie (« m », « % », « km/h », …). */
  unit?: string;
  /** Options d'énumération. Requises quand kind === 'enum'. */
  choices?: ParameterChoice[];
  /** Masqué derrière l'interrupteur « Afficher avancés ». */
  advanced?: boolean;
}

/**
 * L'état du profil expert vit sur chaque `Itinerary`. Quand `enabled` est faux,
 * on ignore entièrement `values` et on se rabat sur les réglages de Traçage
 * simples. Quand il est vrai, les valeurs sont envoyées en surcharges d'URL
 * par-dessus le préréglage actif.
 */
export interface ExpertProfileState {
  enabled: boolean;
  /** id → valeur choisie par l'utilisateur. Clés absentes = `default` du paramètre. */
  values: Record<string, ParameterValue>;
  /**
   * Optionnel : texte BRF brut collé par l'utilisateur dans l'éditeur. Quand il
   * est posé, l'envoi l'emporte sur `values` et produit un profil `custom_<id>`
   * utilisé dans les requêtes de tracé suivantes.
   */
  rawBrf?: string;
  /** Id du dernier profil personnalisé envoyé avec succès (en cache). */
  uploadedProfileId?: string;
  /** Hachage du dernier BRF envoyé — sert à sauter les envois en double. */
  uploadedHash?: string;
}

