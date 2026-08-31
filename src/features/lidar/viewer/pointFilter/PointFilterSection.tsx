import { Section } from '@/features/controlPanel/components/Section';
import { Checkbox } from '@/features/controlPanel/components/Checkbox';
import { SvgV2Icon } from '@/shared/components/SvgV2Icon';
import {
  POINT_FILTER_CATEGORIES,
  POINT_FILTER_COLUMN_A,
  POINT_FILTER_COLUMN_B,
} from './config';
import type { PointFilterCategoryId, ViewerPointFilterState } from './types';

interface PointFilterSectionProps {
  state: ViewerPointFilterState;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEnabledChange: (enabled: boolean) => void;
  onCategoryToggle: (categoryId: PointFilterCategoryId, visible: boolean) => void;
}

export function PointFilterSection({
  state,
  open,
  onOpenChange,
  onEnabledChange,
  onCategoryToggle,
}: PointFilterSectionProps) {
  const categoryMap = new Map(POINT_FILTER_CATEGORIES.map((c) => [c.id, c]));

  return (
    <Section
      title="Filtrage des points"
      icon={<SvgV2Icon name="layers-three-02.svg" size={16} />}
      toggle={{ checked: state.enabled, onChange: onEnabledChange }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div
        className="rvc-labels__grid"
        style={{ opacity: state.enabled ? 1 : 0.45, pointerEvents: state.enabled ? 'auto' : 'none' }}
      >
        <div className="rvc-labels__col">
          {POINT_FILTER_COLUMN_A.map((id) => {
            const cat = categoryMap.get(id);
            if (!cat) return null;
            return (
              <Checkbox
                key={id}
                id={`pt-flt-${id}`}
                checked={state.enabled && (state.categories[id] ?? true)}
                onChange={(v) => onCategoryToggle(id, v)}
                label={cat.label}
              />
            );
          })}
        </div>
        <div className="rvc-labels__col">
          {POINT_FILTER_COLUMN_B.map((id) => {
            const cat = categoryMap.get(id);
            if (!cat) return null;
            return (
              <Checkbox
                key={id}
                id={`pt-flt-${id}`}
                checked={state.enabled && (state.categories[id] ?? true)}
                onChange={(v) => onCategoryToggle(id, v)}
                label={cat.label}
              />
            );
          })}
        </div>
      </div>
    </Section>
  );
}
