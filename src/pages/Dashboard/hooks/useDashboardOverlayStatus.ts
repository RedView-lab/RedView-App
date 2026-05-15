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
  handleSlopeOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleAltitudeOverlayStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleItineraryRouteStatusChange: (status: OverlayStatusSnapshot | null) => void;
  handleWeatherOverlayReloadChange: (reload: (() => void) | null) => void;
  handleWindOverlayReloadChange: (reload: (() => void) | null) => void;
  handleShadowOverlayReloadChange: (reload: (() => void) | null) => void;
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
    const orderedIds: OverlayStatusId[] = ['itinerary', 'shadow', 'map', 'altitude', 'slope', 'weather', 'wind'];
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

  return {
    visibleStatuses,
    handleOverlayReload,
    handleMapLoadStatusChange,
    handleMapReloadChange,
    handleWeatherOverlayStatusChange: (status) => setOverlayStatus('weather', status),
    handleWindOverlayStatusChange: (status) => setOverlayStatus('wind', status),
    handleShadowOverlayStatusChange: (status) => setOverlayStatus('shadow', status),
    handleSlopeOverlayStatusChange: (status) => setOverlayStatus('slope', status),
    handleAltitudeOverlayStatusChange: (status) => setOverlayStatus('altitude', status),
    handleItineraryRouteStatusChange: (status) => setOverlayStatus('itinerary', status),
    handleWeatherOverlayReloadChange: (reload) => setOverlayReloader('weather', reload),
    handleWindOverlayReloadChange: (reload) => setOverlayReloader('wind', reload),
    handleShadowOverlayReloadChange: (reload) => setOverlayReloader('shadow', reload),
  };
}
