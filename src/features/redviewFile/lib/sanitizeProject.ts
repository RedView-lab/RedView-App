/**
 * Validation du contenu d'un fichier `.redview` (données d'un tiers).
 *
 * Règle : une valeur valide passe telle quelle (ni rognée, ni tronquée, ni
 * convertie) — le destinataire retrouve le projet à l'identique. Seul ce qui
 * ferait planter l'éditeur est rejeté (structure, coordonnées, identifiants)
 * ou remplacé (type faux sur un champ secondaire), et ce qui ne doit pas
 * suivre le fichier est retiré (confidentialité, horodatage d'enregistrement,
 * références au stockage de l'expéditeur). Les champs inconnus (version plus
 * récente compatible) sont conservés. Le projet passe ensuite par la même
 * normalisation qu'un projet du cloud (`normalizeItineraryProject`).
 */
import { ITINERARY_COLORS, normalizeItineraryProject } from '@/features/itineraryPanel/lib/project/defaultState';
import { ROUTE_PROFILE_PRESETS } from '@/features/itineraryPanel/lib/project/profilePresets';
import type { SavedCustomProfile } from '@/features/itineraryPanel/lib/project/customProfiles';
import type {
  Itinerary,
  ItineraryForbiddenZone,
  ItineraryProject,
  PanelMode,
  TimelineItem,
} from '@/features/itineraryPanel/types';
import { translateAppText } from '@/shared/i18n';

import { RedviewFileError } from './errors';
import { REDVIEW_LIMITS } from './format';

type UnknownRecord = Record<string, unknown>;

const PANEL_MODES: readonly PanelMode[] = ['tracage', 'rythme', 'poi', 'nutrition'];
/**
 * Couleur CSS sans danger (hex, rgb(), hsl(), nom) : passée telle quelle à
 * Mapbox et aux styles. Ni `;`, ni `:`, ni guillemets, ni `url(`.
 */
const SAFE_CSS_COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/-]+\)|[a-z]{3,30})$/i;
const MAX_ID_LENGTH = 200;

function invalid(detail: string): RedviewFileError {
  return new RedviewFileError('invalid-project', { cause: new Error(detail) });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLatLon(value: unknown): value is UnknownRecord & { lat: number; lon: number } {
  return (
    isRecord(value)
    && isFiniteNumber(value.lat) && value.lat >= -90 && value.lat <= 90
    && isFiniteNumber(value.lon) && value.lon >= -180 && value.lon <= 180
  );
}

/** `value` si `valid`, sinon `fallback` (absent par défaut). */
function keepIf<T>(value: unknown, valid: boolean, fallback?: T): T | undefined {
  return valid ? (value as T) : fallback;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * `JSON.parse` d'un texte tiers : les clés `__proto__` (inoffensives pour
 * `JSON.parse`, dangereuses pour un futur `Object.assign` / fusion profonde)
 * sont retirées. Le reviver ne coûte que si une telle clé est présente.
 */
export function parseUntrustedJson(text: string): unknown {
  if (!text.includes('"__proto__"')) return JSON.parse(text);
  return JSON.parse(text, (key, value: unknown) => (key === '__proto__' ? undefined : value));
}

function sanitizeTimeline(raw: unknown, itineraryIndex: number): TimelineItem[] {
  if (!Array.isArray(raw)) throw invalid(`itinerary #${itineraryIndex}: timeline is not an array`);
  return raw.map((row, rowIndex) => {
    if (!isRecord(row) || !isId(row.id) || typeof row.kind !== 'string') {
      throw invalid(`itinerary #${itineraryIndex}: bad timeline row #${rowIndex}`);
    }
    const next: UnknownRecord = {
      ...row,
      label: typeof row.label === 'string' ? row.label : '',
      distanceKm: isFiniteNumber(row.distanceKm) ? row.distanceKm : null,
    };
    if ((row.lat != null || row.lon != null) && !isLatLon(row)) {
      delete next.lat;
      delete next.lon;
    }
    return next as unknown as TimelineItem;
  });
}

function sanitizeRoutePoints(raw: unknown, where: string): NonNullable<Itinerary['gpxRoute']>['points'] {
  if (!Array.isArray(raw)) throw invalid(`${where}: points is not an array`);
  raw.forEach((point, index) => {
    if (!isLatLon(point)) throw invalid(`${where}: bad point #${index}`);
  });
  return raw as NonNullable<Itinerary['gpxRoute']>['points'];
}

function sanitizeGpxRoute(raw: unknown, itineraryIndex: number): Itinerary['gpxRoute'] {
  if (raw == null) return undefined;
  if (!isRecord(raw)) throw invalid(`itinerary #${itineraryIndex}: gpxRoute is not an object`);
  const where = `itinerary #${itineraryIndex} route`;
  const next: UnknownRecord = {
    ...raw,
    name: typeof raw.name === 'string' ? raw.name : null,
    points: sanitizeRoutePoints(raw.points, where),
  };
  if (raw.originalPoints != null) next.originalPoints = sanitizeRoutePoints(raw.originalPoints, `${where} (original)`);
  return next as unknown as Itinerary['gpxRoute'];
}

function sanitizeForbiddenZones(raw: unknown): ItineraryForbiddenZone[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // Zone illisible écartée (un polygone de moins de 3 sommets n'est pas tracé).
  return raw.filter((zone): zone is ItineraryForbiddenZone =>
    isRecord(zone)
    && isId(zone.id)
    && Array.isArray(zone.points)
    && zone.points.length >= 3
    && zone.points.every(isLatLon),
  );
}

function sanitizePoiFeatures(raw: unknown): Itinerary['poiFeatures'] {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((feature) =>
    isLatLon(feature)
    && typeof feature.category === 'string'
    && (feature.name == null || typeof feature.name === 'string')
    && (feature.tags == null || isRecord(feature.tags)),
  ) as Itinerary['poiFeatures'];
}

function sanitizeItinerary(raw: unknown, index: number, seenIds: Set<string>): Itinerary {
  if (!isRecord(raw)) throw invalid(`itinerary #${index} is not an object`);
  if (!isId(raw.id) || seenIds.has(raw.id)) throw invalid(`itinerary #${index}: missing or duplicate id`);
  seenIds.add(raw.id);

  const next: UnknownRecord = {
    ...raw,
    name: keepIf(raw.name, typeof raw.name === 'string', translateAppText('Itinéraire {{index}}', { index: index + 1 })),
    color: keepIf(
      raw.color,
      typeof raw.color === 'string' && SAFE_CSS_COLOR.test(raw.color),
      ITINERARY_COLORS[index % ITINERARY_COLORS.length],
    ),
    profileId: keepIf(raw.profileId, typeof raw.profileId === 'string', ''),
    priorities: keepIf(raw.priorities, isRecord(raw.priorities), { ...ROUTE_PROFILE_PRESETS.road.priorities }),
    roadTypes: keepIf(raw.roadTypes, isRecord(raw.roadTypes)),
    rhythm: keepIf(raw.rhythm, isRecord(raw.rhythm)),
    poi: keepIf(raw.poi, isRecord(raw.poi)),
    timeline: sanitizeTimeline(raw.timeline, index),
    gpxRoute: sanitizeGpxRoute(raw.gpxRoute, index),
    forbiddenZones: sanitizeForbiddenZones(raw.forbiddenZones),
    poiFeatures: sanitizePoiFeatures(raw.poiFeatures),
    // `null` (prédiction effacée) et absent restent distincts.
    prediction: keepIf(raw.prediction, raw.prediction === null || isRecord(raw.prediction)),
    routeAudit: keepIf(raw.routeAudit, isRecord(raw.routeAudit) && Array.isArray(raw.routeAudit.findings)),
    steepAlertOverrides: keepIf(raw.steepAlertOverrides, isRecord(raw.steepAlertOverrides)),
    expertProfile: keepIf(raw.expertProfile, isRecord(raw.expertProfile)),
    metrics: keepIf(raw.metrics, isRecord(raw.metrics)),
    splitRelation: keepIf(
      raw.splitRelation,
      isRecord(raw.splitRelation) && isId(raw.splitRelation.parentItineraryId),
    ),
    pendingRoutePatch: keepIf(raw.pendingRoutePatch, isRecord(raw.pendingRoutePatch)),
    pendingTraceExtension: keepIf(raw.pendingTraceExtension, isRecord(raw.pendingTraceExtension)),
    // Reconstruits par l'import à partir des fichiers .fit embarqués.
    fitUploads: undefined,
  };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  return next as unknown as Itinerary;
}

function sanitizeDashboard(raw: unknown): ItineraryProject['dashboard'] {
  if (!isRecord(raw)) return undefined;
  const next: UnknownRecord = { ...raw };
  const viewport = raw.mapViewport;
  const viewportValid = isRecord(viewport)
    && Array.isArray(viewport.center)
    && viewport.center.length === 2
    && isLatLon({ lon: viewport.center[0], lat: viewport.center[1] })
    && isFiniteNumber(viewport.zoom)
    && isFiniteNumber(viewport.pitch)
    && isFiniteNumber(viewport.bearing);
  if (!viewportValid) delete next.mapViewport;
  for (const key of ['rightPanelWidth', 'leftPanelWidth'] as const) {
    if (next[key] != null && !isFiniteNumber(next[key])) delete next[key];
  }
  if (next.centerPanelHeight != null && !isFiniteNumber(next.centerPanelHeight)) delete next.centerPanelHeight;
  return next as ItineraryProject['dashboard'];
}

/** Projet importé, prêt à être enregistré pour le destinataire. Lève `invalid-project`. */
export function sanitizeImportedProject(raw: unknown): ItineraryProject {
  if (!isRecord(raw) || !Array.isArray(raw.itineraries)) throw invalid('not a project');

  const seenIds = new Set<string>();
  const itineraries = raw.itineraries.map((itinerary, index) => sanitizeItinerary(itinerary, index, seenIds));
  const activeItineraryId = typeof raw.activeItineraryId === 'string' && seenIds.has(raw.activeItineraryId)
    ? raw.activeItineraryId
    : (itineraries[0]?.id ?? '');

  const project: UnknownRecord = {
    ...raw,
    name: keepIf(raw.name, typeof raw.name === 'string', ''),
    // Propres au compte et à l'enregistrement de l'expéditeur.
    savedAt: null,
    sizeBytes: null,
    privacy: 'private',
    itineraries,
    activeItineraryId,
    activeMode: PANEL_MODES.includes(raw.activeMode as PanelMode) ? raw.activeMode : 'tracage',
    timelineView: raw.timelineView === 'timeline' ? 'timeline' : 'sheet',
    controlPanel: keepIf(raw.controlPanel, isRecord(raw.controlPanel)),
    analysis: keepIf(raw.analysis, isRecord(raw.analysis)),
    dashboard: sanitizeDashboard(raw.dashboard),
    // Copie des profils perso embarquée dans le document (venue d'un tiers).
    routingProfiles: Array.isArray(raw.routingProfiles) ? sanitizeRoutingProfiles(raw.routingProfiles) : undefined,
  };
  for (const key of Object.keys(project)) {
    if (project[key] === undefined) delete project[key];
  }

  try {
    return normalizeItineraryProject(project as unknown as ItineraryProject);
  } catch (error) {
    throw new RedviewFileError('invalid-project', { cause: error });
  }
}

/** Profils de tracé perso valides (les autres sont ignorés). */
export function sanitizeRoutingProfiles(raw: unknown): SavedCustomProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const profiles: SavedCustomProfile[] = [];
  for (const profile of raw.slice(0, REDVIEW_LIMITS.routingProfiles)) {
    if (
      !isRecord(profile)
      || !isId(profile.id)
      || seen.has(profile.id)
      || !isRecord(profile.roadTypes)
      || !isRecord(profile.priorities)
    ) {
      continue;
    }
    seen.add(profile.id);
    profiles.push({
      ...(profile as unknown as SavedCustomProfile),
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name : profile.id,
      basePresetId: typeof profile.basePresetId === 'string' ? profile.basePresetId : undefined,
      createdAt: isFiniteNumber(profile.createdAt) ? profile.createdAt : Date.now(),
    });
  }
  return profiles;
}
