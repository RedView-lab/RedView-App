import { useCallback, useEffect, useMemo, useState } from 'react';
// Module précis, pas le barrel controlPanel : le shell du Dashboard ne doit
// pas tirer les panneaux de l'éditeur (scripts/quality/check-bundle.mjs).
import {
  DEFAULT_BASEMAP_ID,
  getBasemapConfig,
  normalizeBasemapId,
  type BasemapRenderConfig,
} from '@/features/controlPanel/lib/basemaps';
import type { BasemapId } from '@/features/controlPanel/types';
import type { ItineraryProject } from '@/features/itineraryPanel/types';

interface UseDashboardBasemapArgs {
  activeProjectId: string | null;
  activeProjectInitial: ItineraryProject | null;
}

interface SelectedBasemapState {
  projectId: string | null;
  basemapId: BasemapId;
}

interface UseDashboardBasemapResult {
  activeBasemapConfig: BasemapRenderConfig;
  handleBasemapChange: (id: BasemapId) => void;
}

export function useDashboardBasemap({
  activeProjectId,
  activeProjectInitial,
}: UseDashboardBasemapArgs): UseDashboardBasemapResult {
  const [selectedBasemap, setSelectedBasemap] = useState<SelectedBasemapState>({
    projectId: null,
    basemapId: DEFAULT_BASEMAP_ID,
  });

  const initialBasemapId = normalizeBasemapId(
    activeProjectInitial?.controlPanel?.basemapId ?? DEFAULT_BASEMAP_ID,
  );

  const effectiveBasemapId =
    activeProjectId != null && selectedBasemap.projectId !== activeProjectId
      ? initialBasemapId
      : selectedBasemap.basemapId;

  const activeBasemapConfig = useMemo(
    () => getBasemapConfig(effectiveBasemapId),
    [effectiveBasemapId],
  );

  useEffect(() => {
    setSelectedBasemap({
      projectId: activeProjectId,
      basemapId: initialBasemapId,
    });
  }, [activeProjectId, initialBasemapId]);

  const handleBasemapChange = useCallback((id: BasemapId) => {
    setSelectedBasemap({
      projectId: activeProjectId,
      basemapId: normalizeBasemapId(id),
    });
  }, [activeProjectId]);

  return {
    activeBasemapConfig,
    handleBasemapChange,
  };
}
