import { useState } from 'react';
import { ColorPalettePicker } from '../components/ColorPalettePicker';
import { ColorSwatch } from '../components/ColorSwatch';
import { Section } from '../components/Section';
import { Select } from '../components/Select';
import { Slider } from '../components/Slider';
import { IconChevronDown, IconEye, IconEyeOff } from '../icons';

type AltitudeResolution = '0.40 m (LIDAR)' | '1 m' | '5 m' | '10 m';
type AltitudeColorization = 'Dégradé' | 'Remplissage';
type AltitudeScaleSetting = '2 couleurs' | '3 couleurs' | '4 couleurs' | '6 couleurs';

interface AltitudeBand {
  id: string;
  label: string;
  color: string;
  visible: boolean;
}

const RESOLUTION_OPTIONS: { value: AltitudeResolution; label: string }[] = [
  { value: '0.40 m (LIDAR)', label: '0.40 m (LIDAR)' },
  { value: '1 m', label: '1 m' },
  { value: '5 m', label: '5 m' },
  { value: '10 m', label: '10 m' },
];

const COLORIZATION_OPTIONS: { value: AltitudeColorization; label: string }[] = [
  { value: 'Dégradé', label: 'Dégradé' },
  { value: 'Remplissage', label: 'Remplissage' },
];

const SCALE_OPTIONS: { value: AltitudeScaleSetting; label: string }[] = [
  { value: '2 couleurs', label: '2 couleurs' },
  { value: '3 couleurs', label: '3 couleurs' },
  { value: '4 couleurs', label: '4 couleurs' },
  { value: '6 couleurs', label: '6 couleurs' },
];

const DEFAULT_BANDS: AltitudeBand[] = [
  { id: 'altitude-band-0', label: '0 m', color: '#2DBF8C', visible: true },
  { id: 'altitude-band-1000', label: '1000 m', color: '#FFD800', visible: true },
  { id: 'altitude-band-2000', label: '2000 m', color: '#FF7200', visible: true },
  { id: 'altitude-band-3000', label: '3000 m', color: '#FF0000', visible: true },
];

function hexLabel(color: string): string {
  return color.replace('#', '').toUpperCase();
}

function AltitudeBandRow({
  band,
  onToggleVisibility,
  onColorChange,
}: {
  band: AltitudeBand;
  onToggleVisibility: () => void;
  onColorChange: (color: string) => void;
}) {
  return (
    <div className={`rvc-altitude__band-row${band.visible ? '' : ' is-hidden'}`}>
      <button
        type="button"
        className="rvc-icon-btn rvc-icon-btn--ghost rvc-altitude__band-eye"
        onClick={onToggleVisibility}
        aria-label={band.visible ? 'Masquer le niveau' : 'Afficher le niveau'}
      >
        {band.visible ? <IconEye size={12} /> : <IconEyeOff size={12} />}
      </button>

      <span className="rvc-altitude__band-label">{band.label}</span>

      <ColorPalettePicker
        color={band.color}
        onChange={onColorChange}
        className="rvc-altitude__color-chip"
        ariaLabel={`Choisir la couleur du niveau ${band.label}`}
      >
        <ColorSwatch color={band.color} size={12} />
        <span className="rvc-altitude__color-hex">{hexLabel(band.color)}</span>
        <IconChevronDown size={20} className="rvc-altitude__color-chevron" />
      </ColorPalettePicker>
    </div>
  );
}

export function AltitudeSection() {
  const [enabled, setEnabled] = useState(true);
  const [resolution, setResolution] = useState<AltitudeResolution>('0.40 m (LIDAR)');
  const [colorization, setColorization] = useState<AltitudeColorization>('Dégradé');
  const [opacity, setOpacity] = useState(20);
  const [scale, setScale] = useState<AltitudeScaleSetting>('4 couleurs');
  const [bands, setBands] = useState<AltitudeBand[]>(DEFAULT_BANDS);

  return (
    <Section
      title="Altitude"
      toggle={{ checked: enabled, onChange: setEnabled }}
    >
      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Résolution</span>
        <Select
          width={140}
          value={resolution}
          options={RESOLUTION_OPTIONS}
          onChange={(value) => setResolution(value as AltitudeResolution)}
        />
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Type de colorisation</span>
        <Select
          width={140}
          value={colorization}
          options={COLORIZATION_OPTIONS}
          onChange={(value) => setColorization(value as AltitudeColorization)}
        />
      </div>

      <div className="rvc-row rvc-row--split rvc-altitude__opacity-row">
        <span className="rvc-row__label">Opacité</span>
        <div className="rvc-altitude__opacity-control">
          <div className="rvc-altitude__opacity-slider-wrap">
            <Slider value={opacity} onChange={setOpacity} width="100%" />
          </div>
          <span className="rvc-altitude__opacity-value">{opacity} %</span>
        </div>
      </div>

      <div className="rvc-row rvc-row--split">
        <span className="rvc-row__label">Échelle</span>
        <Select
          width={140}
          value={scale}
          options={SCALE_OPTIONS}
          onChange={(value) => setScale(value as AltitudeScaleSetting)}
        />
      </div>

      <div className="rvc-altitude__bands">
        {bands.map((band) => (
          <AltitudeBandRow
            key={band.id}
            band={band}
            onToggleVisibility={() => {
              setBands((currentBands) =>
                currentBands.map((entry) =>
                  entry.id === band.id ? { ...entry, visible: !entry.visible } : entry,
                ),
              );
            }}
            onColorChange={(color) => {
              setBands((currentBands) =>
                currentBands.map((entry) =>
                  entry.id === band.id ? { ...entry, color } : entry,
                ),
              );
            }}
          />
        ))}
      </div>
    </Section>
  );
}