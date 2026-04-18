/**
 * Collapsible group of related Expert parameters.
 *
 * Hides by default everything flagged `advanced` unless the user has
 * toggled "Afficher tous les paramètres" at the editor level.
 */
import { useState } from 'react';
import { ParamRow } from './ParamRow';
import type {
  GroupMeta,
  ParameterDefinition,
  ParameterValue,
} from '../types';

interface ParamGroupProps {
  meta: GroupMeta;
  params: ParameterDefinition[];
  values: Record<string, ParameterValue>;
  showAdvanced: boolean;
  onChange: (id: string, next: ParameterValue) => void;
  onReset: (id: string) => void;
}

export function ParamGroup({
  meta,
  params,
  values,
  showAdvanced,
  onChange,
  onReset,
}: ParamGroupProps) {
  const [open, setOpen] = useState(true);

  const visible = params.filter(
    (p) => p.group === meta.id && (showAdvanced || !p.advanced),
  );
  if (visible.length === 0) return null;

  const total = params.filter((p) => p.group === meta.id).length;
  const hiddenCount = total - visible.length;

  return (
    <section className={`rvi-expert-group${open ? ' is-open' : ''}`}>
      <header className="rvi-expert-group__head">
        <button
          type="button"
          className="rvi-expert-group__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className={`rvi-expert-group__chev${open ? ' is-open' : ''}`}>›</span>
          <span className="rvi-expert-group__title">{meta.label}</span>
          <span className="rvi-expert-group__count">
            {visible.length}
            {hiddenCount > 0 ? `/${total}` : ''}
          </span>
        </button>
      </header>

      {open ? (
        <div className="rvi-expert-group__body">
          {meta.description ? (
            <p className="rvi-expert-group__desc">{meta.description}</p>
          ) : null}
          {visible.map((p) => (
            <ParamRow
              key={p.id}
              param={p}
              value={values[p.id] ?? p.default}
              onChange={(next) => onChange(p.id, next)}
              onReset={() => onReset(p.id)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
