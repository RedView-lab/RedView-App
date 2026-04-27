import { useEffect, useState } from 'react';

interface SliderProps {
  /** 0..100 */
  value: number;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  width?: number | string;
  min?: number;
  max?: number;
  step?: number;
  handleSize?: number;
  trackHeight?: number;
}

export function Slider({
  value,
  onChange,
  onCommit,
  width = 100,
  min = 0,
  max = 100,
  step = 1,
  handleSize = 16,
  trackHeight = 8,
}: SliderProps) {
  const [draftValue, setDraftValue] = useState(value);
  const [interacting, setInteracting] = useState(false);

  useEffect(() => {
    if (!interacting) {
      setDraftValue(value);
    }
  }, [interacting, value]);

  const clampedValue = Math.max(min, Math.min(max, draftValue));
  const range = Math.max(1, max - min);
  const pct = Math.max(0, Math.min(100, ((clampedValue - min) / range) * 100));
  const handleShift = (pct / 100) * handleSize;
  const trackTop = (24 - trackHeight) / 2;
  const handleTop = (24 - handleSize) / 2;

  const commit = (nextValue: number) => {
    setInteracting(false);
    onCommit?.(nextValue);
  };

  return (
    <div className="rvc-slider" style={{ width }}>
      <div className="rvc-slider__track" style={{ top: trackTop, height: trackHeight }} />
      <div
        className="rvc-slider__fill"
        style={{ top: trackTop, height: trackHeight, width: `calc(${pct}% - ${handleShift - handleSize / 2}px)` }}
      />
      <div
        className="rvc-slider__handle"
        style={{ left: `calc(${pct}% - ${handleShift}px)`, top: handleTop, width: handleSize, height: handleSize }}
      />
      <input
        className="rvc-slider__input"
        type="range"
        min={min}
        max={max}
        step={step}
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
