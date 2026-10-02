import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createOverlayStatus,
  type OverlayStatusId,
  type OverlayStatusSnapshot,
} from '@/features/map3d';
import { translateAppText } from '@/shared/i18n';

// ── Loading guard ────────────────────────────────────────────────────────
// Last line of defence so no pill ever sits on "loading" forever: each
// producer has its own watchdog, but several depend on Mapbox `idle` /
// `areTilesLoaded()`, which can stay false indefinitely while any source
// streams. A loading cycle is displayed as finished once it has not advanced
// for LOADING_STALL_MS, or has lasted LOADING_MAX_MS in total.
const LOADING_STALL_MS = 8_000;
const LOADING_MAX_MS = 20_000;
/** A progress drop larger than this means the producer started a new cycle. */
const LOADING_RESTART_DROP = 15;
/** Itinerary tracks a real BRouter request with a definite end (and drives the cursor loader). */
const LOADING_GUARD_EXEMPT: ReadonlySet<OverlayStatusId> = new Set(['itinerary']);

interface LoadingCycle {
  startedAt: number;
  advancedAt: number;
  progress: number;
  detail?: string;
}

function loadingCycleDeadline(cycle: LoadingCycle): number {
  return Math.min(cycle.startedAt + LOADING_MAX_MS, cycle.advancedAt + LOADING_STALL_MS);
}

interface UseDashboardOverlayStatusResult {
  visibleStatuses: OverlayStatusSnapshot[];
  handleOverlayReload: (id: OverlayStatusId) => void;
  handleMapLoadStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleMapReloadChange: (reload: (() => void) | null) => void;
  handleWeatherOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleWindOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleShadowOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleSunlightMapOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleSlopeOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleAltitudeOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleItineraryRouteStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleWeatherOverlayReloadChange: (reload: (() => void) | null) => void;
  handleWindOverlayReloadChange: (reload: (() => void) | null) => void;
  handleShadowOverlayReloadChange: (reload: (() => void) | null) => void;
  handleSunlightMapOverlayReloadChange: (reload: (() => void) | null) => void;
}

export function useDashboardOverlayStatus(): UseDashboardOverlayStatusResult {
  const [mapStatus, setMapStatus] = useState<OverlayStatusSnapshot | null>(null);
  const [overlayStatuses, setOverlayStatuses] = useState<
    Partial<Record<OverlayStatusId, OverlayStatusSnapshot>>
  >({});
  const overlayReloadersRef = useRef<Partial<Record<OverlayStatusId, () => void>>>({});
  const [loadingCycles, setLoadingCycles] = useState<Partial<Record<OverlayStatusId, LoadingCycle>>>({});
  const [guardNow, setGuardNow] = useState(() => Date.now());

  const trackLoadingCycle = useCallback((id: OverlayStatusId, status: OverlayStatusSnapshot | null) => {
    const now = Date.now();
    setLoadingCycles((prev) => {
      const current = prev[id];
      if (!status || status.state !== 'loading' || LOADING_GUARD_EXEMPT.has(id)) {
        if (!current) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      if (!current || status.progress < current.progress - LOADING_RESTART_DROP) {
        return { ...prev, [id]: { startedAt: now, advancedAt: now, progress: status.progress, detail: status.detail } };
      }
      if (status.progress === current.progress && status.detail === current.detail) return prev;
      return { ...prev, [id]: { ...current, advancedAt: now, progress: status.progress, detail: status.detail } };
    });
  }, []);

  const setOverlayStatus = useCallback((id: OverlayStatusId, status: OverlayStatusSnapshot | null) => {
    trackLoadingCycle(id, status);
    setOverlayStatuses((prev) => {
      if (!status) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const current = prev[id];
      if (
        current
        && current.state === status.state
        && current.progress === status.progress
        && current.detail === status.detail
        && current.reloadable === status.reloadable
        && current.nonce === status.nonce
      ) {
        return prev;
      }
      return { ...prev, [id]: status };
    });
  }, [trackLoadingCycle]);

  const setOverlayReloader = useCallback((id: OverlayStatusId, reload: (() => void) | null) => {
    if (reload) {
      overlayReloadersRef.current[id] = reload;
      if (id !== 'map') {
        setOverlayStatuses((prev) => {
          const current = prev[id];
          if (!current || current.reloadable) return prev;
          return {
            ...prev,
            [id]: { ...current, reloadable: true },
          };
        });
      }
      return;
    }
    delete overlayReloadersRef.current[id];
    if (id !== 'map') {
      setOverlayStatuses((prev) => {
        const current = prev[id];
        if (!current || current.state !== 'ready') return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }, []);

  const handleMapLoadStatusChange = useCallback((status: OverlayStatusSnapshot | null) => {
    trackLoadingCycle('map', status);
    setMapStatus(status);
  }, [trackLoadingCycle]);

  const handleMapReloadChange = useCallback((reload: (() => void) | null) => {
    setOverlayReloader('map', reload);
    setMapStatus((prev) => {
      if (!reload) {
        if (!prev) return null;
        if (!prev.reloadable) return prev;
        return { ...prev, reloadable: false, updatedAt: Date.now() };
      }

      if (!prev) {
        return createOverlayStatus({
          id: 'map',
          label: 'Carte',
          state: 'ready',
          progress: 100,
          detail: translateAppText('Carte prête'),
          reloadable: true,
        });
      }

      if (prev.reloadable) return prev;
      return { ...prev, reloadable: true, updatedAt: Date.now() };
    });
  }, [setOverlayReloader]);

  const handleOverlayReload = useCallback((id: OverlayStatusId) => {
    overlayReloadersRef.current[id]?.();
  }, []);

  const visibleStatuses = useMemo(() => {
    const orderedIds: OverlayStatusId[] = ['itinerary', 'shadow', 'sunlight-map', 'map', 'altitude', 'slope', 'weather', 'wind'];
    const snapshots: Partial<Record<OverlayStatusId, OverlayStatusSnapshot>> = {
      ...overlayStatuses,
      ...(mapStatus
        ? {
            map: {
              ...mapStatus,
              reloadable: mapStatus.reloadable ?? Boolean(overlayReloadersRef.current.map),
            },
          }
        : {}),
    };
    return orderedIds
      .map((id) => snapshots[id])
      .filter((status): status is OverlayStatusSnapshot => Boolean(status))
      .map((status) => {
        if (status.state !== 'loading') return status;
        const cycle = loadingCycles[status.id];
        if (!cycle || guardNow < loadingCycleDeadline(cycle)) return status;
        return { ...status, state: 'ready' as const, progress: 100 };
      });
  }, [mapStatus, overlayStatuses, loadingCycles, guardNow]);

  // Wake up exactly when the next loading cycle expires so the pill flips
  // to "ready" without polling.
  useEffect(() => {
    let nextDeadline = Infinity;
    for (const cycle of Object.values(loadingCycles)) {
      if (!cycle) continue;
      const deadline = loadingCycleDeadline(cycle);
      if (deadline > guardNow) nextDeadline = Math.min(nextDeadline, deadline);
    }
    if (!Number.isFinite(nextDeadline)) return;
    const timer = setTimeout(() => setGuardNow(Date.now()), Math.max(0, nextDeadline - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [loadingCycles, guardNow]);

  // IMPORTANT: keep these handler identities stable across renders. Several
  // overlay hooks (useWind, useWeatherOverlay…) include the reporter/reload
  // callbacks in their effect dependencies, so a fresh arrow function on
  // every Dashboard render retriggers their main effects in a loop —
  // aborting in-flight fetches and producing the "[wind] fetch start" spam
  // / weather overlay stuck-at-28% symptom.
  const handleWeatherOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => setOverlayStatus('weather', status),
    [setOverlayStatus],
  );
  const handleWindOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => setOverlayStatus('wind', status),
    [setOverlayStatus],
  );
  const handleShadowOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => setOverlayStatus('shadow', status),
    [setOverlayStatus],
  );
  const handleSunlightMapOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => setOverlayStatus('sunlight-map', status),
    [setOverlayStatus],
  );
  const handleSlopeOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => setOverlayStatus('slope', status),
    [setOverlayStatus],
  );
  const handleAltitudeOverlayStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => setOverlayStatus('altitude', status),
    [setOverlayStatus],
  );
  const handleItineraryRouteStatusChange = useCallback(
    (status: OverlayStatusSnapshot | null) => setOverlayStatus('itinerary', status),
    [setOverlayStatus],
  );
  const handleWeatherOverlayReloadChange = useCallback(
    (reload: (() => void) | null) => setOverlayReloader('weather', reload),
    [setOverlayReloader],
  );
  const handleWindOverlayReloadChange = useCallback(
    (reload: (() => void) | null) => setOverlayReloader('wind', reload),
    [setOverlayReloader],
  );
  const handleShadowOverlayReloadChange = useCallback(
    (reload: (() => void) | null) => setOverlayReloader('shadow', reload),
    [setOverlayReloader],
  );
  const handleSunlightMapOverlayReloadChange = useCallback(
    (reload: (() => void) | null) => setOverlayReloader('sunlight-map', reload),
    [setOverlayReloader],
  );

  return {
    visibleStatuses,
    handleOverlayReload,
    handleMapLoadStatusChange,
    handleMapReloadChange,
    handleWeatherOverlayStatusChange,
    handleWindOverlayStatusChange,
    handleShadowOverlayStatusChange,
    handleSunlightMapOverlayStatusChange,
    handleSlopeOverlayStatusChange,
    handleAltitudeOverlayStatusChange,
    handleItineraryRouteStatusChange,
    handleWeatherOverlayReloadChange,
    handleWindOverlayReloadChange,
    handleShadowOverlayReloadChange,
    handleSunlightMapOverlayReloadChange,
  };
}
