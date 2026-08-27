import type { Map as MapboxMap } from 'mapbox-gl';
import type { OverlayStatusReporter } from '@/features/map3d';

import type { ControlPanelPersistedState } from '../lib/persistedState';
import type {
  AltitudeColorization,
  AltitudeScaleSetting,
  BasemapId,
  ContourIntervalSetting,
  ControlPanelState,
  SlopeColorization,
  SlopeResolution,
  SlopeScale,
  SlopeScaleSetting,
} from '../types';

import { useTerrainSlopeState } from './terrain/useTerrainSlopeState';
import { useTerrainAltitudeState } from './terrain/useTerrainAltitudeState';
import { useTerrainContourState } from './terrain/useTerrainContourState';

export interface UseControlPanelTerrainStateArgs {
  map: MapboxMap | null;
  isMapLoaded: boolean;
  activeBasemapId: BasemapId;
  initialControlPanel: ControlPanelPersistedState;
  updateProjectControlPanel: (mut: (draft: ControlPanelPersistedState) => void) => void;
  /**
   * Analysis zone (slope + altitude are zone-gated widgets): null while no
   * polygon is drawn → the overlays stay unmounted.
   */
  analysisZone: {
    key: string;
    bounds: [number, number, number, number];
    ring: number[];
  } | null;
  onSlopeOverlayStatusChange?: OverlayStatusReporter;
  onAltitudeOverlayStatusChange?: OverlayStatusReporter;
}

export interface TerrainHandlers {
  onContourLinesEnabledChange: (enabled: boolean) => void;
  onContourLinesIntervalChange: (value: ContourIntervalSetting) => void;
  onContourLinesOpacityChange: (value: number) => void;
  onAltitudeEnabledChange: (enabled: boolean) => void;
  onAltitudeColorizationChange: (value: AltitudeColorization) => void;
  onAltitudeScaleSettingChange: (value: AltitudeScaleSetting) => void;
  onAltitudeOpacityChange: (value: number) => void;
  onAltitudeBandColorChange: (id: string, color: string) => void;
  onAltitudeBandVisibilityToggle: (id: string) => void;
  onAltitudeBandBreakpointChange: (bandIndex: number, field: 'min' | 'max', valueMeters: number) => void;
  onSlopesEnabledChange: (enabled: boolean) => void;
  onSlopeResolutionChange: (value: SlopeResolution) => void;
  onSlopeColorizationChange: (value: SlopeColorization) => void;
  onSlopeScaleChange: (value: SlopeScale) => void;
  onSlopeScaleSettingChange: (value: SlopeScaleSetting) => void;
  onSlopeOpacityChange: (value: number) => void;
  onSlopeBandColorChange: (id: string, color: string) => void;
  onSlopeBandVisibilityToggle: (id: string) => void;
  onSlopeBandBreakpointChange: (bandIndex: number, field: 'min' | 'max', valueDeg: number) => void;
}

export interface TerrainStateResult {
  slices: Pick<ControlPanelState, 'contourLines' | 'slopes' | 'altitude'>;
  handlers: TerrainHandlers;
}

/**
 * Hook orchestrateur pour la gestion globale des couches et paramètres de relief (Terrain)
 * dans le Control Panel (Pentes, Altitude, Courbes de niveau).
 */
export function useControlPanelTerrainState({
  map,
  isMapLoaded,
  activeBasemapId,
  initialControlPanel,
  updateProjectControlPanel,
  analysisZone,
  onSlopeOverlayStatusChange,
  onAltitudeOverlayStatusChange,
}: UseControlPanelTerrainStateArgs): TerrainStateResult {
  const { contourLinesSlice, handlers: contourHandlers } = useTerrainContourState({
    map,
    isMapLoaded,
    activeBasemapId,
    initialControlPanel,
    updateProjectControlPanel,
  });

  const { slopesSlice, handlers: slopeHandlers } = useTerrainSlopeState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
    analysisZone,
    onSlopeOverlayStatusChange,
  });

  const { altitudeSlice, handlers: altitudeHandlers } = useTerrainAltitudeState({
    map,
    isMapLoaded,
    initialControlPanel,
    updateProjectControlPanel,
    analysisZone,
    onAltitudeOverlayStatusChange,
  });

  return {
    slices: {
      contourLines: contourLinesSlice,
      slopes: slopesSlice,
      altitude: altitudeSlice,
    },
    handlers: {
      ...contourHandlers,
      ...altitudeHandlers,
      ...slopeHandlers,
    },
  };
}
