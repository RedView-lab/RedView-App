import { useState } from 'react';
import type { MapToolsPanelProps } from '../types';
import { useWind } from '../hooks/useWind';

// ── Wind speed legend steps ───────────────────────────────────────────

const LEGEND: { label: string; color: string; min: number }[] = [
  { label: '0–3', color: '#4085f5', min: 0 },
  { label: '3–6', color: '#1abfd9', min: 3 },
  { label: '6–10', color: '#0dd959', min: 6 },
  { label: '10–15', color: '#b3eb1a', min: 10 },
  { label: '15–20', color: '#facc0d', min: 15 },
  { label: '20–30', color: '#fa730d', min: 20 },
  { label: '30+', color: '#e6261f', min: 30 },
];

// ── Component ─────────────────────────────────────────────────────────

export function MapToolsPanel({ map, isMapLoaded }: MapToolsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [windEnabled, setWindEnabled] = useState(false);

  const wind = useWind(isMapLoaded ? map : null, windEnabled);

  return (
    <div style={wrapperStyle}>
      {/* Toggle button */}
      <button
        onClick={() => setExpanded((v) => !v)}
        style={toggleBtnStyle}
        title="Outils carte"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ display: 'block' }}>
          <path
            d="M8 1 L10 6 L15 8 L10 10 L8 15 L6 10 L1 8 L6 6 Z"
            fill="currentColor"
          />
        </svg>
      </button>

      {/* Panel */}
      {expanded && (
        <div style={panelStyle}>
          <div style={headerStyle}>Outils carte</div>

          {/* ── Wind toggle ────────────────────────────── */}
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={windEnabled}
              onChange={(e) => setWindEnabled(e.target.checked)}
              style={checkboxStyle}
            />
            <span style={labelTextStyle}>Vent</span>
            {wind.loading && <span style={spinnerStyle}>⟳</span>}
          </label>

          {/* ── Wind info & legend ─────────────────────── */}
          {windEnabled && (
            <div style={windInfoStyle}>
              {wind.error && (
                <div style={errorStyle}>{wind.error}</div>
              )}

              {wind.pointCount > 0 && (
                <div style={metaStyle}>
                  {wind.pointCount} pts
                  {wind.lastUpdate && (
                    <span> · {new Date(wind.lastUpdate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                </div>
              )}

              {/* Legend */}
              <div style={legendContainerStyle}>
                <div style={legendLabelStyle}>m/s</div>
                <div style={legendBarStyle}>
                  {LEGEND.map((s) => (
                    <div key={s.min} style={legendItemStyle}>
                      <div style={{ ...legendDotStyle, backgroundColor: s.color }} />
                      <span style={legendValueStyle}>{s.label}</span>
                    </div>
                  ))}
                </div>
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

const panelStyle: React.CSSProperties = {
  background: 'rgba(17,17,17,0.8)',
  backdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  padding: '10px 12px',
  minWidth: 160,
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
  accentColor: '#44cc88',
  width: 14,
  height: 14,
  cursor: 'pointer',
  margin: 0,
};

const labelTextStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  flex: 1,
};

const spinnerStyle: React.CSSProperties = {
  fontSize: 14,
  animation: 'spin 1s linear infinite',
  display: 'inline-block',
};

const windInfoStyle: React.CSSProperties = {
  marginTop: 8,
  paddingTop: 8,
  borderTop: '1px solid rgba(255,255,255,0.08)',
};

const errorStyle: React.CSSProperties = {
  color: '#ee6655',
  fontSize: 11,
  marginBottom: 4,
};

const metaStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.4)',
  fontSize: 10,
  marginBottom: 6,
};

const legendContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const legendLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.35)',
  fontStyle: 'italic',
};

const legendBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  flexWrap: 'wrap',
};

const legendItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
};

const legendDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
};

const legendValueStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.5)',
};
