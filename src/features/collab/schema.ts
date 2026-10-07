import type { DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { Itinerary } from '@/features/itineraryPanel/types';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

/**
 * Modèle de fusion du document partagé (`ProjectDocument`, cf.
 * itineraryPanel/lib/project/layers.ts) : comment chaque champ se combine
 * quand plusieurs éditeurs le modifient en même temps. Seule source de vérité
 * du document à plat (model/diff.ts, model/materialize.ts) : un champ
 * `record` devient une propriété par clé, une `list` un objet par élément.
 *
 *  - `atomic` : la valeur entière, dernière écriture gagnante (départage
 *    déterministe, identique chez tous les éditeurs) ;
 *  - `record` : objet fusionné clé par clé (deux réglages différents changés
 *    en même temps sont tous les deux gardés), chaque clé selon `fields[clé]`,
 *    sinon `other` ;
 *  - `list` : liste ordonnée d'éléments identifiés (`keyOf`) : ajouts,
 *    suppressions et déplacements concurrents fusionnés indépendamment, chaque
 *    élément selon `item` (un déplacement ne perd pas l'édition d'un autre) ;
 *  - `route` : tracé — en-tête atomique (métadonnées + liste de segments) et
 *    segments de points adressés par leur contenu (routeChunks.ts) : déplacer
 *    un point n'envoie que les segments changés, jamais tout le tracé.
 *
 * | Champ                                   | Fusion                         |
 * |-----------------------------------------|--------------------------------|
 * | nom, confidentialité, profils embarqués | atomique                       |
 * | itinéraires                             | liste par id                   |
 * | ├ nom, couleur, profil, discipline      | atomique (par champ)           |
 * | ├ priorités, types de routes, expert    | clé par clé                    |
 * | ├ rythme                                | clé par clé ; pauses : liste   |
 * | ├ POI (catégories)                      | clé par clé                    |
 * | ├ feuille de route, zones interdites    | liste par id, champ par champ  |
 * | ├ alertes pente reclassées              | clé par clé                    |
 * | ├ fichiers .fit                         | liste par chemin               |
 * | ├ tracé                                 | segments adressés par contenu  |
 * | └ métriques, prédiction, POI, audit     | atomique (résultats dérivés)   |
 * | commentaires (fils)                     | liste par id, champ par champ  |
 * | ├ ancre, zone, point de vue             | atomique (par champ)           |
 * | └ messages                              | liste par id, champ par champ  |
 * |   └ réactions                           | clé par clé (une par auteur)   |
 *
 * Un champ absent du modèle est atomique : un nouveau champ du document
 * voyage sans rien changer ici.
 */
export type MergeSpec =
  | { readonly kind: 'atomic' }
  | {
      readonly kind: 'record';
      readonly fields?: Readonly<Record<string, MergeSpec>>;
      readonly other: MergeSpec;
    }
  | {
      readonly kind: 'list';
      /** Identifiant stable d'un élément ; null = élément non identifiable (liste stockée atomique). */
      readonly keyOf: (item: unknown) => string | null;
      readonly item: MergeSpec;
    }
  | { readonly kind: 'route' };

export type RecordSpec = Extract<MergeSpec, { kind: 'record' }>;
export type ListSpec = Extract<MergeSpec, { kind: 'list' }>;

const ATOMIC: MergeSpec = { kind: 'atomic' };
/** Objet de réglages : chaque clé est une valeur atomique. */
const SETTINGS: MergeSpec = { kind: 'record', other: ATOMIC };
const ROUTE: MergeSpec = { kind: 'route' };

function stringKey(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Clé `id` (lignes de feuille de route, zones, pauses, itinéraires). */
const byId = (item: unknown): string | null =>
  item !== null && typeof item === 'object' ? stringKey((item as { id?: unknown }).id) : null;

/** Fichier .fit : chemin dans le bucket, sinon nom + date (anciens projets). */
const byFitUpload = (item: unknown): string | null => {
  if (item === null || typeof item !== 'object') return null;
  const upload = item as { path?: unknown; name?: unknown; lastModified?: unknown };
  return stringKey(upload.path)
    ?? (typeof upload.name === 'string' ? `${upload.name}#${String(upload.lastModified ?? '')}` : null);
};

function list(keyOf: ListSpec['keyOf'], item: MergeSpec): MergeSpec {
  return { kind: 'list', keyOf, item };
}

type ItineraryFieldSpecs = Partial<Record<keyof Itinerary, MergeSpec>>;

const ITINERARY_FIELDS: ItineraryFieldSpecs = {
  priorities: SETTINGS,
  roadTypes: SETTINGS,
  expertProfile: { kind: 'record', other: ATOMIC, fields: { values: SETTINGS } },
  rhythm: {
    kind: 'record',
    other: ATOMIC,
    fields: {
      pauseIntervals: list(byId, SETTINGS),
      poiPauseDurations: SETTINGS,
      pausePositionOverridesKm: SETTINGS,
    },
  },
  poi: SETTINGS,
  timeline: list(byId, SETTINGS),
  forbiddenZones: list(byId, SETTINGS),
  steepAlertOverrides: SETTINGS,
  fitUploads: list(byFitUpload, ATOMIC),
  gpxRoute: ROUTE,
};

export const ITINERARY_SPEC: RecordSpec = { kind: 'record', other: ATOMIC, fields: ITINERARY_FIELDS };

type ProjectFieldSpecs = Partial<Record<keyof ProjectDocument, MergeSpec>>;

/** Message d'un fil : chaque réaction (`${emoji}~${userId}`) est sa propre propriété. */
const COMMENT_MESSAGE_SPEC: RecordSpec = { kind: 'record', other: ATOMIC, fields: { reactions: SETTINGS } };

/** Fil de commentaires : ses messages sont une liste (deux réponses simultanées sont gardées). */
const COMMENT_THREAD_SPEC: RecordSpec = {
  kind: 'record',
  other: ATOMIC,
  fields: { messages: list(byId, COMMENT_MESSAGE_SPEC) },
};

const PROJECT_FIELDS: ProjectFieldSpecs = {
  itineraries: list(byId, ITINERARY_SPEC),
  comments: list(byId, COMMENT_THREAD_SPEC),
};

/** Racine du document partagé. */
export const PROJECT_DOCUMENT_SPEC: RecordSpec = { kind: 'record', other: ATOMIC, fields: PROJECT_FIELDS };

/** Spécification d'une clé d'un enregistrement. */
export function fieldSpec(spec: RecordSpec, key: string): MergeSpec {
  // Propriétés propres seulement : `constructor`, `toString`… ne sont pas des champs du modèle.
  return (spec.fields && Object.hasOwn(spec.fields, key) ? spec.fields[key] : undefined) ?? spec.other;
}

/**
 * Entrées dont dépend chaque résultat dérivé d'un itinéraire : la modification
 * de l'une d'elles désigne l'auteur qui doit recalculer ce résultat
 * (baux du serveur, room/leases.ts). Doit rester aligné sur `getRoutingInputsSignature`,
 * `buildPredictionStamp` et `buildPoiRouteSignature`.
 */
export const DERIVED_INPUTS: Readonly<Record<DerivedKind, readonly (keyof Itinerary)[]>> = {
  route: ['timeline', 'profileId', 'discipline', 'priorities', 'roadTypes', 'expertProfile', 'forbiddenZones'],
  prediction: ['gpxRoute', 'discipline', 'rhythm', 'fitUploads'],
  poi: ['gpxRoute', 'poi'],
};

export type { DerivedKind };
