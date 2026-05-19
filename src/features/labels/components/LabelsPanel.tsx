import { useCallback, useMemo, useState } from 'react';
import { useAppI18n } from '@/shared/i18n';
import { AssetIcon } from '@/shared/components/AssetIcon';
import type { LabelsPanelProps, LabelCategory } from '../types';
import { LABEL_CATEGORIES } from '../lib/label-config';
import { loadLabelState, saveLabelState } from '../lib/label-persist';
import { useLabels } from '../hooks/useLabels';

// ── Component ─────────────────────────────────────────────────────────

export function LabelsPanel({ map, isMapLoaded }: LabelsPanelProps) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(() => loadLabelState());

  // Memoize to avoid re-running the hook on every render
  const stableState = useMemo(() => ({ ...state }), [state]);

  useLabels(map, isMapLoaded, stableState);

  const toggle = useCallback((id: LabelCategory) => {
    setState((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveLabelState(next);
      return next;
    });
  }, []);

  return (
    <div style={wrapperStyle}>
      {/* Toggle button */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          ...toggleBtnStyle,
          ...(open ? toggleBtnActiveStyle : {}),
        }}
        title={t('Étiquettes')}
      >
        <AssetIcon src="/svgv2/icone/mark.svg" size={15} />
      </button>

      {/* Panel */}
      {open && (
        <div style={panelStyle}>
          <div style={headerRowStyle}>
            <span style={headerStyle}>{t('Étiquettes')}</span>
            <ToggleAllButton state={state} setState={setState} />
          </div>

          <div style={gridStyle}>
            {LABEL_CATEGORIES.map((cat) => (
              <label key={cat.id} style={rowStyle}>
                <input
                  type="checkbox"
                  checked={state[cat.id]}
                  onChange={() => toggle(cat.id)}
                  style={checkboxStyle}
                />
                <span style={labelTextStyle}>{t(cat.label)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Toggle all / none button ──────────────────────────────────────────

function ToggleAllButton({
  state,
  setState,
}: {
  state: Record<LabelCategory, boolean>;
  setState: React.Dispatch<React.SetStateAction<Record<LabelCategory, boolean>>>;
}) {
  const { t } = useAppI18n();
  const allEnabled = LABEL_CATEGORIES.every((c) => state[c.id]);

  const handleClick = () => {
    const next = {} as Record<LabelCategory, boolean>;
    const value = !allEnabled;
    for (const c of LABEL_CATEGORIES) next[c.id] = value;
    saveLabelState(next);
    setState(next);
  };

  return (
    <button onClick={handleClick} style={toggleAllStyle} title={allEnabled ? t('Tout masquer') : t('Tout afficher')}>
      {allEnabled ? t('Tout masquer') : t('Tout afficher')}
    </button>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const toggleBtnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(17,17,17,0.7)',
  color: 'rgba(255,255,255,0.8)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 6,
  cursor: 'pointer',
  backdropFilter: 'blur(8px)',
  padding: 0,
  transition: 'background 0.15s',
};

const toggleBtnActiveStyle: React.CSSProperties = {
  background: 'rgba(68, 204, 136, 0.25)',
  borderColor: 'rgba(68, 204, 136, 0.5)',
};

const panelStyle: React.CSSProperties = {
  background: 'rgba(12, 14, 20, 0.84)',
  backdropFilter: 'blur(18px)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 12,
  padding: '10px 14px 12px',
  minWidth: 240,
  color: 'rgba(255,255,255,0.88)',
  fontSize: 12,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const headerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
};

const headerStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'rgba(255,255,255,0.45)',
};

const toggleAllStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.4)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '6px 14px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
  userSelect: 'none',
};

const checkboxStyle: React.CSSProperties = {
  accentColor: '#c0392b',
  width: 14,
  height: 14,
  cursor: 'pointer',
  margin: 0,
};

const labelTextStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
};
