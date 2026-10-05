import type {
  Itinerary,
  ItineraryProject,
  SavedCustomProfile,
} from '../../types';
import { deepEqual } from './deepEqual';

/**
 * Couches d'un projet.
 *
 * `ItineraryProject` est la forme composée que manipule l'interface. Elle se
 * découpe en trois couches qui ne vivent pas au même endroit :
 *
 *  - le **document** (`ProjectDocument`) : ce que tous les éditeurs d'un
 *    projet partagent — nom, itinéraires (tracé, feuille de route, réglages de
 *    routage, rythme, POI, zones interdites…), copie des profils de tracé
 *    perso référencés. Seule couche écrite dans `projects.data` (format
 *    `schema: 2`) ; c'est la future racine du document collaboratif.
 *  - la **vue** (`ProjectViewState`) : propre à chaque utilisateur —
 *    itinéraire et mode actifs, feuille de route, panneau de droite, graphe,
 *    panneaux et vue carte, affichage de chaque itinéraire (œil, rendu,
 *    opacité). Stockée à part (`project_views`, cf. projectViews.ts) : la
 *    modifier ne crée jamais de version du document, donc jamais de conflit.
 *  - le **travail local** (`ProjectLocalWork`) : éditions en attente de
 *    routage / de prédiction sur cet appareil (`pending*`). Jamais partagé :
 *    seul l'appareil qui a fait l'édition calcule son résultat, puis écrit
 *    le tracé dans le document. Gardé dans la copie IndexedDB pour reprendre
 *    après un rechargement.
 *
 * Règle pour un nouveau champ : il appartient au document par défaut (il
 * voyage avec le projet) ; un état d'affichage doit être ajouté à
 * `PROJECT_VIEW_KEYS` / `ITINERARY_VIEW_KEYS`, une tâche en attente à
 * `ITINERARY_LOCAL_WORK_KEYS`.
 */

/** Champs du projet propres à chaque utilisateur. */
export const PROJECT_VIEW_KEYS = [
  'activeItineraryId',
  'activeMode',
  'timelineView',
  'controlPanel',
  'analysis',
  'dashboard',
] as const satisfies readonly (keyof ItineraryProject)[];

/** Champs d'un itinéraire propres à chaque utilisateur (affichage). */
export const ITINERARY_VIEW_KEYS = [
  'visible',
  'analysisVisible',
  'renderMode',
  'opacity',
] as const satisfies readonly (keyof Itinerary)[];

/** Champs d'un itinéraire propres à cet appareil (travail en attente). */
export const ITINERARY_LOCAL_WORK_KEYS = [
  'pendingRoutePatch',
  'pendingTraceExtension',
  'pendingFitRecompute',
] as const satisfies readonly (keyof Itinerary)[];

export type ProjectViewKey = (typeof PROJECT_VIEW_KEYS)[number];
export type ItineraryViewKey = (typeof ITINERARY_VIEW_KEYS)[number];
export type ItineraryLocalWorkKey = (typeof ITINERARY_LOCAL_WORK_KEYS)[number];

const PROJECT_VIEW_KEY_SET: ReadonlySet<string> = new Set(PROJECT_VIEW_KEYS);
const ITINERARY_VIEW_KEY_SET: ReadonlySet<string> = new Set(ITINERARY_VIEW_KEYS);
const ITINERARY_LOCAL_WORK_KEY_SET: ReadonlySet<string> = new Set(ITINERARY_LOCAL_WORK_KEYS);

/** Version du format du document stocké (`projects.data`). */
export const PROJECT_DOCUMENT_SCHEMA = 2;

export type ItineraryDocument = Omit<Itinerary, ItineraryViewKey | ItineraryLocalWorkKey>;
export type ItineraryViewState = Partial<Pick<Itinerary, ItineraryViewKey>>;
export type ItineraryLocalWork = Partial<Pick<Itinerary, ItineraryLocalWorkKey>>;

/**
 * Document partagé. Ses clés de premier niveau restent celles
 * d'`ItineraryProject` : une version antérieure de l'app qui le lirait
 * retrouve le contenu (la vue reprend ses valeurs par défaut).
 */
export interface ProjectDocument extends Omit<ItineraryProject, ProjectViewKey | 'itineraries'> {
  schema: typeof PROJECT_DOCUMENT_SCHEMA;
  itineraries: ItineraryDocument[];
}

/** Vue d'un utilisateur sur un projet. */
export interface ProjectViewState extends Partial<Pick<ItineraryProject, ProjectViewKey>> {
  /** Affichage de chaque itinéraire, par id (entrée absente = valeurs par défaut). */
  itineraries: Record<string, ItineraryViewState>;
}

/** Travail en attente sur cet appareil, par itinéraire. */
export interface ProjectLocalWork {
  itineraries: Record<string, ItineraryLocalWork>;
}

export interface ProjectLayers {
  document: ProjectDocument;
  view: ProjectViewState;
  work: ProjectLocalWork;
}

export interface ProjectDocumentOptions {
  /**
   * Version courante d'un profil perso de la bibliothèque du compte. Un
   * profil introuvable (autre appareil pas encore synchronisé, collaborateur)
   * garde la copie déjà embarquée dans le projet.
   */
  resolveRoutingProfile?: (id: string) => SavedCustomProfile | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickDefined<K extends string>(
  source: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, unknown>> | null {
  let out: Partial<Record<K, unknown>> | null = null;
  for (const key of keys) {
    if (source[key] !== undefined) {
      out ??= {};
      out[key] = source[key];
    }
  }
  return out;
}

function withoutKeys<T extends object>(source: T, keys: ReadonlySet<string>): T {
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(source)) {
    if (!keys.has(key)) continue;
    copy ??= { ...(source as Record<string, unknown>) };
    delete copy[key];
  }
  return (copy ?? source) as T;
}

const ITINERARY_LOCAL_KEY_SET: ReadonlySet<string> = new Set([
  ...ITINERARY_VIEW_KEYS,
  ...ITINERARY_LOCAL_WORK_KEYS,
]);

/** Itinéraire du document : sans affichage ni travail local (copie superficielle). */
export function toItineraryDocument(itinerary: Itinerary): ItineraryDocument {
  return withoutKeys(itinerary, ITINERARY_LOCAL_KEY_SET) as ItineraryDocument;
}

/**
 * Profils perso embarqués : ceux que référencent les itinéraires, dans
 * l'ordre des itinéraires (sérialisation stable), version de la bibliothèque
 * en priorité.
 */
function embeddedRoutingProfiles(
  project: Pick<ItineraryProject, 'itineraries' | 'routingProfiles'>,
  resolve: ProjectDocumentOptions['resolveRoutingProfile'],
): SavedCustomProfile[] {
  const embedded = new Map((project.routingProfiles ?? []).map((profile) => [profile.id, profile]));
  const seen = new Set<string>();
  const out: SavedCustomProfile[] = [];
  for (const itinerary of project.itineraries) {
    const id = itinerary.profileId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const profile = resolve?.(id) ?? embedded.get(id);
    if (profile) out.push(profile);
  }
  return out;
}

/** Document partagé du projet. */
export function toProjectDocument(
  project: ItineraryProject,
  options: ProjectDocumentOptions = {},
): ProjectDocument {
  const rest = withoutKeys(project, PROJECT_VIEW_KEY_SET) as Omit<ItineraryProject, ProjectViewKey>;
  const routingProfiles = embeddedRoutingProfiles(project, options.resolveRoutingProfile);
  const document: ProjectDocument = {
    ...rest,
    schema: PROJECT_DOCUMENT_SCHEMA,
    itineraries: project.itineraries.map(toItineraryDocument),
  };
  if (routingProfiles.length > 0) document.routingProfiles = routingProfiles;
  else delete document.routingProfiles;
  return document;
}

/** Vue de l'utilisateur sur le projet. */
export function extractProjectView(project: ItineraryProject): ProjectViewState {
  const view: ProjectViewState = {
    ...(pickDefined(project as unknown as Record<string, unknown>, PROJECT_VIEW_KEYS) as Partial<Pick<ItineraryProject, ProjectViewKey>> | null),
    itineraries: {},
  };
  for (const itinerary of project.itineraries) {
    const display = pickDefined(itinerary as unknown as Record<string, unknown>, ITINERARY_VIEW_KEYS);
    if (display) view.itineraries[itinerary.id] = display as ItineraryViewState;
  }
  return view;
}

/** Travail en attente sur cet appareil. */
export function extractProjectLocalWork(project: Pick<ItineraryProject, 'itineraries'>): ProjectLocalWork {
  const work: ProjectLocalWork = { itineraries: {} };
  for (const itinerary of project.itineraries) {
    const pending = pickDefined(itinerary as unknown as Record<string, unknown>, ITINERARY_LOCAL_WORK_KEYS);
    if (pending) work.itineraries[itinerary.id] = pending as ItineraryLocalWork;
  }
  return work;
}

export function hasLocalWork(work: ProjectLocalWork | null | undefined): boolean {
  return work != null && Object.keys(work.itineraries).length > 0;
}

export function splitProject(project: ItineraryProject, options: ProjectDocumentOptions = {}): ProjectLayers {
  return {
    document: toProjectDocument(project, options),
    view: extractProjectView(project),
    work: extractProjectLocalWork(project),
  };
}

/**
 * Applique une vue au projet : les champs de vue du projet et l'affichage de
 * chaque itinéraire sont remplacés par ceux de `view` (un champ absent de la
 * vue garde sa valeur). Un itinéraire inconnu de la vue est inchangé.
 */
export function applyProjectView(project: ItineraryProject, view: ProjectViewState | null | undefined): ItineraryProject {
  if (!view) return project;
  const next: ItineraryProject = { ...project };
  const target = next as unknown as Record<string, unknown>;
  for (const key of PROJECT_VIEW_KEYS) {
    if (view[key] !== undefined) target[key] = view[key];
  }
  const displays = isRecord(view.itineraries) ? view.itineraries : {};
  next.itineraries = project.itineraries.map((itinerary) => {
    const display = displays[itinerary.id];
    if (!isRecord(display)) return itinerary;
    let copy: Record<string, unknown> | null = null;
    for (const key of ITINERARY_VIEW_KEYS) {
      if (display[key] === undefined || display[key] === (itinerary as unknown as Record<string, unknown>)[key]) continue;
      copy ??= { ...(itinerary as unknown as Record<string, unknown>) };
      copy[key] = display[key];
    }
    return (copy ?? itinerary) as unknown as Itinerary;
  });
  return next;
}

/** Réapplique le travail en attente de cet appareil (itinéraires encore présents). */
export function applyProjectLocalWork(
  project: ItineraryProject,
  work: ProjectLocalWork | null | undefined,
): ItineraryProject {
  if (!hasLocalWork(work)) return project;
  const pendingById = work!.itineraries;
  return {
    ...project,
    itineraries: project.itineraries.map((itinerary) => {
      const pending = pendingById[itinerary.id];
      return isRecord(pending)
        ? ({ ...itinerary, ...pickDefined(pending, ITINERARY_LOCAL_WORK_KEYS) } as Itinerary)
        : itinerary;
    }),
  };
}

/**
 * Recompose le projet d'interface depuis ses couches. Sans vue, les champs de
 * vue prennent les valeurs d'un projet neuf (les panneaux lisent leurs
 * propres défauts quand `controlPanel` / `analysis` / `dashboard` manquent).
 */
export function composeProject(
  document: ProjectDocument,
  view?: ProjectViewState | null,
  work?: ProjectLocalWork | null,
): ItineraryProject {
  const rest: Record<string, unknown> = { ...document };
  delete rest.schema;
  const base: ItineraryProject = {
    ...(rest as Omit<ItineraryProject, ProjectViewKey>),
    itineraries: document.itineraries as Itinerary[],
    activeItineraryId: document.itineraries[0]?.id ?? '',
    activeMode: 'tracage',
    timelineView: 'sheet',
  };
  return applyProjectLocalWork(applyProjectView(base, view), work);
}

/** Projet sans travail local (fichier `.redview`, copie envoyée à un tiers). */
export function stripLocalWork(project: ItineraryProject): ItineraryProject {
  if (!project.itineraries.some((itinerary) => ITINERARY_LOCAL_WORK_KEYS.some((key) => itinerary[key] !== undefined))) {
    return project;
  }
  return {
    ...project,
    itineraries: project.itineraries.map((itinerary) =>
      withoutKeys(itinerary, ITINERARY_LOCAL_WORK_KEY_SET),
    ),
  };
}

export function isProjectDocument(value: unknown): value is ProjectDocument {
  return isRecord(value) && value.schema === PROJECT_DOCUMENT_SCHEMA && Array.isArray(value.itineraries);
}

/**
 * Lecture d'un projet stocké : document `schema: 2`, ou projet composé des
 * versions précédentes (`projects.data` jusqu'ici, copies IndexedDB, caches),
 * dont la vue et le travail en attente sont alors extraits. Le travail d'un
 * ancien projet est celui de son propriétaire : il reprend à l'ouverture.
 */
export function readStoredProject(value: unknown): {
  document: ProjectDocument;
  legacyView: ProjectViewState | null;
  legacyWork: ProjectLocalWork | null;
} | null {
  if (isProjectDocument(value)) return { document: value, legacyView: null, legacyWork: null };
  if (!isRecord(value) || !Array.isArray(value.itineraries)) return null;
  const legacy = value as unknown as ItineraryProject;
  const work = extractProjectLocalWork(legacy);
  return {
    document: toProjectDocument(legacy),
    legacyView: extractProjectView(legacy),
    legacyWork: hasLocalWork(work) ? work : null,
  };
}

export interface ProjectChange {
  document: boolean;
  view: boolean;
  work: boolean;
}

/**
 * Couches touchées entre deux états successifs du projet. Comparaison par
 * référence d'abord (le ProjectStore partage la structure : une valeur
 * inchangée garde sa référence), puis par valeur pour le document et le
 * travail local : une valeur égale recréée (normalisation à l'ouverture) ne
 * déclenche pas de sauvegarde du document. La vue se compare par référence
 * (une écriture de vue de trop est dédupliquée par projectViews.ts).
 */
export function classifyProjectChange(prev: ItineraryProject, next: ItineraryProject): ProjectChange {
  const change: ProjectChange = { document: false, view: false, work: false };
  if (prev === next) return change;
  const left = prev as unknown as Record<string, unknown>;
  const right = next as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key === 'itineraries' || left[key] === right[key]) continue;
    if (PROJECT_VIEW_KEY_SET.has(key)) change.view = true;
    else if (!change.document && !deepEqual(left[key], right[key])) change.document = true;
  }
  if (prev.itineraries === next.itineraries) return change;
  if (
    prev.itineraries.length !== next.itineraries.length
    || prev.itineraries.some((itinerary, index) => itinerary.id !== next.itineraries[index].id)
  ) {
    // Ajout, suppression ou réordonnancement : le document change ; l'affichage
    // et le travail des itinéraires concernés aussi, au besoin.
    change.document = true;
    change.view = true;
    change.work = true;
    return change;
  }
  next.itineraries.forEach((nextItinerary, index) => {
    const prevItinerary = prev.itineraries[index];
    if (nextItinerary === prevItinerary) return;
    const a = prevItinerary as unknown as Record<string, unknown>;
    const b = nextItinerary as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[key] === b[key]) continue;
      if (ITINERARY_VIEW_KEY_SET.has(key)) change.view = true;
      else if (ITINERARY_LOCAL_WORK_KEY_SET.has(key)) {
        if (!change.work && !deepEqual(a[key], b[key])) change.work = true;
      } else if (!change.document && !deepEqual(a[key], b[key])) change.document = true;
    }
  });
  return change;
}
