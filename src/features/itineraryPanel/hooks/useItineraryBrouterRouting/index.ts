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
import { refineRouteProfileWithIgnAltimetry } from '../../lib/route-metrics';
import {
  hasRouteLayer,
  removeRouteLayer,
} from '../../lib/route-layer';
import {
  isBrouterUnmappedPointError,
  type UseItineraryBrouterRoutingArgs,
} from '../useItineraryBrouterRoutingShared';

import { applyRouteWarnings } from './profileFallback';
import {
  applyPendingRoutePatch,
  applyPendingTraceAppend,
  applyRecomputedRoute,
  getRoutingEndpointsKey,
  getRoutingInputsSignature,
} from './projectMutations';
import { resolveRouteRequest } from './resolveRouteRequest';
import type { RouteRequestBase } from './profileFallback';

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

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    return () => {
      dispatchRouteLoading(false);
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
  const requestRouteRefresh = useCallback(() => {
    setRouteRefreshNonce((current) => current + 1);
  }, []);

  const {
    startKey,
    endKey,
    viaKey: routingViaKey,
  } = getRoutingEndpointsKey(active);
  const activeId = active?.id ?? '';
  const hasWaypointOverride = routingViaKey.length > 0;
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
    }
    const pendingRoutePatch = currentActive?.pendingRoutePatch;
    const pendingTraceExtension = currentActive?.pendingTraceExtension;
    const existingRoutePoints = currentActive?.gpxRoute?.points ?? null;

    if (
      currentActive &&
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
        pendingKey: JSON.stringify(pendingRoutePatch),
      };
      const requestBase: RouteRequestBase = {
        start: pendingRoutePatch.start,
        end: pendingRoutePatch.end,
        via: pendingRoutePatch.via,
        polygons: forbiddenPolygons,
        signal: ctrl.signal,
      };

      resolveRouteRequest({
        itinerary: itineraryForRouting,
        signal: ctrl.signal,
        requestBase,
        setRouteWarnings,
      })
        .then(async ({ route, usedFallbackProfile, resolvedWarnings }) => {
          if (ctrl.signal.aborted) return;
          setRouteWarnings(applyRouteWarnings(resolvedWarnings, usedFallbackProfile));
          // Render route immediately with native BRouter elevation data
          setProject((project) => applyPendingRoutePatch(project, target, route, null));
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
          // Background MNT (1m bare-earth) altimetry refinement (France IGN + International)
          if (route.distanceM <= 500_000) {
            const ignAltimetryRouteProfile = await resolveIgnAltimetryRouteProfile(route, ctrl.signal, 'local patch');
            if (ignAltimetryRouteProfile && !ctrl.signal.aborted) {
              setProject((project) => applyPendingRoutePatch(project, target, route, ignAltimetryRouteProfile));
            }
          }
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
      pendingTraceExtension &&
      existingRoutePoints &&
      existingRoutePoints.length >= 2
    ) {
      const appendStart = pendingTraceExtension.from;
      const appendEnd = pendingTraceExtension.to;
      const bounds = checkRouteWithinFrance([appendStart, appendEnd]);
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
      );

      const target = {
        itineraryId: itineraryForRouting.id,
        pendingKey: JSON.stringify(pendingTraceExtension),
      };
      const requestBase: RouteRequestBase = {
        start: appendStart,
        end: appendEnd,
        via: [] as Array<{ lat: number; lon: number }>,
        polygons: forbiddenPolygons,
        signal: ctrl.signal,
      };

      resolveRouteRequest({
        itinerary: itineraryForRouting,
        signal: ctrl.signal,
        requestBase,
        setRouteWarnings,
      })
        .then(async ({ route, usedFallbackProfile, resolvedWarnings }) => {
          if (ctrl.signal.aborted) return;
          setRouteWarnings(applyRouteWarnings(resolvedWarnings, usedFallbackProfile));
          // Render route immediately with native BRouter elevation data
          setProject((project) => applyPendingTraceAppend(project, target, route, null));
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
          // Background MNT (1m bare-earth) altimetry refinement (France IGN + International)
          if (route.distanceM <= 500_000) {
            const ignAltimetryRouteProfile = await resolveIgnAltimetryRouteProfile(route, ctrl.signal, 'append segment');
            if (ignAltimetryRouteProfile && !ctrl.signal.aborted) {
              setProject((project) => applyPendingTraceAppend(project, target, route, ignAltimetryRouteProfile));
            }
          }
        })
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === 'AbortError') return;
          if (currentActive && isBrouterUnmappedPointError(error)) {
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

    if (!startKey || !endKey) {
      deferRouteState(null);
      return;
    }

    if (currentActive?.gpxRoute?.source === 'gpx' && !hasWaypointOverride) {
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
    if (currentActive && hasStoredRoute) {
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
        .then(async ({ route, usedFallbackProfile, resolvedWarnings, resolved }) => {
          if (activeCtrl.signal.aborted) return;
          console.log(
            '[BRouter] profile resolved →',
            resolved.profileId,
            '| brf=',
            resolved.brf ? `${resolved.brf.length}B` : 'stock',
            '| warnings=',
            resolved.roadTypes.warnings.length,
          );
          setRouteWarnings(applyRouteWarnings(resolvedWarnings, usedFallbackProfile));
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
          setProject((project) => applyRecomputedRoute(project, target, route, null));
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

          // Background MNT (1m bare-earth) altimetry refinement (France IGN + International)
          if (route.distanceM <= 500_000) {
            const ignAltimetryRouteProfile = await resolveIgnAltimetryRouteProfile(route, activeCtrl.signal, 'recompute route');
            if (ignAltimetryRouteProfile && !activeCtrl.signal.aborted) {
              setProject((project) => applyRecomputedRoute(project, target, route, ignAltimetryRouteProfile));
            }
          }
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
    hasWaypointOverride,
    historyRevision,
    isMapLoaded,
    map,
    pendingRoutePatchKey,
    pendingTraceExtensionKey,
    profileId,
    resolveIgnAltimetryRouteProfile,
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