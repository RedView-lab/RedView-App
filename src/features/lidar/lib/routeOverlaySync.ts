import type { Itinerary } from '@/features/itineraryPanel/types';
import { translateAppText } from '@/shared/i18n/config';

export const LIDAR_ROUTE_OVERLAY_STORAGE_KEY = 'redview:lidar:route_overlay';
export const LIDAR_ROUTE_OVERLAY_CHANNEL_NAME = 'redview:lidar:route_overlay';

/**
 * Projet de cette page : celui ouvert dans l'onglet de l'app, ou celui d'où
 * le visualiseur a été ouvert (paramètre `project` de son URL). Chaque
 * message et la copie localStorage le portent ; un message d'un autre projet
 * est ignoré — plusieurs onglets de l'app sur des projets différents
 * recevaient chacun les traces créées dans le visualiseur (C2-1). Sans projet
 * (visualiseur ouvert à la main, message d'une version précédente) : tout est
 * accepté, comme avant.
 */
let syncProjectId: string | null = readViewerProjectParam();

/** Visualiseur : projet d'où il a été ouvert (`?project=`, buildViewerUrl). Une page de l'app n'en a pas. */
function readViewerProjectParam(): string | null {
  try {
    const value = new URLSearchParams(globalThis.location?.search ?? '').get('project');
    return value && value.length <= 64 ? value : null;
  } catch {
    return null;
  }
}

export function setLidarRouteSyncProject(projectId: string | null): void {
  if (projectId === syncProjectId) return;
  syncProjectId = projectId;
  // Autre projet : son dernier état publié n'est pas celui-ci.
  lastPublishedRoutes = null;
}

export function getLidarRouteSyncProject(): string | null {
  return syncProjectId;
}

/**
 * Onglet de l'app qui applique les messages du visualiseur pour ce projet.
 * Deux onglets ouverts sur le même projet ajoutaient chacun la trace créée ou
 * copiée dans le visualiseur : un doublon dans le projet, et chez tous les
 * éditeurs s'il est partagé (C2-1). Un verrou Web Locks par projet, tenu tant
 * que l'onglet a le projet ouvert : le suivant le reprend quand il se ferme.
 * Sans Web Locks : chaque onglet applique, comme avant.
 */
let routeTaker = false;

export function claimLidarRouteTaker(projectId: string): () => void {
  const locks = globalThis.navigator?.locks;
  if (!locks) {
    routeTaker = true;
    return () => {
      routeTaker = false;
    };
  }
  const abort = new AbortController();
  let release: (() => void) | null = null;
  locks
    .request(`redview:lidar-route-taker:${projectId}`, { signal: abort.signal }, () => {
      // Verrou accordé après le nettoyage (abandon trop tard) : rendu tout de suite.
      if (abort.signal.aborted) return undefined;
      routeTaker = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch(() => undefined);
  return () => {
    routeTaker = false;
    abort.abort();
    release?.();
  };
}

export function isLidarRouteTaker(): boolean {
  return routeTaker;
}

function storageKey(): string {
  return syncProjectId ? `${LIDAR_ROUTE_OVERLAY_STORAGE_KEY}:${syncProjectId}` : LIDAR_ROUTE_OVERLAY_STORAGE_KEY;
}

function isForThisProject(message: { projectId?: unknown }): boolean {
  return !syncProjectId || typeof message.projectId !== 'string' || message.projectId === syncProjectId;
}

/** Projet de la page, posé sur un message sortant. */
function projectStamp(): { projectId?: string } {
  return syncProjectId ? { projectId: syncProjectId } : {};
}

export interface LidarRouteOverlayPoint {
  lat: number;
  lon: number;
  elevationM?: number | null;
  distanceM?: number;
}

export interface LidarRouteOverlayItem {
  id: string;
  name: string;
  color: string;
  opacity: number; // 0 to 1
  visible: boolean;
  points: LidarRouteOverlayPoint[];
}

export interface LidarRouteOverlayState {
  version: 1;
  updatedAt: string;
  source?: 'redview_app' | 'lidar_viewer';
  /** Projet de l'expéditeur (absent : version précédente). */
  projectId?: string;
  routes: LidarRouteOverlayItem[];
}

export interface LidarRouteEditMessage {
  type: 'UPDATE_ROUTE_POINTS';
  version: 1;
  updatedAt: string;
  source: 'redview_app' | 'lidar_viewer';
  /** Projet de l'expéditeur (absent : version précédente). */
  projectId?: string;
  routeId: string;
  points: LidarRouteOverlayPoint[];
  actionName?: string;
}

export interface LidarRouteCreateMessage {
  type: 'CREATE_ROUTE';
  version: 1;
  updatedAt: string;
  source: 'redview_app' | 'lidar_viewer';
  /** Projet de l'expéditeur (absent : version précédente). */
  projectId?: string;
  route: LidarRouteOverlayItem;
}

/**
 * Une copie faite dans le viewer : l'app duplique elle-même `sourceRouteId`
 * (profil, timeline…) sous `route.id`, ou ajoute `route` tel quel sans source.
 */
export interface LidarRouteDuplicateMessage {
  type: 'DUPLICATE_ROUTE';
  version: 1;
  updatedAt: string;
  source: 'redview_app' | 'lidar_viewer';
  /** Projet de l'expéditeur (absent : version précédente). */
  projectId?: string;
  sourceRouteId: string;
  route: LidarRouteOverlayItem;
}

export interface LidarRouteRenameMessage {
  type: 'RENAME_ROUTE';
  version: 1;
  updatedAt: string;
  source: 'redview_app' | 'lidar_viewer';
  /** Projet de l'expéditeur (absent : version précédente). */
  projectId?: string;
  routeId: string;
  name: string;
}

export interface LidarRouteDeleteMessage {
  type: 'DELETE_ROUTE';
  version: 1;
  updatedAt: string;
  source: 'redview_app' | 'lidar_viewer';
  /** Projet de l'expéditeur (absent : version précédente). */
  projectId?: string;
  routeId: string;
}

export type LidarRouteSyncMessage =
  | LidarRouteOverlayState
  | LidarRouteCreateMessage
  | LidarRouteDuplicateMessage
  | LidarRouteEditMessage
  | LidarRouteRenameMessage
  | LidarRouteDeleteMessage;

function normalizeRouteColor(color: string | undefined): string {
  if (!color || typeof color !== 'string') return '#E53935';
  const trimmed = color.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return trimmed;
  return '#E53935';
}

function normalizeRouteOpacity(opacity: number | undefined): number {
  if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return 1.0;
  if (opacity > 1.0) return Math.max(0, Math.min(1, opacity / 100));
  return Math.max(0, Math.min(1, opacity));
}

let _sharedBroadcastChannel: BroadcastChannel | null = null;

function getSharedBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!_sharedBroadcastChannel) {
    try {
      _sharedBroadcastChannel = new BroadcastChannel(LIDAR_ROUTE_OVERLAY_CHANNEL_NAME);
    } catch (err) {
      console.warn('[LiDAR] Failed to initialize persistent BroadcastChannel:', err);
    }
  }
  return _sharedBroadcastChannel;
}

let _storageDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingStorageState: LidarRouteOverlayState | null = null;

function scheduleStorageWrite(state: LidarRouteOverlayState): void {
  _pendingStorageState = state;
  if (_storageDebounceTimer) return;
  _storageDebounceTimer = setTimeout(() => {
    _storageDebounceTimer = null;
    if (typeof window === 'undefined' || !_pendingStorageState) return;
    try {
      // Clé du projet de l’état (la page a pu changer de projet pendant l’attente).
      const key = _pendingStorageState.projectId ? `${LIDAR_ROUTE_OVERLAY_STORAGE_KEY}:${_pendingStorageState.projectId}` : LIDAR_ROUTE_OVERLAY_STORAGE_KEY;
      window.localStorage.setItem(key, JSON.stringify(_pendingStorageState));
    } catch (err) {
      console.warn('[LiDAR] Failed to write route overlay to localStorage:', err);
    }
    _pendingStorageState = null;
  }, 100);
}

type AppRoutePoints = NonNullable<Itinerary['gpxRoute']>['points'];

const NO_ROUTE_POINTS: AppRoutePoints = [];

/**
 * Copie viewer de chaque tableau de points de l'app. Le store remplace le
 * tableau quand la trace change : une trace inchangée garde la même copie
 * d'un état à l'autre, sans la refaire (un ultra de 1 200 km : ~120 000
 * points recopiés à chaque modification du projet).
 */
const overlayPointsByRoute = new WeakMap<AppRoutePoints, LidarRouteOverlayPoint[]>();

function toOverlayPoints(rawPoints: AppRoutePoints): LidarRouteOverlayPoint[] {
  let points = overlayPointsByRoute.get(rawPoints);
  if (!points) {
    points = rawPoints.map((pt) => ({
      lat: pt.lat,
      lon: pt.lon,
      elevationM: Number.isFinite(pt.elevationM) ? pt.elevationM : null,
      distanceM: Number.isFinite(pt.distanceM) ? pt.distanceM : undefined,
    }));
    overlayPointsByRoute.set(rawPoints, points);
  }
  return points;
}

function sameOverlayRoutes(a: readonly LidarRouteOverlayItem[], b: readonly LidarRouteOverlayItem[]): boolean {
  return a.length === b.length && a.every((route, i) => {
    const other = b[i];
    return other !== undefined
      && route.id === other.id
      && route.name === other.name
      && route.color === other.color
      && route.opacity === other.opacity
      && route.visible === other.visible
      && route.points === other.points;
  });
}

/** Traces du dernier état publié par l'app (onglet courant). */
let lastPublishedRoutes: readonly LidarRouteOverlayItem[] | null = null;

export function extractLidarRouteOverlayState(
  itineraries: readonly Itinerary[] | null | undefined,
  source: 'redview_app' | 'lidar_viewer' = 'redview_app',
): LidarRouteOverlayState {
  if (!itineraries || itineraries.length === 0) {
    return {
      version: 1,
      ...projectStamp(),
      updatedAt: new Date().toISOString(),
      source,
      routes: [],
    };
  }

  const routes: LidarRouteOverlayItem[] = [];

  for (const itinerary of itineraries) {
    routes.push({
      id: itinerary.id,
      name: itinerary.name || translateAppText('Itinéraire'),
      color: normalizeRouteColor(itinerary.color),
      opacity: normalizeRouteOpacity(itinerary.opacity),
      visible: itinerary.visible !== false,
      points: toOverlayPoints(itinerary.gpxRoute?.points ?? NO_ROUTE_POINTS),
    });
  }

  return {
    version: 1,
    ...projectStamp(),
    updatedAt: new Date().toISOString(),
    source,
    routes,
  };
}

/**
 * Publie les traces au viewer (BroadcastChannel + copie localStorage).
 * `onlyIfChanged` : rien n'est envoyé quand aucune trace n'a changé depuis la
 * dernière publication (nom, couleur, opacité, visibilité, points) — la
 * plupart des modifications du projet (horaires, POI, prédictions…) ne
 * touchent pas les traces, et chaque envoi clone et sérialise tous leurs
 * points. Les appels explicites (ouverture du viewer, retour au tracé
 * stocké) publient toujours.
 */
export function syncLidarRouteOverlay(
  itineraries: readonly Itinerary[] | null | undefined,
  source: 'redview_app' | 'lidar_viewer' = 'redview_app',
  { onlyIfChanged = false }: { onlyIfChanged?: boolean } = {},
): LidarRouteOverlayState {
  const state = extractLidarRouteOverlayState(itineraries, source);
  if (onlyIfChanged && lastPublishedRoutes && sameOverlayRoutes(lastPublishedRoutes, state.routes)) {
    return state;
  }
  lastPublishedRoutes = state.routes;

  if (typeof window !== 'undefined') {
    scheduleStorageWrite(state);

    try {
      const bc = getSharedBroadcastChannel();
      bc?.postMessage(state);
    } catch (err) {
      console.warn('[LiDAR] Failed to broadcast route overlay:', err);
    }
  }

  return state;
}

export function broadcastLidarRouteEdit(
  routeId: string,
  points: LidarRouteOverlayPoint[],
  source: 'redview_app' | 'lidar_viewer' = 'lidar_viewer',
  actionName?: string,
): void {
  if (typeof window === 'undefined') return;

  const msg: LidarRouteEditMessage = {
    type: 'UPDATE_ROUTE_POINTS',
    version: 1,
    ...projectStamp(),
    updatedAt: new Date().toISOString(),
    source,
    routeId,
    points,
    actionName,
  };

  // 1) Mettre à jour l'état des tracés en stockage local
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (raw) {
      const parsed = JSON.parse(raw) as LidarRouteOverlayState;
      if (parsed && Array.isArray(parsed.routes)) {
        const target = parsed.routes.find((r) => r.id === routeId);
        if (target) {
          target.points = points;
          parsed.updatedAt = msg.updatedAt;
          parsed.source = source;
          scheduleStorageWrite(parsed);
        }
      }
    }
  } catch (err) {
    console.warn('[LiDAR] Failed to update localStorage on route edit:', err);
  }

  // 2) Diffuser le message d'édition
  try {
    const bc = getSharedBroadcastChannel();
    bc?.postMessage(msg);
  } catch (err) {
    console.warn('[LiDAR] Failed to broadcast route edit message:', err);
  }
}

export function broadcastLidarRouteCreate(
  route: LidarRouteOverlayItem,
  source: 'redview_app' | 'lidar_viewer' = 'lidar_viewer',
): void {
  if (typeof window === 'undefined') return;

  const msg: LidarRouteCreateMessage = {
    type: 'CREATE_ROUTE',
    version: 1,
    ...projectStamp(),
    updatedAt: new Date().toISOString(),
    source,
    route,
  };
  storeAddedRoute(route, source, msg.updatedAt);
  postRouteMessage(msg);
}

export function broadcastLidarRouteDuplicate(
  sourceRouteId: string,
  route: LidarRouteOverlayItem,
  source: 'redview_app' | 'lidar_viewer' = 'lidar_viewer',
): void {
  if (typeof window === 'undefined') return;

  const msg: LidarRouteDuplicateMessage = {
    type: 'DUPLICATE_ROUTE',
    version: 1,
    ...projectStamp(),
    updatedAt: new Date().toISOString(),
    source,
    sourceRouteId,
    route,
  };
  storeAddedRoute(route, source, msg.updatedAt);
  postRouteMessage(msg);
}

function storeAddedRoute(
  route: LidarRouteOverlayItem,
  source: 'redview_app' | 'lidar_viewer',
  updatedAt: string,
): void {
  try {
    const raw = window.localStorage.getItem(storageKey());
    const parsed = raw ? (JSON.parse(raw) as LidarRouteOverlayState) : null;
    const currentRoutes = parsed && Array.isArray(parsed.routes) ? parsed.routes : [];
    const nextRoutes = [...currentRoutes.filter((r) => r.id !== route.id), route];
    scheduleStorageWrite({
      version: 1,
      ...projectStamp(),
      updatedAt,
      source,
      routes: nextRoutes,
    });
  } catch (err) {
    console.warn('[LiDAR] Failed to update localStorage on route create:', err);
  }
}

function postRouteMessage(msg: LidarRouteSyncMessage): void {
  try {
    const bc = getSharedBroadcastChannel();
    bc?.postMessage(msg);
  } catch (err) {
    console.warn('[LiDAR] Failed to broadcast route message:', err);
  }
}

export function broadcastLidarRouteRename(
  routeId: string,
  name: string,
  source: 'redview_app' | 'lidar_viewer' = 'lidar_viewer',
): void {
  if (typeof window === 'undefined') return;

  const msg: LidarRouteRenameMessage = {
    type: 'RENAME_ROUTE',
    version: 1,
    ...projectStamp(),
    updatedAt: new Date().toISOString(),
    source,
    routeId,
    name,
  };

  // 1) Mettre à jour le localStorage
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (raw) {
      const parsed = JSON.parse(raw) as LidarRouteOverlayState;
      if (parsed && Array.isArray(parsed.routes)) {
        const target = parsed.routes.find((r) => r.id === routeId);
        if (target) {
          target.name = name;
          parsed.updatedAt = msg.updatedAt;
          parsed.source = source;
          scheduleStorageWrite(parsed);
        }
      }
    }
  } catch (err) {
    console.warn('[LiDAR] Failed to update localStorage on route rename:', err);
  }

  // 2) Broadcast
  try {
    const bc = getSharedBroadcastChannel();
    bc?.postMessage(msg);
  } catch (err) {
    console.warn('[LiDAR] Failed to broadcast route rename message:', err);
  }
}

export function broadcastLidarRouteDelete(
  routeId: string,
  source: 'redview_app' | 'lidar_viewer' = 'lidar_viewer',
): void {
  if (typeof window === 'undefined') return;

  const msg: LidarRouteDeleteMessage = {
    type: 'DELETE_ROUTE',
    version: 1,
    ...projectStamp(),
    updatedAt: new Date().toISOString(),
    source,
    routeId,
  };

  // 1) Mettre à jour le localStorage
  try {
    const raw = window.localStorage.getItem(storageKey());
    if (raw) {
      const parsed = JSON.parse(raw) as LidarRouteOverlayState;
      if (parsed && Array.isArray(parsed.routes)) {
        parsed.routes = parsed.routes.filter((r) => r.id !== routeId);
        parsed.updatedAt = msg.updatedAt;
        parsed.source = source;
        scheduleStorageWrite(parsed);
      }
    }
  } catch (err) {
    console.warn('[LiDAR] Failed to update localStorage on route delete:', err);
  }

  // 2) Broadcast
  try {
    const bc = getSharedBroadcastChannel();
    bc?.postMessage(msg);
  } catch (err) {
    console.warn('[LiDAR] Failed to broadcast route delete message:', err);
  }
}

export function loadLidarRouteOverlay(): LidarRouteOverlayState | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(storageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LidarRouteOverlayState;
    if (parsed && Array.isArray(parsed.routes)) {
      return parsed;
    }
  } catch (err) {
    console.warn('[LiDAR Route] Error loading route overlay from localStorage:', err);
  }

  return null;
}

export function subscribeToLidarRouteOverlay(
  onUpdate: (msg: LidarRouteSyncMessage) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  let bc: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel(LIDAR_ROUTE_OVERLAY_CHANNEL_NAME);
      bc.onmessage = (event) => {
        const data = event.data as LidarRouteSyncMessage;
        if (data && isForThisProject(data)) {
          onUpdate(data);
        }
      };
    }
  } catch (err) {
    console.warn('[LiDAR Route] Failed to initialize BroadcastChannel:', err);
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey() && event.newValue) {
      try {
        const state = JSON.parse(event.newValue) as LidarRouteOverlayState;
        if (state && Array.isArray(state.routes) && isForThisProject(state)) {
          onUpdate(state);
        }
      } catch (err) {
        console.warn('[LiDAR Route] Error parsing storage event:', err);
      }
    }
  };

  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener('storage', handleStorage);
    if (bc) {
      try {
        bc.close();
      } catch {
        // ignore
      }
      bc = null;
    }
  };
}
