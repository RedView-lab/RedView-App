import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';

import { loadLabelState } from '@/features/labels/lib/label-persist';
import { useLabels } from '@/features/labels/hooks/useLabels';
import type { LabelCategory } from '@/features/labels/types';

import type { ControlPanelPersistedState } from '../../lib/persistedState';
import type { LabelKey, LabelsState } from '../../types';

const PANEL_TO_BACKEND_LABEL: Record<LabelKey, LabelCategory> = {
  poiLabels: 'poi',
  roads: 'roads',
  cities: 'places',
  states: 'states',
  naturalParks: 'naturalParks',
  countries: 'countries',
  waterBody: 'waterBody',
};

export interface UseOverlayLabelsStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
}

/**
 * Hook dédié à la gestion des étiquettes et toponymie (POI, routes, villes, pays, parcs).
 */
export function useOverlayLabelsState({
  map,
  isMapLoaded,
  initialControlPanel,
  updateProjectControlPanel,
}: UseOverlayLabelsStateArgs) {
  const [labelBackend, setLabelBackend] = useState<Record<LabelCategory, boolean>>(
    () => initialControlPanel.labelsState?.backend ?? loadLabelState(),
  );
  const [labelsEnabled, setLabelsEnabled] = useState(initialControlPanel.toggles.labelsEnabled);

  const effectiveLabelState = useMemo(() => {
    if (labelsEnabled) return labelBackend;
    const next = { ...labelBackend };
    for (const key of Object.keys(next) as LabelCategory[]) next[key] = false;
    return next;
  }, [labelBackend, labelsEnabled]);

  useLabels(map, isMapLoaded, effectiveLabelState, labelsEnabled);

  const persistLabelsToProject = useCallback(
    (
      nextEnabled: boolean = labelsEnabled,
      nextBackend: typeof labelBackend = labelBackend,
    ) => {
      updateProjectControlPanel((draft) => {
        draft.toggles.labelsEnabled = nextEnabled;
        draft.labelsState = {
          backend: structuredClone(nextBackend),
          statesUiEnabled: nextBackend.states,
        };
      });
    },
    [labelBackend, labelsEnabled, updateProjectControlPanel],
  );

  useEffect(() => {
    updateProjectControlPanel((draft) => {
      draft.toggles.labelsEnabled = labelsEnabled;
      draft.labelsState = {
        backend: structuredClone(labelBackend),
        statesUiEnabled: labelBackend.states,
      };
    });
  }, [labelBackend, labelsEnabled, updateProjectControlPanel]);

  const labelsSlice = useMemo(
    () => ({
      enabled: labelsEnabled,
      state: {
        poiLabels: labelBackend.poi,
        roads: labelBackend.roads,
        cities: labelBackend.places,
        states: labelBackend.states,
        naturalParks: labelBackend.naturalParks,
        countries: labelBackend.countries,
        waterBody: labelBackend.waterBody,
      } as LabelsState,
    }),
    [labelBackend, labelsEnabled],
  );

  const handlers = {
    onLabelsEnabledChange: useCallback(
      (enabled: boolean) => {
        setLabelsEnabled(enabled);
        persistLabelsToProject(enabled);
      },
      [persistLabelsToProject],
    ),
    onLabelToggle: useCallback(
      (key: LabelKey, checked: boolean) => {
        const backendKey = PANEL_TO_BACKEND_LABEL[key];
        if (!backendKey) return;

        setLabelBackend((prev) => {
          const next = { ...prev, [backendKey]: checked };
          persistLabelsToProject(labelsEnabled, next);
          return next;
        });
      },
      [labelsEnabled, persistLabelsToProject],
    ),
  };

  return { labelsSlice, handlers };
}
