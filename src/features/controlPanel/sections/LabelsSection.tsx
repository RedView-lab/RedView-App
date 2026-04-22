import { Section } from '../components/Section';
import { Checkbox } from '../components/Checkbox';
import type { ControlPanelHandlers, ControlPanelState, LabelKey } from '../types';

interface Props {
  enabled: boolean;
  state: ControlPanelState['labels']['state'];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: ControlPanelHandlers['onLabelsEnabledChange'];
  onLabelToggle: ControlPanelHandlers['onLabelToggle'];
}

const COLUMN_A: { key: LabelKey; label: string }[] = [
  { key: 'poiLabels', label: 'POI Labels' },
  { key: 'roads', label: 'Roads' },
  { key: 'cities', label: 'Cities' },
  { key: 'states', label: 'States' },
];

const COLUMN_B: { key: LabelKey; label: string }[] = [
  { key: 'naturalParks', label: 'Natural Parks' },
  { key: 'countries', label: 'Countries' },
  { key: 'waterBody', label: 'Water body' },
];

export function LabelsSection({
  enabled,
  state,
  open,
  onOpenChange,
  onEnabledChange,
  onLabelToggle,
}: Props) {
  return (
    <Section
      title="Étiquettes"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div
        className="rvc-labels__grid"
        style={{ opacity: enabled ? 1 : 0.45, pointerEvents: enabled ? 'auto' : 'none' }}
      >
        <div className="rvc-labels__col">
          {COLUMN_A.map(({ key, label }) => (
            <Checkbox
              key={key}
              id={`lbl-${key}`}
              checked={enabled && state[key]}
              onChange={(v) => onLabelToggle?.(key, v)}
              label={label}
            />
          ))}
        </div>
        <div className="rvc-labels__col">
          {COLUMN_B.map(({ key, label }) => (
            <Checkbox
              key={key}
              id={`lbl-${key}`}
              checked={enabled && state[key]}
              onChange={(v) => onLabelToggle?.(key, v)}
              label={label}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}
