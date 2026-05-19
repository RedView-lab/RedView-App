import { Section } from '../components/Section';
import { useAppI18n } from '@/shared/i18n';
import { Select } from '../components/Select';
import { IconEye, IconMap } from '../icons';
import type { ControlPanelHandlers, ControlPanelState } from '../types';

interface Props {
  basemaps: ControlPanelState['basemaps'];
  basemap3dQuality: ControlPanelState['basemap3dQuality'];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onBasemapToggle: ControlPanelHandlers['onBasemapToggle'];
  onBasemap3dQualityChange?: ControlPanelHandlers['onBasemap3dQualityChange'];
  onBasemapAdd: ControlPanelHandlers['onBasemapAdd'];
}

export function BasemapsSection({
  basemaps,
  basemap3dQuality,
  open,
  onOpenChange,
  onBasemapToggle,
  onBasemap3dQualityChange,
}: Props) {
  const { t } = useAppI18n();

  return (
    <Section
      title="Fonds de carte"
      icon={<IconMap size={16} />}
      noTopBorder
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="rvc-basemaps__list">
        {basemaps.map((bm) => (
          <button
            type="button"
            key={bm.id}
            className={`rvc-basemaps__row${bm.active ? ' is-active' : ''}`}
            onClick={() => onBasemapToggle?.(bm.id)}
            aria-pressed={bm.active}
          >
            <img
              className="rvc-basemaps__preview"
              src="/control-panel/basemap-preview.svg"
              alt=""
              width="16"
              height="16"
            />
            <span className="rvc-basemaps__label">
              <span>{t(bm.label)}</span>
            </span>
            {bm.active ? <IconEye size={16} className="rvc-basemaps__eye" /> : null}
          </button>
        ))}
      </div>

      <div className="rvc-basemaps__quality-row">
        <span className="rvc-basemaps__quality-label">{t('Qualité 3D')}</span>
        <Select
          width={140}
          value={basemap3dQuality.value}
          options={basemap3dQuality.options}
          onChange={(value) => onBasemap3dQualityChange?.(value)}
          className="rvc-basemaps__quality-select"
        />
      </div>
    </Section>
  );
}
