import { getSavedCustomProfiles } from '@/features/itineraryPanel/lib/project/customProfiles';
import {
  composeProject,
  extractProjectLocalWork,
  hasLocalWork,
  readStoredProject,
  toProjectDocument,
  type ProjectDocument,
  type ProjectLocalWork,
  type ProjectViewState,
} from '@/features/itineraryPanel/lib/project/layers';
import type { ItineraryProject } from './types';

/**
 * Formes stockées d'un projet (cf. `lib/project/layers.ts`) :
 *  - `projects.data` (cloud) et `data_json` de la copie IndexedDB : le
 *    document partagé seul (`schema: 2`) ;
 *  - `work_json` de la copie IndexedDB : le travail en attente sur cet
 *    appareil ;
 *  - la vue de l'utilisateur à part (projectViews.ts).
 * Les projets composés des versions précédentes restent lisibles partout :
 * leur vue et leur travail en attente sont extraits à la lecture.
 */

/** Profils perso à embarquer : version courante de la bibliothèque du compte. */
function libraryRoutingProfileResolver() {
  const byId = new Map(getSavedCustomProfiles().map((profile) => [profile.id, profile]));
  return (id: string) => byId.get(id);
}

/** Document partagé d'un projet, profils perso référencés à jour. */
export function buildProjectDocument(project: ItineraryProject): ProjectDocument {
  return toProjectDocument(project, { resolveRoutingProfile: libraryRoutingProfileResolver() });
}

export interface SerializedProject {
  /** JSON du document partagé (charge utile cloud et copie locale). */
  documentJson: string;
  /** JSON du travail en attente sur cet appareil, null s'il n'y en a pas. */
  workJson: string | null;
}

/**
 * Sérialise un projet pour le stockage. `documentJson` : JSON du document déjà
 * calculé par l'appelant (une seule sérialisation du document par sauvegarde).
 */
export function serializeProjectForStorage(project: ItineraryProject, documentJson?: string): SerializedProject {
  const work = extractProjectLocalWork(project);
  return {
    documentJson: documentJson ?? JSON.stringify(buildProjectDocument(project)),
    workJson: hasLocalWork(work) ? JSON.stringify(work) : null,
  };
}

export interface ParsedStoredProject {
  project: ItineraryProject;
  /** Vue embarquée dans un projet au format précédent (sinon null). */
  legacyView: ProjectViewState | null;
}

/**
 * Vue d'origine des projets lus au format précédent, par objet projet : à
 * l'ouverture, elle devient la vue stockée de l'utilisateur (migration) si
 * aucune n'existe encore (cf. projectRows.getProject).
 */
const legacyViews = new WeakMap<ItineraryProject, ProjectViewState>();

export function legacyViewOf(project: ItineraryProject): ProjectViewState | null {
  return legacyViews.get(project) ?? null;
}

/** `next` dérive de `previous` (copie renommée…) : il garde sa vue d'origine. */
export function carryLegacyView(previous: ItineraryProject, next: ItineraryProject): ItineraryProject {
  const view = legacyViews.get(previous);
  if (view && next !== previous) legacyViews.set(next, view);
  return next;
}

/**
 * Projet d'interface depuis une valeur stockée (document `schema: 2` ou projet
 * composé hérité) et le travail local de cet appareil. Null si la valeur n'est
 * pas un projet.
 */
export function parseStoredProject(value: unknown, work?: ProjectLocalWork | null): ParsedStoredProject | null {
  const stored = readStoredProject(value);
  if (!stored) return null;
  const project = composeProject(stored.document, stored.legacyView, work ?? stored.legacyWork);
  if (stored.legacyView) legacyViews.set(project, stored.legacyView);
  return { project, legacyView: stored.legacyView };
}

/** Travail local stocké (`work_json`), null s'il est absent ou illisible. */
export function parseStoredLocalWork(json: string | null | undefined): ProjectLocalWork | null {
  if (typeof json !== 'string' || !json) return null;
  try {
    const parsed = JSON.parse(json) as ProjectLocalWork;
    return parsed && typeof parsed === 'object' && parsed.itineraries && typeof parsed.itineraries === 'object'
      ? parsed
      : null;
  } catch {
    return null;
  }
}
