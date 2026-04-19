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
  // Handle is 16px wide. Compensate so it stays fully inside the container at
  // both extremes: at pct=0 → left:0, at pct=100 → left:calc(100% - 16px).
  // Fill ends at the handle center so visual feedback stays aligned.
  const handleShift = (pct / 100) * 16;
  return (
    <div className="rvc-slider" style={{ width }}>
      <div className="rvc-slider__track" />
      <div
        className="rvc-slider__fill"
        style={{ width: `calc(${pct}% - ${handleShift - 8}px)` }}
      />
      <div
        className="rvc-slider__handle"
        style={{ left: `calc(${pct}% - ${handleShift}px)` }}
      />
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
