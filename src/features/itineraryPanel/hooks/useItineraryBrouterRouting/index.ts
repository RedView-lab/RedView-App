import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { normalizeDiscipline } from '@/shared/lib/discipline';
import {
  buildBrfProfile,
  checkRouteWithinFrance,
  formatBrouterErrorMessage,
  formatForbiddenZonePolygons,
  hashBrf,
  isClimbingMode,
  type BrouterRoute,
} from '../../lib/brouter';
import type { RouteProfilePoint } from '../../lib/route-metrics';
import type { Itinerary, ItineraryProject } from '../../types';
import { refineRouteProfileWithIgnAltimetry } from '../../lib/route-metrics';
import {
  hasRouteLayer,
  removeRouteLayer,
} from '../../lib/route-layer';
import {
  RouteSeamError,
  haversineRouteDistanceM,
  isRouteSeamError,
  routeSeamJoins,
} from '../../lib/routes';
import {
  anchorRoutePatchBound,
  isBrouterUnmappedPointError,
  type UseItineraryBrouterRoutingArgs,
} from '../useItineraryBrouterRoutingShared';

import { useDerivedComputeGate, useProjectStoreOptional } from '../../context/ProjectStore/hooks';
import {
  applyPendingRoutePatch,
  applyPendingTraceAppend,
  applyRecomputedRoute,
  applyRefinedRouteProfile,
  applyUnroutableRouteCleared,
  captureRouteRefinementBase,
  type RouteRefinementBase,
} from './projectMutations';
import {
  getRoutingEndpointsKey,
  getRoutingInputsSignature,
  routeStampMatches,
} from './routingInputs';
import { resolveRouteRequest } from './resolveRouteRequest';
import { resolveElasticRoutePatch } from './elasticRoutePatch';
import type { RouteRequestBase } from './customProfileFetch';
import { planPendingRouteEdit, type UnresolvedRouteEdit } from './pendingEditPlan';
import { trackRouteComputed, trackRouteFailed } from './routingAnalytics';
import { logger } from '@/shared/lib/logger';

/** Marqueur « tracé restauré par undo/redo, à vérifier par estampille ». */
const VERIFY_STORED_ROUTE = '#verify-stored-route';
/**
 * Édition locale qui ne se recolle pas au tracé stocké sans ligne droite :
 * enregistrée comme non résolue sous cette clé, elle force le recalcul complet
 * (cf. planPendingRouteEdit).
 */
const UNJOINABLE_EDIT_KEY = '#unjoinable-edit';

/**
 * Patch local en vol pour un itinéraire. Il ne dépend pas de l'itinéraire
 * actif : changer de sélection (ou éditer un autre itinéraire) ne l'annule
 * pas ; seuls une nouvelle édition du même itinéraire, un undo / redo ou le
 * démontage le remplacent.
 */
interface PatchJob {
  pendingKey: string;
  /** Entrées de routage (profil, zones…) avec lesquelles il est routé. */
  inputsSignature: string;
  ctrl: AbortController;
}

function dispatchRouteLoading(loading: boolean) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rv-route-loading', { detail: { loading } }));
  }
}

/**
 * « Calcul en cours » de l'itinéraire actif. C'est l'état du planificateur de
 * requêtes (minuteur d'anti-rebond, AbortController, jobs de patch : tous hors
 * React, en refs), pas un état dérivé du rendu : posé quand une requête est
 * programmée ou lancée — y compris par l'effet de routage — et levé quand elle
 * aboutit, échoue ou est annulée. Une seule source pour React
 * (useSyncExternalStore) et pour le curseur de la carte (`rv-route-loading`,
 * émis à chaque écriture comme avant, même valeur répétée comprise).
 */
interface RouteLoadingStore {
  get: () => boolean;
  subscribe: (listener: () => void) => () => void;
  set: (loading: boolean) => void;
}

function createRouteLoadingStore(): RouteLoadingStore {
  let loading = false;
  const listeners = new Set<() => void>();
  return {
    get: () => loading,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      dispatchRouteLoading(next);
      if (next === loading) return;
      loading = next;
      for (const listener of listeners) listener();
    },
  };
}

export function useItineraryBrouterRouting({
  active,
  itineraries,
  historyRevision,
  isMapLoaded,
  map,
  rollbackPendingTraceAppend,
  setProject,
}: UseItineraryBrouterRoutingArgs) {
  const [routeLoadingStore] = useState(createRouteLoadingStore);
  const routeLoading = useSyncExternalStore(routeLoadingStore.subscribe, routeLoadingStore.get);
  const setRouteLoading = routeLoadingStore.set;
  const [routeRequestNonce, setRouteRequestNonce] = useState(0);
  const [routeRefreshNonce, setRouteRefreshNonce] = useState(0);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeWarnings, setRouteWarnings] = useState<string[]>([]);
  const routeAbortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(active);
  // Patchs locaux en vol, par itinéraire (cf. PatchJob).
  const patchJobsRef = useRef(new Map<string, PatchJob>());
  const cancelRouteRequest = useCallback(() => {
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    const activeId = activeRef.current?.id;
    if (activeId) {
      patchJobsRef.current.get(activeId)?.ctrl.abort();
      patchJobsRef.current.delete(activeId);
    }
    setRouteLoading(false);
  }, [setRouteLoading]);
  // When set to true, the next "full recompute" branch of the routing
  // effect is skipped and the flag is cleared.  This is used by the
  // recalculate-trace feature to prevent the effect from overwriting
  // the freshly-recalculated route with a single (often failing)
  // end-to-end BRouter request.
  const skipRouteRecomputeRef = useRef(false);
  const skipNextRouteRecompute = useCallback(() => {
    skipRouteRecomputeRef.current = true;
  }, []);
  // Clé des entrées de routage (départ, arrivée, via, profil, BRF, zones…)
  // ayant produit le tracé actuellement stocké, par itinéraire. Évite de
  // relancer BRouter à l'ouverture d'un projet (le tracé sauvegardé est déjà
  // le résultat de ces entrées) ou quand seul le tracé stocké a changé
  // (nb de points après un patch / append / affinage altimétrique IGN).
  const routedInputKeysRef = useRef(new Map<string, string>());
  // Révision d'historique vue au dernier passage de l'effet de routage : un
  // undo/redo restaure un tracé déjà calculé, qui fait foi (cf. effet).
  const seenHistoryRevisionRef = useRef(historyRevision);
  // Édition locale (ajout / patch) demandée mais pas encore appliquée, par
  // itinéraire : une nouvelle édition la fusionne ou force un recalcul complet
  // au lieu de l'écraser (cf. planPendingRouteEdit).
  const unresolvedEditsRef = useRef(new Map<string, UnresolvedRouteEdit>());
  // Affinage altimétrique en cours, par itinéraire. Contrôleur propre : la
  // relance de l'effet (déclenchée par la 1re application du tracé) ne doit
  // pas l'annuler ; seul un nouveau tracé pour cet itinéraire le remplace.
  const refinementAbortRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Co-édition : modifications d'autres éditeurs appliquées (cf. effet de
  // routage), et désignation de qui route (l'auteur de la modification).
  const externalRevision = useProjectStoreOptional()?.externalRevision ?? 0;
  const externalRevisionRef = useRef(externalRevision);
  const seenExternalRevisionRef = useRef(externalRevision);
  useEffect(() => {
    externalRevisionRef.current = externalRevision;
  }, [externalRevision]);
  const { gate, retryNonce: gateRetryNonce, markWaiting: markWaitingForGate } = useDerivedComputeGate();

  useEffect(() => {
    const refinements = refinementAbortRef.current;
    const patchJobs = patchJobsRef.current;
    return () => {
      dispatchRouteLoading(false);
      for (const ctrl of refinements.values()) ctrl.abort();
      refinements.clear();
      for (const job of patchJobs.values()) job.ctrl.abort();
      patchJobs.clear();
    };
  }, []);

  const beginRouteRequest = useCallback(() => {
    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    setRouteLoading(true);
    queueMicrotask(() => {
      setRouteRequestNonce((current) => current + 1);
      setRouteError(null);
    });
    return ctrl;
  }, [setRouteLoading]);
  const settleRouteState = useCallback((nextError: string | null) => {
    setRouteError(nextError);
    setRouteLoading(false);
  }, [setRouteLoading]);
  const deferRouteState = useCallback((nextError: string | null) => {
    queueMicrotask(() => {
      settleRouteState(nextError);
    });
  }, [settleRouteState]);
  const resolveIgnAltimetryRouteProfile = useCallback(
    async (route: BrouterRoute, signal: AbortSignal, reason: string) => {
      if (signal.aborted) return null;
      try {
        return await refineRouteProfileWithIgnAltimetry(route, signal);
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return null;
        console.warn(`[BRouter] ${reason}: IGN altimetry refinement failed`, error);
        return null;
      }
    },
    [],
  );
  /**
   * Affinage altimétrique MNT (IGN 1 m en France, Copernicus ailleurs) d'un
   * tracé tout juste appliqué, en arrière-plan. Le résultat se rattache au
   * tracé affiné (cf. applyRefinedRouteProfile), pas à l'édition en attente
   * déjà effacée par la 1re application.
   */
  const refineRouteInBackground = useCallback(
    (
      itineraryId: string,
      route: BrouterRoute,
      baseBox: { current: RouteRefinementBase | null },
      applyWithProfile: (project: ItineraryProject, profile: RouteProfilePoint[]) => ItineraryProject,
      reason: string,
    ) => {
      if (route.distanceM > 500_000) return;
      const refinements = refinementAbortRef.current;
      refinements.get(itineraryId)?.abort();
      const ctrl = new AbortController();
      refinements.set(itineraryId, ctrl);
      void resolveIgnAltimetryRouteProfile(route, ctrl.signal, reason).then((profile) => {
        if (refinements.get(itineraryId) === ctrl) refinements.delete(itineraryId);
        const base = baseBox.current;
        if (!profile || ctrl.signal.aborted || !base) return;
        setProject((project) => applyRefinedRouteProfile(
          project,
          base,
          (baseProject) => applyWithProfile(baseProject, profile),
        ));
      });
    },
    [resolveIgnAltimetryRouteProfile, setProject],
  );
  const requestRouteRefresh = useCallback(() => {
    setRouteRefreshNonce((current) => current + 1);
  }, []);

  const abortPatchJob = useCallback((itineraryId: string) => {
    const jobs = patchJobsRef.current;
    jobs.get(itineraryId)?.ctrl.abort();
    jobs.delete(itineraryId);
  }, []);

  /**
   * Route l'édition locale en attente (`pendingRoutePatch`) d'un itinéraire,
   * actif ou non : une édition faite sur un itinéraire non sélectionné (ou
   * dont on change la sélection pendant le calcul) est routée quand même.
   * Rien n'est relancé si le même patch est déjà en vol.
   */
  const ensurePatchJob = useCallback(
    (itinerary: Itinerary, pendingKey: string) => {
      const jobs = patchJobsRef.current;
      const isActive = () => activeRef.current?.id === itinerary.id;
      // Profil ou zones changés pendant le calcul : relancé avec les nouveaux.
      const inputsSignature = getRoutingInputsSignature(itinerary);
      const running = jobs.get(itinerary.id);
      if (running?.pendingKey === pendingKey && running.inputsSignature === inputsSignature) {
        if (isActive()) setRouteLoading(true);
        return;
      }
      abortPatchJob(itinerary.id);

      const pendingRoutePatch = itinerary.pendingRoutePatch;
      const existingRoutePoints = itinerary.gpxRoute?.points ?? null;
      if (!pendingRoutePatch || !existingRoutePoints || existingRoutePoints.length < 2) return;

      const patchPoints = [pendingRoutePatch.start, ...pendingRoutePatch.via, pendingRoutePatch.end];
      const bounds = checkRouteWithinFrance(patchPoints);
      if (!bounds.ok) {
        if (isActive()) deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
        return;
      }

      const ctrl = new AbortController();
      jobs.set(itinerary.id, { pendingKey, inputsSignature, ctrl });
      if (isActive()) {
        setRouteLoading(true);
        queueMicrotask(() => {
          setRouteRequestNonce((current) => current + 1);
          setRouteError(null);
        });
      }
      const releaseCompute = gate.beginCompute('route', itinerary.id);
      const unresolvedEdits = unresolvedEditsRef.current;
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
          if (isActive()) setRouteWarnings(warnings);
        },
      }))
        .then(({ route, resolvedWarnings, patch: routedPatch }) => {
          if (ctrl.signal.aborted) return;
          if (isActive()) setRouteWarnings(resolvedWarnings);
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
          routedInputKeysRef.current.set(itinerary.id, VERIFY_STORED_ROUTE);
          trackRouteComputed('patch', itinerary, route, performance.now() - t0);
          logger.brouter.info(
            'local patch OK in',
            Math.round(performance.now() - t0),
            'ms | dist=',
            (route.distanceM / 1000).toFixed(2),
            'km | pts=',
            route.coordinates.length,
          );
          refineRouteInBackground(
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
            if (isActive()) requestRouteRefresh();
            return;
          }
          console.error('[BRouter local patch fail]', error);
          trackRouteFailed('patch', error);
          if (isActive()) setRouteError(formatBrouterErrorMessage(error));
        })
        .finally(() => {
          releaseCompute();
          if (jobs.get(itinerary.id)?.ctrl === ctrl) jobs.delete(itinerary.id);
          if (!ctrl.signal.aborted && isActive()) setRouteLoading(false);
        });
    },
    [abortPatchJob, deferRouteState, gate, refineRouteInBackground, requestRouteRefresh, setProject, setRouteLoading],
  );

  const {
    startKey,
    endKey,
    viaKey: routingViaKey,
  } = getRoutingEndpointsKey(active);
  const activeId = active?.id ?? '';
  const profileId = active?.profileId ?? 'road';
  const climbing = active ? isClimbingMode(active.priorities) : false;
  const forbiddenPolygons = formatForbiddenZonePolygons(active?.forbiddenZones);
  const pendingRoutePatchKey = active?.pendingRoutePatch
    ? JSON.stringify(active.pendingRoutePatch)
    : '';
  const pendingTraceExtensionKey = active?.pendingTraceExtension
    ? JSON.stringify(active.pendingTraceExtension)
    : '';
  const gpxRouteSource = active?.gpxRoute?.source ?? '';
  const gpxRoutePointCount = active?.gpxRoute?.points.length ?? 0;
  const prioritiesKey = active ? JSON.stringify(active.priorities) : '';
  const roadTypesKey = active ? JSON.stringify(active.roadTypes) : '';
  const expertProfileKey = active?.expertProfile
    ? JSON.stringify(active.expertProfile)
    : '';
  // Trail / Running switch the BRF to the pedestrian network.
  const discipline = normalizeDiscipline(active?.discipline);

  const brfInputs = useMemo(() => {
    if (!prioritiesKey || !roadTypesKey) return null;
    return {
      priorities: JSON.parse(prioritiesKey),
      roadTypes: JSON.parse(roadTypesKey),
      expert: expertProfileKey ? JSON.parse(expertProfileKey) : undefined,
      discipline,
    };
  }, [discipline, expertProfileKey, prioritiesKey, roadTypesKey]);

  const brfProfile = useMemo(() => {
    if (!brfInputs) return '';
    try {
      return buildBrfProfile(brfInputs);
    } catch (error) {
      console.warn('[BRouter] buildBrfProfile threw:', error);
      return '';
    }
  }, [brfInputs]);

  const brfHash = useMemo(() => {
    if (!brfProfile) return '';
    return hashBrf(brfProfile);
  }, [brfProfile]);

  useEffect(() => {
    if (!brfProfile) return;
    logger.brouter.info(
      'BRF hash =',
      brfHash,
      '| size =',
      brfProfile.length,
      'B | profile =',
      profileId,
      '| priorities =',
      prioritiesKey,
    );
  }, [brfHash, brfProfile, prioritiesKey, profileId]);

  const routingInputKey = [
    startKey,
    endKey,
    routingViaKey,
    profileId,
    brfHash,
    climbing ? 1 : 0,
    forbiddenPolygons ?? '',
    // Toujours en dernier : relu par l'effet (recalcul demandé depuis le routage).
    routeRefreshNonce,
  ].join('#');

  useEffect(() => {
    if (!map || !isMapLoaded) return;
    const currentActive = activeRef.current;
    const routedInputKeys = routedInputKeysRef.current;
    if (seenHistoryRevisionRef.current !== historyRevision) {
      // Undo / redo : l'état restauré porte son propre tracé. Les entrées
      // routées en dernier (celles de l'état quitté) ne valent plus : les
      // itinéraires routés pendant la session passent en vérification par
      // estampille (cf. plus bas) au lieu de déclencher un recalcul complet
      // qui écraserait le tracé restauré. La requête en vol a déjà été
      // abandonnée par le cleanup de l'effet (dépendance `historyRevision`).
      seenHistoryRevisionRef.current = historyRevision;
      for (const id of routedInputKeys.keys()) {
        routedInputKeys.set(id, VERIFY_STORED_ROUTE);
      }
      // L'état restauré porte ses propres éditions en attente.
      unresolvedEditsRef.current.clear();
      for (const id of [...patchJobsRef.current.keys()]) abortPatchJob(id);
    }
    if (seenExternalRevisionRef.current !== externalRevisionRef.current) {
      // Modifications d'autres éditeurs : un tracé stocké fait foi s'il porte
      // l'estampille des entrées actuelles (son auteur l'a routé) ; les
      // éditions en attente de cet appareil gardent leur cours.
      seenExternalRevisionRef.current = externalRevisionRef.current;
      for (const id of routedInputKeys.keys()) {
        if (!unresolvedEditsRef.current.has(id)) routedInputKeys.set(id, VERIFY_STORED_ROUTE);
      }
    }
    const unresolvedEdits = unresolvedEditsRef.current;
    const existingRoutePoints = currentActive?.gpxRoute?.points ?? null;
    const editPlan = planPendingRouteEdit(
      currentActive,
      currentActive ? unresolvedEdits.get(currentActive.id) : undefined,
    );
    const resolveUnresolvedEdit = (itineraryId: string, pendingKey?: string) => {
      const entry = unresolvedEdits.get(itineraryId);
      if (entry && (pendingKey === undefined || entry.pendingKey === pendingKey)) {
        unresolvedEdits.delete(itineraryId);
      }
    };
    // Édition locale impossible à recoller sans ligne droite (étape loin du
    // réseau routable, GPX hors voie) : tout le tracé est recalculé, seul
    // résultat sans ligne droite.
    const recomputeUnjoinableEdit = (itineraryId: string, error: unknown) => {
      console.warn('[BRouter] local edit does not join the stored route: full recompute', error);
      unresolvedEdits.set(itineraryId, { kind: 'patch', pendingKey: UNJOINABLE_EDIT_KEY });
      requestRouteRefresh();
    };

    if (currentActive && editPlan.mode === 'full') {
      // Édition remplacée avant d'être routée : son patch en vol ne vaut plus.
      abortPatchJob(currentActive.id);
    }

    if (
      currentActive &&
      editPlan.mode === 'patch' &&
      currentActive.pendingRoutePatch &&
      existingRoutePoints &&
      existingRoutePoints.length >= 2
    ) {
      // Requête portée par un job par itinéraire, pas par cet effet : elle
      // survit à un changement de sélection (cf. ensurePatchJob).
      ensurePatchJob(currentActive, editPlan.pendingKey);
      return;
    }

    if (
      currentActive &&
      editPlan.mode === 'append' &&
      existingRoutePoints &&
      existingRoutePoints.length >= 2
    ) {
      // Depuis le dernier point routé, via les clics pas encore routés.
      const appendStart = editPlan.from;
      const appendVia = editPlan.via;
      const appendEnd = editPlan.to;
      const bounds = checkRouteWithinFrance([appendStart, ...appendVia, appendEnd]);
      if (!bounds.ok) {
        deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
        return;
      }

      const ctrl = beginRouteRequest();
      const releaseCompute = gate.beginCompute('route', currentActive.id);

      const itineraryForRouting = currentActive;
      const t0 = performance.now();
      logger.brouter.info(
        'append segment START hash=',
        brfHash,
        'climbing=',
        climbing,
        'from=',
        `${appendStart.lon},${appendStart.lat}`,
        'to=',
        `${appendEnd.lon},${appendEnd.lat}`,
        'via=',
        appendVia.length,
      );

      const target = {
        itineraryId: itineraryForRouting.id,
        pendingKey: editPlan.pendingKey,
      };
      unresolvedEdits.set(itineraryForRouting.id, {
        kind: 'append',
        pendingKey: editPlan.pendingKey,
        append: { from: appendStart, via: appendVia, to: appendEnd },
      });
      const requestBase: RouteRequestBase = {
        start: appendStart,
        end: appendEnd,
        via: appendVia,
        polygons: forbiddenPolygons,
        signal: ctrl.signal,
      };

      resolveRouteRequest({
        itinerary: itineraryForRouting,
        signal: ctrl.signal,
        requestBase,
        setRouteWarnings,
      })
        .then(({ route, resolvedWarnings }) => {
          if (ctrl.signal.aborted) return;
          // L'extension doit repartir de la fin du tracé stocké.
          const storedEnd = existingRoutePoints[existingRoutePoints.length - 1]!;
          const [fromLon, fromLat] = route.coordinates[0] ?? [Number.NaN, Number.NaN];
          const extensionStart = { lat: fromLat, lon: fromLon };
          if (!routeSeamJoins(storedEnd, extensionStart)) {
            recomputeUnjoinableEdit(
              itineraryForRouting.id,
              new RouteSeamError('trace extension', haversineRouteDistanceM(storedEnd, extensionStart)),
            );
            return;
          }
          setRouteWarnings(resolvedWarnings);
          // Render route immediately with native BRouter elevation data
          const refinementBase: { current: RouteRefinementBase | null } = { current: null };
          setProject((project) => {
            const next = applyPendingTraceAppend(project, target, route, null);
            refinementBase.current = captureRouteRefinementBase(project, next, target.itineraryId);
            return next;
          });
          resolveUnresolvedEdit(itineraryForRouting.id, target.pendingKey);
          routedInputKeys.set(itineraryForRouting.id, routingInputKey);
          setRouteLoading(false);
          trackRouteComputed('extend', itineraryForRouting, route, performance.now() - t0);
          logger.brouter.info(
            'append segment OK in',
            Math.round(performance.now() - t0),
            'ms | dist=',
            (route.distanceM / 1000).toFixed(2),
            'km | pts=',
            route.coordinates.length,
          );
          refineRouteInBackground(
            target.itineraryId,
            route,
            refinementBase,
            (project, profile) => applyPendingTraceAppend(project, target, route, profile),
            'append segment',
          );
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'AbortError') return;
          if (isRouteSeamError(error)) {
            recomputeUnjoinableEdit(itineraryForRouting.id, error);
            return;
          }
          if (currentActive && isBrouterUnmappedPointError(error)) {
            // Clic hors réseau annulé : l'état antérieur porte sa propre extension.
            resolveUnresolvedEdit(currentActive.id);
            rollbackPendingTraceAppend(currentActive.id);
          }
          console.error('[BRouter append fail]', error);
          trackRouteFailed('extend', error);
          setRouteError(formatBrouterErrorMessage(error));
        })
        .finally(() => {
          releaseCompute();
          if (!ctrl.signal.aborted) setRouteLoading(false);
        });

      return () => {
        ctrl.abort();
        releaseCompute();
      };
    }

    // Sans arrivée, le dernier point de passage en tient lieu (cf.
    // getRoutingEndpoints) : on ne s'arrête qu'en dessous de deux points.
    if (!startKey || !endKey) {
      if (currentActive) {
        setProject((project) => applyUnroutableRouteCleared(project, currentActive.id));
      }
      deferRouteState(null);
      return;
    }

    // GPX importé : il fait foi. Ses éditions passent par des patchs locaux
    // (cf. hasEditableRoute) ; seul le recalcul d'une édition perdue en route
    // le reroute en entier. Ses étapes hors trace (<wpt> importés à plus de
    // 25 m) ne le recalculent plus dès l'import.
    if (currentActive?.gpxRoute?.source === 'gpx' && editPlan.mode !== 'full') {
      deferRouteState(null);
      return;
    }

    // After a segment-by-segment recalculation the source flips from
    // 'gpx' → 'brouter' which re-triggers this effect.  Skip the full
    // recompute once so we don't overwrite the result with a failing
    // single-request route.
    if (skipRouteRecomputeRef.current) {
      skipRouteRecomputeRef.current = false;
      logger.brouter.info('skipping full recompute (recalculate-trace guard)');
      deferRouteState(null);
      return;
    }

    // Tracé BRouter déjà stocké pour ces entrées : rien à recalculer. Au
    // premier passage sur un itinéraire (ouverture de projet, duplication),
    // le tracé sauvegardé fait foi.
    const hasStoredRoute =
      currentActive?.gpxRoute?.source === 'brouter' &&
      (existingRoutePoints?.length ?? 0) >= 2;
    // Édition locale remplacée avant d'être routée : le tracé stocké est
    // incomplet, on recalcule tout au lieu de lui faire confiance.
    const forceFullRecompute = editPlan.mode === 'full';
    if (currentActive && hasStoredRoute && !forceFullRecompute) {
      // Premier passage (ouverture, duplication, autre appareil) : vérifié par
      // estampille, comme après undo/redo — un tracé laissé en plein
      // recalcul ailleurs (l'édition en attente reste sur son appareil) est
      // recalculé au lieu de rester faux.
      const routedKey = routedInputKeys.get(currentActive.id) ?? VERIFY_STORED_ROUTE;
      // Après undo/redo : le tracé restauré fait foi s'il a été routé pour les
      // entrées restaurées ; figé en plein recalcul (estampille différente),
      // il est recalculé.
      const storedInputsKey = currentActive.gpxRoute?.routedInputsKey;
      const storedStampIsCurrent = storedInputsKey !== undefined && routeStampMatches(currentActive, storedInputsKey);
      const restoredRouteIsCurrent =
        routedKey === VERIFY_STORED_ROUTE &&
        (storedInputsKey === undefined || storedStampIsCurrent);
      // Tracé modifié sur place pour les nouvelles entrées (départ / arrivée
      // rognés sur le tracé) : il fait foi, sauf recalcul demandé depuis.
      const editedInPlace =
        routedKey !== VERIFY_STORED_ROUTE &&
        storedStampIsCurrent &&
        routedKey.slice(routedKey.lastIndexOf('#') + 1) === String(routeRefreshNonce);
      if (routedKey === routingInputKey || restoredRouteIsCurrent || editedInPlace) {
        routedInputKeys.set(currentActive.id, routingInputKey);
        deferRouteState(null);
        return;
      }
    }

    if (currentActive && !gate.shouldCompute('route', currentActive.id)) {
      // Modification d'un autre éditeur : il route, son tracé arrivera (ou
      // cet appareil sera désigné s'il part sans l'avoir fait).
      markWaitingForGate();
      deferRouteState(null);
      return;
    }

    const [startLon, startLat] = startKey.split(',').map(Number);
    const [endLon, endLat] = endKey.split(',').map(Number);
    const userVia = routingViaKey
      ? routingViaKey.split('|').map((segment) => {
          const [lon, lat] = segment.split(',').map(Number);
          return { lat, lon };
        })
      : [];
    // Plus de MAX_BROUTER_VIA_PER_REQUEST via : resolveRouteRequest découpe en tronçons.
    const via = userVia;

    const allPoints = [
      { lat: startLat, lon: startLon },
      { lat: endLat, lon: endLon },
      ...via,
    ];
    const bounds = checkRouteWithinFrance(allPoints);
    if (!bounds.ok) {
      if (currentActive && hasRouteLayer(map, currentActive.id)) {
        try {
          removeRouteLayer(map, currentActive.id);
        } catch {
          // noop
        }
      }
      deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
      return;
    }

    setRouteLoading(true);
    let ctrl: AbortController | null = null;
    let releaseCompute: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      const activeCtrl = beginRouteRequest();
      ctrl = activeCtrl;

      const itineraryForRouting = activeRef.current ?? currentActive;
      if (!itineraryForRouting) return;
      releaseCompute = gate.beginCompute('route', itineraryForRouting.id);
      const target = {
        itineraryId: itineraryForRouting.id,
        inputsSignature: getRoutingInputsSignature(itineraryForRouting),
      };

      const t0 = performance.now();
      logger.brouter.info(
        'recompute START hash=',
        brfHash,
        'climbing=',
        climbing,
        'start=',
        startKey,
        'end=',
        endKey,
        'via=',
        routingViaKey || '∅',
      );

      const requestBase: RouteRequestBase = {
        start: { lat: startLat, lon: startLon },
        end: { lat: endLat, lon: endLon },
        via,
        polygons: forbiddenPolygons,
        signal: activeCtrl.signal,
      };

      resolveRouteRequest({
        itinerary: itineraryForRouting,
        signal: activeCtrl.signal,
        requestBase,
        setRouteWarnings,
      })
        .then(({ route, resolvedWarnings, resolved }) => {
          if (activeCtrl.signal.aborted) return;
          logger.brouter.info(
            'profile resolved →',
            resolved.profileId,
            '| brf=',
            `${resolved.brf.length}B`,
            '| warnings=',
            resolved.roadTypes.warnings.length,
          );
          setRouteWarnings(resolvedWarnings);
          logger.brouter.info(
            'route OK in',
            Math.round(performance.now() - t0),
            'ms | dist=',
            (route.distanceM / 1000).toFixed(2),
            'km | ascent=',
            Math.round(route.ascentM),
            'm | pts=',
            route.coordinates.length,
          );
          // Render route immediately with native BRouter elevation data & unblock UI
          const refinementBase: { current: RouteRefinementBase | null } = { current: null };
          setProject((project) => {
            const next = applyRecomputedRoute(project, target, route, null);
            refinementBase.current = captureRouteRefinementBase(project, next, target.itineraryId);
            return next;
          });
          resolveUnresolvedEdit(itineraryForRouting.id);
          routedInputKeys.set(itineraryForRouting.id, routingInputKey);
          setRouteLoading(false);

          trackRouteComputed('full', itineraryForRouting, route, performance.now() - t0);

          refineRouteInBackground(
            target.itineraryId,
            route,
            refinementBase,
            (project, profile) => applyRecomputedRoute(project, target, route, profile),
            'recompute route',
          );
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'AbortError') return;
          console.error('[BRouter fetch fail]', error);
          trackRouteFailed('full', error);
          setRouteError(formatBrouterErrorMessage(error));
        })
        .finally(() => {
          releaseCompute?.();
          if (!activeCtrl.signal.aborted) setRouteLoading(false);
        });
    }, 120);

    return () => {
      window.clearTimeout(timer);
      ctrl?.abort();
      releaseCompute?.();
    };
  }, [
    abortPatchJob,
    activeId,
    beginRouteRequest,
    brfHash,
    climbing,
    endKey,
    forbiddenPolygons,
    deferRouteState,
    ensurePatchJob,
    gate,
    gateRetryNonce,
    gpxRoutePointCount,
    gpxRouteSource,
    historyRevision,
    isMapLoaded,
    map,
    markWaitingForGate,
    pendingRoutePatchKey,
    pendingTraceExtensionKey,
    profileId,
    refineRouteInBackground,
    requestRouteRefresh,
    routeRefreshNonce,
    routingInputKey,
    rollbackPendingTraceAppend,
    setProject,
    setRouteLoading,
    startKey,
    routingViaKey,
  ]);

  // Éditions locales des itinéraires non sélectionnés (point glissé sur un
  // autre itinéraire, sélection changée pendant le calcul) : routées aussi.
  // Déclaré après l'effet principal : un undo / redo y a déjà vidé les
  // éditions en vol quand celui-ci relance celles de l'état restauré.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    for (const itinerary of itineraries) {
      if (itinerary.id === activeId) continue;
      const plan = planPendingRouteEdit(itinerary, unresolvedEditsRef.current.get(itinerary.id));
      if (plan.mode === 'patch') {
        ensurePatchJob(itinerary, plan.pendingKey);
      } else if (plan.mode === 'full') {
        // Recalcul complet : fait à la sélection de l'itinéraire (effet principal).
        abortPatchJob(itinerary.id);
      }
    }
  }, [abortPatchJob, activeId, ensurePatchJob, historyRevision, isMapLoaded, itineraries, map]);

  return {
    cancelRouteRequest,
    requestRouteRefresh,
    routeError,
    routeLoading,
    routeRequestNonce,
    routeWarnings,
    skipNextRouteRecompute,
  };
}