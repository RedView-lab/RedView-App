import { useCallback, useMemo, useRef, useState } from 'react';
import {
  createOverlayStatus,
  type OverlayStatusId,
  type OverlayStatusSnapshot,
} from '@/features/map3d';

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

  const setOverlayStatus = useCallback((id: OverlayStatusId, status: OverlayStatusSnapshot | null) => {
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
  }, []);

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
    setMapStatus(status);
  }, []);

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
          detail: 'Carte prête',
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
      .filter((status): status is OverlayStatusSnapshot => Boolean(status));
  }, [mapStatus, overlayStatuses]);

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
