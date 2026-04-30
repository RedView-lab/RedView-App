import { useState, useCallback } from 'react';
import { AssetIcon } from '@/shared/components/AssetIcon';
import type { SlopePanelProps, SlopeColorMode } from '../types';
import { SLOPE_CATEGORIES, degToPercent } from '../lib/slope-config';
import { loadSlopeState, saveSlopeState } from '../lib/slope-persist';
import { useSlope } from '../hooks/useSlope';

// ── Component ─────────────────────────────────────────────────────────

export function SlopePanel({ map, isMapLoaded }: SlopePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState(loadSlopeState);

  const persist = useCallback((next: typeof state) => {
    setState(next);
    saveSlopeState(next);
  }, []);

  useSlope(isMapLoaded ? map : null, isMapLoaded, state.enabled, state.opacity, state.colorMode);

  const toggleEnabled = () => {
    persist({ ...state, enabled: !state.enabled });
  };

  const setOpacity = (v: number) => {
    persist({ ...state, opacity: v });
  };

  const setColorMode = (m: SlopeColorMode) => {
    persist({ ...state, colorMode: m });
  };

  return (
    <div style={wrapperStyle}>
      {/* Toggle button */}
      <button
        onClick={() => setExpanded(v => !v)}
        style={{
          ...toggleBtnStyle,
          ...(state.enabled ? activeBtnStyle : {}),
        }}
        title="Pentes"
      >
        <AssetIcon src="/svgv2/icone/scale-01.svg" size={16} />
      </button>

      {/* Panel */}
      {expanded && (
        <div style={panelStyle}>
          <div style={headerStyle}>Pentes</div>

          {/* Enable toggle */}
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={toggleEnabled}
              style={checkboxStyle}
            />
            <span style={labelTextStyle}>Afficher les pentes</span>
          </label>

          {state.enabled && (
            <div style={sectionStyle}>
              {/* Color mode */}
              <div style={fieldStyle}>
                <span style={fieldLabelStyle}>Colorisation</span>
                <select
                  value={state.colorMode}
                  onChange={e => setColorMode(e.target.value as SlopeColorMode)}
                  style={selectStyle}
                >
                  <option value="gradient">Dégradé</option>
                  <option value="step">Catégoriel</option>
                </select>
              </div>

              {/* Opacity slider */}
              <div style={fieldStyle}>
                <span style={fieldLabelStyle}>Opacité</span>
                <div style={sliderRowStyle}>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={state.opacity}
                    onChange={e => setOpacity(parseFloat(e.target.value))}
                    style={sliderStyle}
                  />
                  <span style={sliderValueStyle}>{Math.round(state.opacity * 100)}%</span>
                </div>
              </div>

              {/* Legend */}
              <div style={legendSectionStyle}>
                <div style={legendTitleStyle}>Légende</div>
                {SLOPE_CATEGORIES.map(cat => (
                  <div key={cat.id} style={legendRowStyle}>
                    <div style={{ ...legendDotStyle, backgroundColor: cat.color }} />
                    <span style={legendRangeStyle}>
                      {cat.minDeg}°–{cat.maxDeg}°
                    </span>
                    <span style={legendPctStyle}>
                      ({degToPercent(cat.minDeg)}–{degToPercent(cat.maxDeg)}%)
                    </span>
                    <span style={legendNameStyle}>{cat.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const wrapperStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
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
};

const activeBtnStyle: React.CSSProperties = {
  borderColor: '#2DBF5E',
  color: '#2DBF5E',
};

const panelStyle: React.CSSProperties = {
  background: 'rgba(17,17,17,0.8)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '10px 12px',
  minWidth: 200,
  color: 'rgba(255,255,255,0.85)',
  fontSize: 12,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const headerStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'rgba(255,255,255,0.45)',
  marginBottom: 8,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  cursor: 'pointer',
  userSelect: 'none',
};

const checkboxStyle: React.CSSProperties = {
  accentColor: '#2DBF5E',
  width: 14,
  height: 14,
  cursor: 'pointer',
  margin: 0,
};

const labelTextStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const sectionStyle: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 8,
  borderTop: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.4)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const selectStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  color: 'rgba(255,255,255,0.85)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 4,
  padding: '4px 6px',
  fontSize: 12,
  cursor: 'pointer',
  outline: 'none',
};

const sliderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const sliderStyle: React.CSSProperties = {
  flex: 1,
  accentColor: '#2DBF5E',
  height: 4,
  cursor: 'pointer',
};

const sliderValueStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(255,255,255,0.5)',
  minWidth: 32,
  textAlign: 'right',
};

const legendSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const legendTitleStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.4)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 2,
};

const legendRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
};

const legendDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 2,
  flexShrink: 0,
};

const legendRangeStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.7)',
  minWidth: 42,
};

const legendPctStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.35)',
  fontSize: 10,
  minWidth: 52,
};

const legendNameStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.55)',
  fontStyle: 'italic',
};
