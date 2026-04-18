/**
 * Expert Mode — types & parameter metadata.
 *
 * The Expert Mode lets a power-user tweak EVERY exposed BRouter
 * parameter without leaving the panel. Each parameter has:
 *
 *   - id          → BRF variable name (used for `profile:<id>=<value>` URL
 *                   override and inside the generated BRF body).
 *   - label       → French UI label.
 *   - hint        → short tooltip / helper text.
 *   - group       → which collapsible section it belongs to.
 *   - kind        → boolean | number | enum.
 *   - bounds      → numeric min / max / step (UI sliders).
 *   - choices     → enum options (UI selects).
 *   - default     → starting value when the user opts into Expert Mode.
 *   - advanced    → when true, hidden behind "Afficher tous les paramètres".
 */

export type ParameterValue = boolean | number | string;

export type ParameterKind = 'boolean' | 'number' | 'enum';

export type ParameterGroup =
  | 'comportement'
  | 'elevation'
  | 'cinematique'
  | 'instructions'
  | 'moteur';

export interface ParameterChoice {
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
  /** Numeric bounds. Required when kind === 'number'. */
  min?: number;
  max?: number;
  step?: number;
  /** Suffix shown after the input ("m", "%", "km/h", …). */
  unit?: string;
  /** Enum options. Required when kind === 'enum'. */
  choices?: ParameterChoice[];
  /** Hidden behind the "Afficher avancés" toggle. */
  advanced?: boolean;
}

/**
 * The Expert profile state lives on each `Itinerary`. When `enabled`
 * is false we ignore `values` entirely and fall back to the basic
 * Traçage controls. When true, the values are sent as URL overrides on
 * top of the active preset.
 */
export interface ExpertProfileState {
  enabled: boolean;
  /** id → user-set value. Missing keys = use parameter `default`. */
  values: Record<string, ParameterValue>;
  /**
   * Optional: raw BRF text the user pasted in the editor. When set,
   * uploading takes precedence over `values` and produces a `custom_<id>`
   * profile that's used in subsequent route requests.
   */
  rawBrf?: string;
  /** Last successfully uploaded custom profile id (cached). */
  uploadedProfileId?: string;
  /** Hash of the last uploaded BRF — used to skip duplicate uploads. */
  uploadedHash?: string;
}

export interface GroupMeta {
  id: ParameterGroup;
  label: string;
  description?: string;
}

export const PARAMETER_GROUPS: GroupMeta[] = [
  {
    id: 'comportement',
    label: 'Comportement',
    description: 'Quels types de chemins / itinéraires privilégier ou éviter.',
  },
  {
    id: 'elevation',
    label: 'Dénivelé',
    description:
      'Réglage fin des coûts et seuils utilisés pour décider si BRouter ' +
      'évite ou accepte les montées et descentes.',
  },
  {
    id: 'cinematique',
    label: 'Cinématique (calcul du temps)',
    description:
      'Modèle physique servant à estimer le temps de parcours (sans impact ' +
      'sur le tracé lui-même).',
  },
  {
    id: 'instructions',
    label: 'Instructions de navigation',
    description: 'Format et seuils des instructions vocales.',
  },
  {
    id: 'moteur',
    label: 'Moteur de routage',
    description:
      'Paramètres internes du moteur BRouter — manipuler avec précaution.',
  },
];
