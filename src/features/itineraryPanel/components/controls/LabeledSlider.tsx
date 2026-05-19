import { useAppI18n } from '@/shared/i18n';

interface LabeledSliderProps {
  label: string;
  /** Current value in [min, max]. */
  value: number;
  onChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

/** Slider row: label | — | track | +. Value range defaults to [0, 100]. */
export function LabeledSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
}: LabeledSliderProps) {
  const { t } = useAppI18n();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="rvi-sfield">
      <span className="rvi-sfield__label" title={t(label)}>
        {t(label)}
      </span>
      <div className="rvi-sfield__control">
        <span className="rvi-sfield__sign">-</span>
        <div className="rvi-slider">
          <div className="rvi-slider__track" />
          <div className="rvi-slider__fill" style={{ width: `${pct}%` }} />
          <div className="rvi-slider__handle" style={{ left: `${pct}%` }} />
          <input
            className="rvi-slider__native"
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange?.(Number(e.target.value))}
            aria-label={t(label)}
          />
        </div>
        <span className="rvi-sfield__sign">+</span>
      </div>
    </div>
  );
}
