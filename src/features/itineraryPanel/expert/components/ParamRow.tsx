/**
 * Render a single Expert Mode parameter row.
 *
 * Picks the right input widget for the parameter kind:
 *   - boolean → toggle switch
 *   - number  → slider + numeric input
 *   - enum    → native select
 *
 * Layout matches the existing `.rvi-lfield` family used in the Traçage
 * section so the panel stays visually consistent.
 */
import type { ParameterDefinition, ParameterValue } from '../types';

interface ParamRowProps {
  param: ParameterDefinition;
  value: ParameterValue;
  onChange: (next: ParameterValue) => void;
  onReset: () => void;
}

export function ParamRow({ param, value, onChange, onReset }: ParamRowProps) {
  const isDefault =
    typeof value === 'number' && typeof param.default === 'number'
      ? Math.abs(value - param.default) < 1e-6
      : value === param.default;

  return (
    <div className="rvi-expert-row">
      <div className="rvi-expert-row__head">
        <label className="rvi-expert-row__label" title={param.hint ?? param.label}>
          {param.label}
          {param.advanced ? <span className="rvi-expert-row__adv">avancé</span> : null}
        </label>
        {!isDefault ? (
          <button
            type="button"
            className="rvi-expert-row__reset"
            onClick={onReset}
            title="Réinitialiser au défaut"
            aria-label={`Réinitialiser ${param.label}`}
          >
            ⟲
          </button>
        ) : null}
      </div>

      <div className="rvi-expert-row__control">
        {param.kind === 'boolean' ? (
          <BoolInput
            checked={Boolean(value)}
            onChange={(v) => onChange(v)}
            ariaLabel={param.label}
          />
        ) : null}

        {param.kind === 'number' ? (
          <NumberInput
            value={Number(value)}
            min={param.min ?? 0}
            max={param.max ?? 100}
            step={param.step ?? 1}
            unit={param.unit}
            onChange={(v) => onChange(v)}
            ariaLabel={param.label}
          />
        ) : null}

        {param.kind === 'enum' ? (
          <EnumInput
            value={String(value)}
            choices={param.choices ?? []}
            onChange={(v) =>
              onChange(/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)
            }
            ariaLabel={param.label}
          />
        ) : null}
      </div>

      {param.hint ? <p className="rvi-expert-row__hint">{param.hint}</p> : null}
    </div>
  );
}

/* ---------- Sub-widgets ---------- */

function BoolInput({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`rvi-expert-toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="rvi-expert-toggle__thumb" />
    </button>
  );
}

function NumberInput({
  value,
  min,
  max,
  step,
  unit,
  onChange,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  ariaLabel: string;
}) {
  return (
    <div className="rvi-expert-num">
      <input
        type="range"
        className="rvi-expert-num__range"
        value={Number.isFinite(value) ? value : min}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${ariaLabel} (curseur)`}
      />
      <input
        type="number"
        className="rvi-expert-num__input"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
        aria-label={ariaLabel}
      />
      {unit ? <span className="rvi-expert-num__unit">{unit}</span> : null}
    </div>
  );
}

function EnumInput({
  value,
  choices,
  onChange,
  ariaLabel,
}: {
  value: string;
  choices: { value: string | number; label: string }[];
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  return (
    <select
      className="rvi-expert-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    >
      {choices.map((c) => (
        <option key={String(c.value)} value={String(c.value)}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
