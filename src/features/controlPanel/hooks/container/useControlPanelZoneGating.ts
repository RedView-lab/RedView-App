import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useAnalysisZone,
  analysisZoneBBox,
  analysisZoneRingPayload,
  hashAnalysisZone,
  isValidAnalysisZone,
} from '@/features/analysisZone';

interface UseControlPanelZoneGatingArgs {
  onSlopesEnabledChange: (enabled: boolean) => void;
  onAltitudeEnabledChange: (enabled: boolean) => void;
  slopesEnabled: boolean;
  altitudeEnabled: boolean;
}

/**
 * Gère le verrouillage/déverrouillage des fonctionnalités dépendantes de la zone d'analyse
 * (Pentes, Altitude).
 */
export function useControlPanelZoneGating({
  onSlopesEnabledChange,
  onAltitudeEnabledChange,
  slopesEnabled,
  altitudeEnabled,
}: UseControlPanelZoneGatingArgs) {
  const analysisZoneContext = useAnalysisZone();
  const analysisZone = analysisZoneContext?.zone ?? null;

  const analysisZonePayload = useMemo(() => {
    if (!isValidAnalysisZone(analysisZone)) return null;
    return {
      key: hashAnalysisZone(analysisZone),
      bounds: analysisZoneBBox(analysisZone),
      ring: analysisZoneRingPayload(analysisZone),
    } as const;
  }, [analysisZone]);
  const analysisZoneActive = analysisZonePayload != null;

  const handleSlopesEnabledChange = useCallback(
    (enabled: boolean) => {
      if (enabled && !analysisZoneActive) {
        analysisZoneContext?.requestZoneForWidget('slope');
        return;
      }
      onSlopesEnabledChange(enabled);
    },
    [analysisZoneActive, analysisZoneContext, onSlopesEnabledChange],
  );

  const handleAltitudeEnabledChange = useCallback(
    (enabled: boolean) => {
      if (enabled && !analysisZoneActive) {
        analysisZoneContext?.requestZoneForWidget('altitude');
        return;
      }
      onAltitudeEnabledChange(enabled);
    },
    [analysisZoneActive, analysisZoneContext, onAltitudeEnabledChange],
  );

  const prevAnalysisZoneActiveRef = useRef(analysisZoneActive);
  useEffect(() => {
    const wasActive = prevAnalysisZoneActiveRef.current;
    prevAnalysisZoneActiveRef.current = analysisZoneActive;
    if (wasActive === analysisZoneActive) return;

    if (analysisZoneActive) {
      const pending = analysisZoneContext?.takePendingWidgetActivations() ?? [];
      for (const widget of pending) {
        if (widget === 'slope') onSlopesEnabledChange(true);
        if (widget === 'altitude') onAltitudeEnabledChange(true);
      }
      return;
    }

    if (slopesEnabled) onSlopesEnabledChange(false);
    if (altitudeEnabled) onAltitudeEnabledChange(false);
  }, [
    analysisZoneActive,
    analysisZoneContext,
    altitudeEnabled,
    onAltitudeEnabledChange,
    onSlopesEnabledChange,
    slopesEnabled,
  ]);

  return {
    analysisZonePayload,
    analysisZoneActive,
    handleSlopesEnabledChange,
    handleAltitudeEnabledChange,
  };
}
