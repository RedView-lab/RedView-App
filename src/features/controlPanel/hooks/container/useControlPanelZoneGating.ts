import { useCallback } from 'react';

interface UseControlPanelZoneGatingArgs {
  onSlopesEnabledChange: (enabled: boolean) => void;
  onAltitudeEnabledChange: (enabled: boolean) => void;
  altitudeEnabled?: boolean;
}

export function useControlPanelZoneGating({
  onSlopesEnabledChange,
  onAltitudeEnabledChange,
}: UseControlPanelZoneGatingArgs) {
  const handleSlopesEnabledChange = useCallback(
    (enabled: boolean) => {
      onSlopesEnabledChange(enabled);
    },
    [onSlopesEnabledChange],
  );

  const handleAltitudeEnabledChange = useCallback(
    (enabled: boolean) => {
      onAltitudeEnabledChange(enabled);
    },
    [onAltitudeEnabledChange],
  );

  return {
    analysisZonePayload: null,
    analysisZoneActive: false,
    handleSlopesEnabledChange,
    handleAltitudeEnabledChange,
  };
}
