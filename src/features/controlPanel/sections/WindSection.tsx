import { Section } from '../components/Section';

interface Props {
  enabled: boolean;
  onEnabledChange?: (v: boolean) => void;
}

/**
 * Wind legend identical in layout to the slope bands: each row is
 * eye | swatch+hex | m/s range — rendered with the same grid so every
 * column aligns vertically with the Pentes section.
 */
const WIND_BANDS: { id: string; label: string; range: string; color: string }[] = [
  { id: 'w0',  label: 'Calme',       range: '0 - 3 m/s',   color: '#4085F5' },
  { id: 'w3',  label: 'Léger',       range: '3 - 6 m/s',   color: '#1ABFD9' },
  { id: 'w6',  label: 'Modéré',      range: '6 - 10 m/s',  color: '#0DD959' },
  { id: 'w10', label: 'Assez fort',  range: '10 - 15 m/s', color: '#B3EB1A' },
  { id: 'w15', label: 'Fort',        range: '15 - 20 m/s', color: '#FACC0D' },
  { id: 'w20', label: 'Violent',     range: '20 - 30 m/s', color: '#FA730D' },
  { id: 'w30', label: 'Tempête',     range: '30+ m/s',     color: '#E6261F' },
];

export function WindSection({ enabled, onEnabledChange }: Props) {
  return (
    <Section
      title="Vent"
      toggle={{ checked: enabled, onChange: onEnabledChange }}
    >
      <div className="rvc-slopes__bands" aria-hidden={!enabled}>
        {WIND_BANDS.map((b) => (
          <div
            key={b.id}
            className={`rvc-slopes__band${enabled ? '' : ' is-hidden'}`}
            title={`${b.label} · ${b.range}`}
          >
            <span aria-hidden className="rvc-slopes__band-eye" />
            <span className="rvc-slopes__band-swatch">
              <span
                className="rvc-swatch"
                style={{ backgroundColor: b.color, width: 10, height: 10 }}
              />
              <span>{b.color.replace('#', '').slice(0, 3).toUpperCase()}</span>
            </span>
            <span className="rvc-slopes__band-pct">{b.range}</span>
            <span className="rvc-slopes__band-deg">{b.label}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
