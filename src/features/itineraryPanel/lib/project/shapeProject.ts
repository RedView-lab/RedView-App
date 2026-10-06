import { translateAppText } from '@/shared/i18n';
import { isSafeCssColor } from '@/shared/lib/cssColor';

import type { Itinerary, ItineraryProject, TimelineItem } from '../../types';
import { createDefaultExpertState } from '../../expert/defaults';
import { createDefaultRhythmState, ITINERARY_COLORS } from './defaultState';
import { ROUTE_PROFILE_PRESETS } from './profilePresets';

/**
 * Forme minimale d'un projet dans l'éditeur, quelle que soit sa source
 * (document d'un autre éditeur en co-édition, cloud, fichier) : ce que
 * l'interface lit sans vérifier a le bon type — feuille de route en tableau,
 * nom en texte, couleur sûre, priorités et rythme du bon genre… Un éditeur
 * malveillant qui crée un itinéraire « nu » ou change un type ne fait plus
 * planter l'application des autres (collab-e2e/hostile-peer.mjs). Appliqué
 * par le ProjectStore à tout document qu'il reçoit ; rien n'est copié quand
 * tout est déjà conforme (les rendus et mémos gardés par référence restent
 * valables). Module de l'éditeur, hors du premier chargement (budget de
 * npm run bundle:check).
 */

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/** Valeur du même genre que le défaut (texte, nombre fini, booléen, objet, tableau ; null là où le défaut l'est). */
function sameShape(value: unknown, fallback: unknown): boolean {
  if (fallback === null) return value === null || (typeof value !== 'object' && typeof value !== 'function');
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (typeof fallback === 'object') return isPlainObject(value);
  if (typeof fallback === 'number') return value === null || isFiniteNumber(value);
  return typeof value === typeof fallback;
}

/**
 * Réglage plat (rythme, priorités) : une valeur d'un autre genre que celle du
 * défaut (objet à la place d'un nombre…) reprend le défaut ; les clés
 * inconnues passent telles quelles. Même objet s'il n'y a rien à reprendre.
 */
function settingsLike<T extends object>(value: unknown, fallback: T): T {
  if (!isPlainObject(value)) return fallback;
  let out: UnknownRecord | null = null;
  for (const [key, defaultValue] of Object.entries(fallback)) {
    if (value[key] === undefined || sameShape(value[key], defaultValue)) continue;
    out ??= { ...value };
    out[key] = defaultValue;
  }
  return (out ?? value) as T;
}

/** Ligne déjà conforme (aucune copie à faire). */
function isShapedTimelineRow(row: unknown): boolean {
  return isPlainObject(row) && typeof row.id === 'string' && row.id.length > 0
    && typeof row.kind === 'string' && typeof row.label === 'string'
    && (row.lat === undefined || isFiniteNumber(row.lat))
    && (row.lon === undefined || isFiniteNumber(row.lon))
    && (row.distanceKm === undefined || row.distanceKm === null || isFiniteNumber(row.distanceKm));
}

/** Ligne de feuille de route lisible (sinon null) : id et nature en texte, libellé texte, coordonnées numériques. */
function shapeTimelineRow(row: unknown): TimelineItem | null {
  if (!isPlainObject(row) || typeof row.id !== 'string' || row.id.length === 0) return null;
  const next: UnknownRecord = { ...row };
  if (typeof next.kind !== 'string') next.kind = 'waypoint';
  if (typeof next.label !== 'string') next.label = '';
  for (const key of ['lat', 'lon'] as const) {
    if (next[key] !== undefined && !isFiniteNumber(next[key])) delete next[key];
  }
  if (next.distanceKm !== undefined && next.distanceKm !== null && !isFiniteNumber(next.distanceKm)) next.distanceKm = null;
  return next as unknown as TimelineItem;
}

/** Itinéraire conforme : le même objet s'il l'était déjà, sinon une copie réparée ; null sans id lisible (écarté). */
function shapeItinerary(raw: unknown, index: number): Itinerary | null {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const patch: UnknownRecord = {};
  const dropped: string[] = [];
  if (typeof raw.name !== 'string') patch.name = translateAppText('Itinéraire {{index}}', { index: index + 1 });
  if (!isSafeCssColor(raw.color)) patch.color = ITINERARY_COLORS[index % ITINERARY_COLORS.length];
  if (!Array.isArray(raw.timeline)) patch.timeline = [];
  else if (!raw.timeline.every(isShapedTimelineRow)) {
    patch.timeline = raw.timeline.map(shapeTimelineRow).filter((row): row is TimelineItem => row !== null);
  }
  const priorities = settingsLike(raw.priorities, { ...ROUTE_PROFILE_PRESETS.road.priorities });
  if (priorities !== raw.priorities) patch.priorities = priorities;
  if (raw.rhythm !== undefined) {
    const rhythm = settingsLike(raw.rhythm, createDefaultRhythmState());
    if (rhythm !== raw.rhythm) patch.rhythm = rhythm;
  }
  if (raw.roadTypes !== undefined && !isPlainObject(raw.roadTypes)) dropped.push('roadTypes');
  if (raw.expertProfile !== undefined && !isPlainObject(raw.expertProfile)) patch.expertProfile = createDefaultExpertState();
  for (const key of ['metrics', 'prediction', 'routeAudit', 'steepAlertOverrides', 'splitRelation']) {
    if (raw[key] !== undefined && raw[key] !== null && !isPlainObject(raw[key])) dropped.push(key);
  }
  for (const key of ['forbiddenZones', 'fitUploads', 'poiFeatures']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) dropped.push(key);
  }
  const route = raw.gpxRoute;
  if (route !== undefined && route !== null) {
    if (!isPlainObject(route) || !Array.isArray(route.points)) {
      dropped.push('gpxRoute');
    } else if (route.originalPoints !== undefined && !Array.isArray(route.originalPoints)) {
      const { originalPoints: _dropped, ...rest } = route;
      patch.gpxRoute = rest;
    }
  }
  if (Object.keys(patch).length === 0 && dropped.length === 0) return raw as unknown as Itinerary;
  const next: UnknownRecord = { ...raw, ...patch };
  for (const key of dropped) delete next[key];
  return next as unknown as Itinerary;
}

/** Projet à la forme que lit l'éditeur ; le même objet s'il l'avait déjà. */
export function shapeProject(project: ItineraryProject): ItineraryProject {
  const source = project.itineraries as unknown;
  const list: unknown[] = Array.isArray(source) ? source : [];
  let changed = !Array.isArray(source);
  const itineraries: Itinerary[] = [];
  list.forEach((raw, index) => {
    const shaped = shapeItinerary(raw, index);
    if (shaped !== raw) changed = true;
    if (shaped) itineraries.push(shaped);
  });
  const root: Partial<ItineraryProject> = {};
  if (typeof project.name !== 'string') root.name = '';
  if (project.routingProfiles !== undefined && !Array.isArray(project.routingProfiles)) root.routingProfiles = undefined;
  if (project.comments !== undefined && !Array.isArray(project.comments)) root.comments = undefined;
  if (!changed && Object.keys(root).length === 0) return project;
  return { ...project, ...root, itineraries };
}
