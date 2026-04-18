/**
 * Analysis toolbar — line of controls between the synthesis table and the
 * profile chart. Figma 1528:18495.
 *
 *   Analyse | [Distance|Temps] | Axe1[Dénivelé▼] Axe2[Tempé▼] | Détail [-=+]
 *      | divider | [✓Waypoint] [✓POI] [✓Pause] [✓Alertes] [✓Pente] [✓Jour/nuit]
 */
import type { ReactNode } from 'react';

import { Checkbox, Segmented, Select, Slider } from '../../components/primitives';
import {
  IconAlertTriangle,
  IconDayNight,
  IconPause,
  IconPoiPin,
  IconSlope,
  IconWaypointMarker,
} from '../../components/icons';
import {
  OVERLAY_LABELS,
  PRIMARY_METRIC_OPTIONS,
  SECONDARY_METRIC_OPTIONS,
} from '../../defaultState';
import type {
  AnalysisAxisX,
  AnalysisAxisYMetric,
  CentralPanelUiState,
  ChartOverlay,
} from '../../types';

const AXIS1_OPTIONS = [
  { value: 'distance' as const, label: 'Distance' },
  { value: 'time' as const, label: 'Temps' },
];

const OVERLAY_ICONS: Record<ChartOverlay, ReactNode> = {
  waypoint: <IconWaypointMarker size={20} />,
  poi: <IconPoiPin size={20} />,
  pause: <IconPause size={20} />,
  alerts: <IconAlertTriangle size={20} />,
  slope: <IconSlope size={20} />,
  daynight: <IconDayNight size={20} />,
};

const OVERLAY_ORDER: ChartOverlay[] = [
  'waypoint',
  'poi',
  'pause',
  'alerts',
  'slope',
  'daynight',
];

interface AnalysisToolbarProps {
  ui: CentralPanelUiState;
  onChangeAxis1?: (next: AnalysisAxisX) => void;
  onChangePrimaryMetric?: (next: AnalysisAxisYMetric) => void;
  onChangeSecondaryMetric?: (next: AnalysisAxisYMetric) => void;
  onChangeDetail?: (value: number) => void;
  onToggleOverlay?: (overlay: ChartOverlay, enabled: boolean) => void;
}

export function AnalysisToolbar({
  ui,
  onChangeAxis1,
  onChangePrimaryMetric,
  onChangeSecondaryMetric,
  onChangeDetail,
  onToggleOverlay,
}: AnalysisToolbarProps) {
  return (
    <section className="rvc-toolbar" aria-label="Outils d'analyse">
      <div className="rvc-toolbar__group rvc-toolbar__group--left">
        <span className="rvc-toolbar__title">Analyse</span>

        <Segmented
          value={ui.axis1}
          options={AXIS1_OPTIONS}
          onChange={(v) => onChangeAxis1?.(v)}
          ariaLabel="Axe X"
        />

        <span className="rvc-toolbar__axis-tag" aria-hidden>
          <span className="rvc-toolbar__axis-tag-text">Axe 1</span>
          <span className="rvc-toolbar__axis-tag-line" />
        </span>
        <Select
          value={ui.primaryMetric}
          options={PRIMARY_METRIC_OPTIONS}
          onChange={(v) => onChangePrimaryMetric?.(v)}
          ariaLabel="Métrique de l'axe principal"
        />

        <span className="rvc-toolbar__axis-tag" aria-hidden>
          <span className="rvc-toolbar__axis-tag-text">Axe 2</span>
          <span className="rvc-toolbar__axis-tag-line" />
        </span>
        <Select
          value={ui.secondaryMetric}
          options={SECONDARY_METRIC_OPTIONS}
          onChange={(v) => onChangeSecondaryMetric?.(v)}
          ariaLabel="Métrique de l'axe secondaire"
        />

        <div className="rvc-toolbar__detail">
          <span className="rvc-toolbar__detail-label">Détail</span>
          <div className="rvc-toolbar__detail-slider">
            <span className="rvc-toolbar__detail-glyph" aria-hidden>−</span>
            <Slider
              value={ui.detail}
              onChange={(v) => onChangeDetail?.(v)}
              ariaLabel="Niveau de détail"
            />
            <span className="rvc-toolbar__detail-glyph" aria-hidden>+</span>
          </div>
        </div>
      </div>

      <div className="rvc-toolbar__divider" aria-hidden />

      <div className="rvc-toolbar__group rvc-toolbar__group--right">
        {OVERLAY_ORDER.map((overlay) => (
          <Checkbox
            key={overlay}
            checked={ui.overlays[overlay]}
            onChange={(next) => onToggleOverlay?.(overlay, next)}
            icon={OVERLAY_ICONS[overlay]}
            label={OVERLAY_LABELS[overlay]}
            ariaLabel={OVERLAY_LABELS[overlay]}
          />
        ))}
      </div>
    </section>
  );
}
