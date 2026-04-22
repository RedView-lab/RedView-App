import { Section } from '../components/Section';
import { VisibilityButton } from '../components/VisibilityButton';
import { IconMap } from '../icons';
import type { ControlPanelHandlers, ControlPanelState } from '../types';

interface Props {
  basemaps: ControlPanelState['basemaps'];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onBasemapToggle: ControlPanelHandlers['onBasemapToggle'];
  onBasemapAdd: ControlPanelHandlers['onBasemapAdd'];
}

export function BasemapsSection({ basemaps, open, onOpenChange, onBasemapToggle }: Props) {
  return (
    <Section
      title="Fonds de carte"
      icon={<IconMap size={12} />}
      noTopBorder
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-basemaps__list">
        {basemaps.map((bm) => (
          <div
            key={bm.id}
            className={`rvc-basemaps__row${bm.active ? ' is-active' : ''}`}
          >
            <VisibilityButton
              visible={bm.visible}
              onChange={() => onBasemapToggle?.(bm.id)}
              variant="chipActive"
            />
            <div className={`rvc-basemaps__label${bm.active ? '' : ' is-dim'}`}>
              <IconMap size={12} />
              <span>{bm.label}</span>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
