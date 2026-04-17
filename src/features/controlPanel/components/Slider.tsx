interface SliderProps {
  /** 0..100 */
  value: number;
  onChange?: (value: number) => void;
  width?: number | string;
  min?: number;
  max?: number;
}

export function Slider({ value, onChange, width = 100, min = 0, max = 100 }: SliderProps) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="rvc-slider" style={{ width }}>
      <div className="rvc-slider__track" />
      <div className="rvc-slider__fill" style={{ width: `${pct}%` }} />
      <div className="rvc-slider__handle" style={{ left: `calc(${pct}% - 8px)` }} />
      <input
        className="rvc-slider__input"
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
      />
    </div>
  );
}
