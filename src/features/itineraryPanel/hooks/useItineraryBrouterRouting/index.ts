import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { trackAnalyticsEvent } from '../../../../shared/lib/analytics';
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
import type { ItineraryProject } from '../../types';
import { refineRouteProfileWithIgnAltimetry } from '../../lib/route-metrics';
import {
  hasRouteLayer,
  removeRouteLayer,
} from '../../lib/route-layer';
import {
  isBrouterUnmappedPointError,
  type UseItineraryBrouterRoutingArgs,
} from '../useItineraryBrouterRoutingShared';

import {
  applyPendingRoutePatch,
  applyPendingTraceAppend,
  applyRecomputedRoute,
  applyRefinedRouteProfile,
  applyUnroutableRouteCleared,
  captureRouteRefinementBase,
  getRoutingEndpointsKey,
  getRoutingInputsSignature,
  type RouteRefinementBase,
} from './projectMutations';
import { resolveRouteRequest } from './resolveRouteRequest';
import { resolveElasticRoutePatch } from './elasticRoutePatch';
import type { RouteRequestBase } from './customProfileFetch';
import { planPendingRouteEdit, type UnresolvedRouteEdit } from './pendingEditPlan';

/** Marqueur « tracé restauré par undo/redo, à vérifier par estampille ». */
const VERIFY_STORED_ROUTE = '#verify-stored-route';

function dispatchRouteLoading(loading: boolean) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rv-route-loading', { detail: { loading } }));
  }
}

export function useItineraryBrouterRouting({
  active,
  historyRevision,
  isMapLoaded,
  map,
  rollbackPendingTraceAppend,
  setProject,
}: UseItineraryBrouterRoutingArgs) {
  const [routeLoading, _setRouteLoading] = useState(false);
  const setRouteLoading = useCallback((loading: boolean) => {
    _setRouteLoading(loading);
    dispatchRouteLoading(loading);
  }, []);
  const [routeRequestNonce, setRouteRequestNonce] = useState(0);
  const [routeRefreshNonce, setRouteRefreshNonce] = useState(0);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeWarnings, setRouteWarnings] = useState<string[]>([]);
  const routeAbortRef = useRef<AbortController | null>(null);
  const cancelRouteRequest = useCallback(() => {
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    setRouteLoading(false);
  }, [setRouteLoading]);
  const activeRef = useRef(active);
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

  useEffect(() => {
    const refinements = refinementAbortRef.current;
    return () => {
      dispatchRouteLoading(false);
      for (const ctrl of refinements.values()) ctrl.abort();
      refinements.clear();
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
    console.log(
      '[BRouter] BRF hash =',
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
    }
    const unresolvedEdits = unresolvedEditsRef.current;
    const pendingRoutePatch = currentActive?.pendingRoutePatch;
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

    if (
      currentActive &&
      editPlan.mode === 'patch' &&
      pendingRoutePatch &&
      existingRoutePoints &&
      existingRoutePoints.length >= 2
    ) {
      const patchPoints = [
        pendingRoutePatch.start,
        ...pendingRoutePatch.via,
        pendingRoutePatch.end,
      ];
      const bounds = checkRouteWithinFrance(patchPoints);
      if (!bounds.ok) {
        deferRouteState(bounds.reason ?? 'Itinéraire hors zone autorisée.');
        return;
      }

      const ctrl = beginRouteRequest();

      const itineraryForRouting = currentActive;
      const t0 = performance.now();
      console.log(
        '[BRouter] local patch START hash=',
        brfHash,
        'climbing=',
        climbing,
        'start=',
        `${pendingRoutePatch.start.lon},${pendingRoutePatch.start.lat}`,
        'end=',
        `${pendingRoutePatch.end.lon},${pendingRoutePatch.end.lat}`,
        'via=',
        pendingRoutePatch.via.length,
      );

      const target = {
        itineraryId: itineraryForRouting.id,
        pendingKey: editPlan.pendingKey,
      };
      unresolvedEdits.set(itineraryForRouting.id, { kind: 'patch', pendingKey: editPlan.pendingKey });

      resolveElasticRoutePatch(pendingRoutePatch, existingRoutePoints, ctrl.signal, (patch) => resolveRouteRequest({
        itinerary: itineraryForRouting,
        signal: ctrl.signal,
        requestBase: {
          start: patch.start,
          end: patch.end,
          via: patch.via,
          polygons: forbiddenPolygons,
          signal: ctrl.signal,
        },
        setRouteWarnings,
      }))
        .then(({ route, resolvedWarnings, patch: routedPatch }) => {
          if (ctrl.signal.aborted) return;
          setRouteWarnings(resolvedWarnings);
          // Render route immediately with native BRouter elevation data
          const refinementBase: { current: RouteRefinementBase | null } = { current: null };
          setProject((project) => {
            const next = applyPendingRoutePatch(project, target, route, null, routedPatch);
            refinementBase.current = captureRouteRefinementBase(project, next, target.itineraryId);
            return next;
          });
          resolveUnresolvedEdit(itineraryForRouting.id, target.pendingKey);
          routedInputKeys.set(itineraryForRouting.id, routingInputKey);
          setRouteLoading(false);
          console.log(
            '[BRouter] local patch OK in',
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
          if ((error as { name?: string }).name === 'AbortError') return;
          console.error('[BRouter local patch fail]', error);
          setRouteError(formatBrouterErrorMessage(error));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setRouteLoading(false);
        });

      return () => ctrl.abort();
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

      const itineraryForRouting = currentActive;
      const t0 = performance.now();
      console.log(
        '[BRouter] append segment START hash=',
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
          console.log(
            '[BRouter] append segment OK in',
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
          if (currentActive && isBrouterUnmappedPointError(error)) {
            // Clic hors réseau annulé : l'état antérieur porte sa propre extension.
            resolveUnresolvedEdit(currentActive.id);
            rollbackPendingTraceAppend(currentActive.id);
          }
          console.error('[BRouter append fail]', error);
          setRouteError(formatBrouterErrorMessage(error));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setRouteLoading(false);
        });

      return () => ctrl.abort();
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
      console.log('[BRouter] skipping full recompute (recalculate-trace guard)');
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
      const routedKey = routedInputKeys.get(currentActive.id);
      // Après undo/redo : le tracé restauré fait foi s'il a été routé pour les
      // entrées restaurées ; figé en plein recalcul (estampille différente),
      // il est recalculé.
      const storedInputsKey = currentActive.gpxRoute?.routedInputsKey;
      const restoredRouteIsCurrent =
        routedKey === VERIFY_STORED_ROUTE &&
        (storedInputsKey === undefined ||
          storedInputsKey === getRoutingInputsSignature(currentActive));
      if (
        routedKey === undefined ||
        routedKey === routingInputKey ||
        restoredRouteIsCurrent
      ) {
        routedInputKeys.set(currentActive.id, routingInputKey);
        deferRouteState(null);
        return;
      }
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
    const timer = window.setTimeout(() => {
      const activeCtrl = beginRouteRequest();
      ctrl = activeCtrl;

      const itineraryForRouting = activeRef.current ?? currentActive;
      if (!itineraryForRouting) return;
      const target = {
        itineraryId: itineraryForRouting.id,
        inputsSignature: getRoutingInputsSignature(itineraryForRouting),
      };

      const t0 = performance.now();
      console.log(
        '[BRouter] recompute START hash=',
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
          console.log(
            '[BRouter] profile resolved →',
            resolved.profileId,
            '| brf=',
            `${resolved.brf.length}B`,
            '| warnings=',
            resolved.roadTypes.warnings.length,
          );
          setRouteWarnings(resolvedWarnings);
          console.log(
            '[BRouter] route OK in',
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

          trackAnalyticsEvent({
            name: 'route_calculated',
            data: {
              distance_km: Math.round(route.distanceM / 1000),
              elevation_gain: Math.round(route.ascentM),
              surface: resolved?.roadTypes?.effective?.gravel === 'prefer' ? 'gravel' : 'road',
            },
          });

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
          setRouteError(formatBrouterErrorMessage(error));
        })
        .finally(() => {
          if (!activeCtrl.signal.aborted) setRouteLoading(false);
        });
    }, 120);

    return () => {
      window.clearTimeout(timer);
      ctrl?.abort();
    };
  }, [
    activeId,
    beginRouteRequest,
    brfHash,
    climbing,
    endKey,
    forbiddenPolygons,
    deferRouteState,
    gpxRoutePointCount,
    gpxRouteSource,
    historyRevision,
    isMapLoaded,
    map,
    pendingRoutePatchKey,
    pendingTraceExtensionKey,
    profileId,
    refineRouteInBackground,
    routeRefreshNonce,
    routingInputKey,
    rollbackPendingTraceAppend,
    setProject,
    startKey,
    routingViaKey,
  ]);

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