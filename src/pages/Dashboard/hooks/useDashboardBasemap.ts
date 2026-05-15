import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_BASEMAP_ID,
  getBasemapConfig,
  normalizeBasemapId,
  type BasemapId,
  type BasemapRenderConfig,
} from '@/features/controlPanel';
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
