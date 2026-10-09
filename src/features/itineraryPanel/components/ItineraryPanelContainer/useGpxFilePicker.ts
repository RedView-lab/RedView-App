import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { countBucket, trackAnalyticsEvent } from '../../../../shared/lib/analytics';
import { fitToRoute } from '../../lib/route-layer';
import type { ItineraryProject } from '../../types';
import { notify } from '@/shared/lib/notify';
import { describeGpxImportError, useItineraryGpxImport } from './useItineraryGpxImport';

interface UseGpxFilePickerOptions {
  map: MapboxMap | null;
  /** Largeur du panneau latéral, réservée à gauche lors du cadrage. */
  panelWidth?: number;
  setProjectWithoutHistory: Dispatch<SetStateAction<ItineraryProject>>;
  addItinerary: Parameters<typeof useItineraryGpxImport>[0]['addItinerary'];
  setPendingCorridorFor: Dispatch<SetStateAction<string | null>>;
  onRevealCenterPanel?: () => void;
}

/**
 * Import d'un fichier GPX comme nouvel itinéraire : `<input type="file">`
 * caché, ligne de chargement dans la liste, puis cadrage de la carte sur la
 * trace importée.
 */
export function useGpxFilePicker({
  map,
  panelWidth,
  setProjectWithoutHistory,
  addItinerary,
  setPendingCorridorFor,
  onRevealCenterPanel,
}: UseGpxFilePickerOptions) {
  // Progression de l'import GPX, affichée comme une ligne de chargement dans la liste des itinéraires.
  const [pendingImportName, setPendingImportName] = useState<string | null>(null);
  const gpxInputRef = useRef<HTMLInputElement | null>(null);

  const fitMapToImportedRoute = useCallback(
    (points: [number, number][]) => {
      if (!map || points.length === 0) return;
      try {
        const leftPadding = Math.max(80, (panelWidth ?? 360) + 40);
        fitToRoute(map, points, {
          padding: {
            top: 80,
            bottom: Math.min(270, Math.round(window.innerHeight * 0.35)),
            left: Math.min(leftPadding, Math.round(window.innerWidth * 0.4)),
            right: 80,
          },
          maxZoom: 14,
          duration: 800,
        });
      } catch (error) {
        console.warn('[ItineraryPanelContainer] fitToRoute after GPX import failed', error);
      }
    },
    [map, panelWidth],
  );

  const { addItineraryFromGpxFile } = useItineraryGpxImport({
    setProject: setProjectWithoutHistory,
    addItinerary,
    setPendingCorridorFor,
    onImportStateChange: setPendingImportName,
    onItineraryImported: (_id, points) => {
      trackAnalyticsEvent({ name: 'gpx_imported', data: { format: 'gpx', points: countBucket(points.length) } });
      fitMapToImportedRoute(points);
      onRevealCenterPanel?.();
    },
  });

  const handleGpxFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.gpx')) {
        notify.error('Ce fichier n’est pas un GPX : choisissez un fichier .gpx.');
        return;
      }
      try {
        await addItineraryFromGpxFile(file);
      } catch (err) {
        console.warn('[ItineraryPanelContainer] GPX import failed', err);
        notify.error(describeGpxImportError(err));
      }
    },
    [addItineraryFromGpxFile],
  );

  const openGpxPicker = useCallback(() => {
    gpxInputRef.current?.click();
  }, []);

  return {
    gpxInputRef,
    pendingImportName,
    addItineraryFromGpxFile,
    handleGpxFileChange,
    openGpxPicker,
  };
}
