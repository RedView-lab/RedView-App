import { useEffect, useState } from 'react';

interface SliderProps {
  /** 0..100 */
  value: number;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  width?: number | string;
  min?: number;
  max?: number;
}

export function Slider({ value, onChange, onCommit, width = 100, min = 0, max = 100 }: SliderProps) {
  const [draftValue, setDraftValue] = useState(value);
  const [interacting, setInteracting] = useState(false);

  useEffect(() => {
    if (!interacting) {
      setDraftValue(value);
    }
  }, [interacting, value]);

  const clampedValue = Math.max(min, Math.min(max, draftValue));
  const pct = Math.max(0, Math.min(100, ((clampedValue - min) / (max - min)) * 100));
  // Handle is 16px wide. Compensate so it stays fully inside the container at
  // both extremes: at pct=0 → left:0, at pct=100 → left:calc(100% - 16px).
  // Fill ends at the handle center so visual feedback stays aligned.
  const handleShift = (pct / 100) * 16;

  const commit = (nextValue: number) => {
    setInteracting(false);
    onCommit?.(nextValue);
  };

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
        value={clampedValue}
        onPointerDown={() => setInteracting(true)}
        onChange={(e) => {
          const nextValue = Number(e.target.value);
          setDraftValue(nextValue);
          onChange?.(nextValue);
        }}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onBlur={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
            commit(Number(e.currentTarget.value));
          }
        }}
      />
    </div>
  );
}
