/**
 * Reusable presentational primitives for the Central Panel.
 *
 * Kept tiny and dependency-free so the layout sections stay readable.
 */
import type { ReactNode } from 'react';

import { IconCheck, IconChevronDown } from './icons';

/* -------------------------------------------------------------------------- */
/* Checkbox                                                                   */
/* -------------------------------------------------------------------------- */

interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  /** Optional decorative icon shown between the box and the label. */
  icon?: ReactNode;
  ariaLabel?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  icon,
  ariaLabel,
}: CheckboxProps) {
  return (
    <label className="rvc-checkbox" aria-label={ariaLabel}>
      <span
        className={`rvc-checkbox__box${checked ? ' is-checked' : ''}`}
        aria-hidden
      >
        {checked ? <IconCheck size={10} /> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="rvc-checkbox__input"
      />
      {icon ? <span className="rvc-checkbox__icon">{icon}</span> : null}
      <span className="rvc-checkbox__label">{label}</span>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Select                                                                     */
/* -------------------------------------------------------------------------- */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  /** Optional title rendered as a small label above the field. */
  prefix?: ReactNode;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  prefix,
}: SelectProps<T>) {
  return (
    <div className="rvc-select" role="group">
      {prefix ? <span className="rvc-select__prefix">{prefix}</span> : null}
      <span className="rvc-select__value">
        {options.find((o) => o.value === value)?.label ?? '—'}
      </span>
      <span className="rvc-select__chevron" aria-hidden>
        <IconChevronDown size={20} />
      </span>
      <select
        aria-label={ariaLabel}
        className="rvc-select__native"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Slider                                                                     */
/* -------------------------------------------------------------------------- */

interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
}

export function Slider({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  ariaLabel,
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <span className="rvc-slider">
      <span className="rvc-slider__track" aria-hidden>
        <span
          className="rvc-slider__progress"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
        <span
          className="rvc-slider__handle"
          style={{ left: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </span>
      <input
        type="range"
        aria-label={ariaLabel}
        className="rvc-slider__input"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Tab group (segmented)                                                      */
/* -------------------------------------------------------------------------- */

interface SegmentedProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (next: T) => void;
  ariaLabel?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div className="rvc-segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            type="button"
            className={`rvc-segmented__btn${active ? ' is-active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
