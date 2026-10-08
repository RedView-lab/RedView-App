import { logger } from '@/shared/lib/logger';
import {
  checkRouteWithinFrance,
  formatBrouterErrorMessage,
  formatForbiddenZonePolygons,
  type BrouterRoute,
} from '../../lib/brouter';
import type { RouteProfilePoint } from '../../lib/route-metrics';
import { isRouteSeamError } from '../../lib/routes';
import type { DerivedComputeGate } from '../../context/ProjectStore/collab';
import type { Itinerary, ItineraryProject } from '../../types';
import { anchorRoutePatchBound } from '../useItineraryBrouterRoutingShared';
import { resolveElasticRoutePatch } from './elasticRoutePatch';
import type { UnresolvedRouteEdit } from './pendingEditPlan';
import { applyPendingRoutePatch, captureRouteRefinementBase, type RouteRefinementBase } from './projectMutations';
import { resolveRouteRequest } from './resolveRouteRequest';
import { getRoutingInputsSignature } from './routingInputs';
import { trackRouteComputed, trackRouteFailed } from './routingAnalytics';

/** Marqueur « tracé restauré par undo/redo, à vérifier par estampille ». */
export const VERIFY_STORED_ROUTE = '#verify-stored-route';
/**
 * Édition locale qui ne se recolle pas au tracé stocké sans ligne droite :
 * enregistrée comme non résolue sous cette clé, elle force le recalcul complet
 * (cf. planPendingRouteEdit).
 */
export const UNJOINABLE_EDIT_KEY = '#unjoinable-edit';

/**
 * Patch local en vol pour un itinéraire. Il ne dépend pas de l'itinéraire
 * actif : changer de sélection (ou éditer un autre itinéraire) ne l'annule
 * pas ; seuls une nouvelle édition du même itinéraire, un undo / redo ou le
 * démontage le remplacent.
 */
export interface PatchJob {
  pendingKey: string;
  /** Entrées de routage (profil, zones…) avec lesquelles il est routé. */
  inputsSignature: string;
  ctrl: AbortController;
}

/** Ce dont le job a besoin du hook de routage (refs et setters, lus au moment de l'appel). */
export interface RoutePatchJobDeps {
  jobs: Map<string, PatchJob>;
  activeId: () => string | undefined;
  abortPatchJob: (itineraryId: string) => void;
  gate: DerivedComputeGate;
  unresolvedEdits: Map<string, UnresolvedRouteEdit>;
  routedInputKeys: Map<string, string>;
  setProject: (updater: (project: ItineraryProject) => ItineraryProject) => void;
  setRouteLoading: (loading: boolean) => void;
  bumpRouteRequestNonce: () => void;
  setRouteError: (error: string | null) => void;
  setRouteWarnings: (warnings: string[]) => void;
  deferRouteState: (error: string | null) => void;
  requestRouteRefresh: () => void;
  refineRouteInBackground: (
    itineraryId: string,
    route: BrouterRoute,
    baseBox: { current: RouteRefinementBase | null },
    applyWithProfile: (project: ItineraryProject, profile: RouteProfilePoint[]) => ItineraryProject,
    reason: string,
  ) => void;
}

/**
 * Route l'édition locale en attente (`pendingRoutePatch`) d'un itinéraire,
 * actif ou non : une édition faite sur un itinéraire non sélectionné (ou
 * dont on change la sélection pendant le calcul) est routée quand même.
 * Rien n'est relancé si le même patch est déjà en vol.
 */
export function ensureRoutePatchJob(deps: RoutePatchJobDeps, itinerary: Itinerary, pendingKey: string): void {
  const { jobs, gate, setProject, setRouteLoading } = deps;
  const isActive = () => deps.activeId() === itinerary.id;
  // Profil ou zones changés pendant le calcul : relancé avec les nouveaux.
  const inputsSignature = getRoutingInputsSignature(itinerary);
  const running = jobs.get(itinerary.id);
  if (running?.pendingKey === pendingKey && running.inputsSignature === inputsSignature) {
    if (isActive()) setRouteLoading(true);
    return;
  }
  deps.abortPatchJob(itinerary.id);

  const pendingRoutePatch = itinerary.pendingRoutePatch;
  const existingRoutePoints = itinerary.gpxRoute?.points ?? null;
  if (!pendingRoutePatch || !existingRoutePoints || existingRoutePoints.length < 2) return;

  const patchPoints = [pendingRoutePatch.start, ...pendingRoutePatch.via, pendingRoutePatch.end];
  const bounds = checkRouteWithinFrance(patchPoints);
  if (!bounds.ok) {
    if (isActive()) deps.deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
    return;
  }

  const ctrl = new AbortController();
  jobs.set(itinerary.id, { pendingKey, inputsSignature, ctrl });
  if (isActive()) {
    setRouteLoading(true);
    queueMicrotask(() => {
      deps.bumpRouteRequestNonce();
      deps.setRouteError(null);
    });
  }
  const releaseCompute = gate.beginCompute('route', itinerary.id);
  const unresolvedEdits = deps.unresolvedEdits;
  unresolvedEdits.set(itinerary.id, { kind: 'patch', pendingKey });
  const polygons = formatForbiddenZonePolygons(itinerary.forbiddenZones);
  const target = { itineraryId: itinerary.id, pendingKey };
  const t0 = performance.now();
  logger.brouter.info(
    'local patch START itinerary=',
    itinerary.id,
    'start=',
    `${pendingRoutePatch.start.lon},${pendingRoutePatch.start.lat}`,
    'end=',
    `${pendingRoutePatch.end.lon},${pendingRoutePatch.end.lat}`,
    'via=',
    pendingRoutePatch.via.length,
  );

  resolveElasticRoutePatch(pendingRoutePatch, existingRoutePoints, ctrl.signal, (patch) => resolveRouteRequest({
    itinerary,
    signal: ctrl.signal,
    requestBase: {
      // Bornes intermédiaires prises sur le tracé stocké : la jonction s'y fait.
      start: anchorRoutePatchBound(patch.start, existingRoutePoints),
      end: anchorRoutePatchBound(patch.end, existingRoutePoints),
      via: patch.via,
      polygons,
      signal: ctrl.signal,
    },
    setRouteWarnings: (warnings) => {
      if (isActive()) deps.setRouteWarnings(warnings);
    },
  }))
    .then(({ route, resolvedWarnings, patch: routedPatch }) => {
      if (ctrl.signal.aborted) return;
      if (isActive()) deps.setRouteWarnings(resolvedWarnings);
      // Render route immediately with native BRouter elevation data
      const refinementBase: { current: RouteRefinementBase | null } = { current: null };
      setProject((project) => {
        const next = applyPendingRoutePatch(project, target, route, null, routedPatch);
        refinementBase.current = captureRouteRefinementBase(project, next, target.itineraryId);
        return next;
      });
      if (unresolvedEdits.get(itinerary.id)?.pendingKey === pendingKey) unresolvedEdits.delete(itinerary.id);
      // Le tracé patché porte l'estampille de ses entrées : vérifié par
      // elle au prochain passage de l'effet de routage.
      deps.routedInputKeys.set(itinerary.id, VERIFY_STORED_ROUTE);
      trackRouteComputed('patch', itinerary, route, performance.now() - t0);
      logger.brouter.info(
        'local patch OK in',
        Math.round(performance.now() - t0),
        'ms | dist=',
        (route.distanceM / 1000).toFixed(2),
        'km | pts=',
        route.coordinates.length,
      );
      deps.refineRouteInBackground(
        target.itineraryId,
        route,
        refinementBase,
        (project, profile) => applyPendingRoutePatch(project, target, route, profile, routedPatch),
        'local patch',
      );
    })
    .catch((error: unknown) => {
      if ((error as { name?: string }).name === 'AbortError' || ctrl.signal.aborted) return;
      if (isRouteSeamError(error)) {
        // Édition impossible à recoller sans ligne droite : tout le tracé
        // est recalculé, seul résultat sans ligne droite (tout de suite si
        // l'itinéraire est actif, sinon à sa prochaine sélection).
        console.warn('[BRouter] local edit does not join the stored route: full recompute', error);
        unresolvedEdits.set(itinerary.id, { kind: 'patch', pendingKey: UNJOINABLE_EDIT_KEY });
        if (isActive()) deps.requestRouteRefresh();
        return;
      }
      console.error('[BRouter local patch fail]', error);
      trackRouteFailed('patch', error);
      if (isActive()) deps.setRouteError(formatBrouterErrorMessage(error));
    })
    .finally(() => {
      releaseCompute();
      if (jobs.get(itinerary.id)?.ctrl === ctrl) jobs.delete(itinerary.id);
      if (!ctrl.signal.aborted && isActive()) setRouteLoading(false);
    });
}
