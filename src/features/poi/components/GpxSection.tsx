import type { ChangeEvent } from 'react';
import { useRef } from 'react';
import type { GpxRoute } from '../types';

interface GpxSectionProps {
  gpxRoute: GpxRoute | null;
  radiusM: number;
  gpxLoading: boolean;
  gpxError: string | null;
  poiLoading: boolean;
  onLoadGpx: (file: File) => void;
  onClearGpx: () => void;
  onRadiusChange: (v: number) => void;
  onSearch: () => void;
}

export function GpxSection({
  gpxRoute,
  radiusM,
  gpxLoading,
  gpxError,
  poiLoading,
  onLoadGpx,
  onClearGpx,
  onRadiusChange,
  onSearch,
}: GpxSectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onLoadGpx(file);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>Trace GPX</div>

      {!gpxRoute ? (
        <label style={uploadBtnStyle}>
          {gpxLoading ? 'Chargement...' : '+ Charger GPX'}
          <input
            ref={inputRef}
            type="file"
            accept=".gpx"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
        </label>
      ) : (
        <>
          <div style={routeInfoStyle}>
            <span style={routeNameStyle}>
              {gpxRoute.name ?? 'Sans nom'}
            </span>
            <span style={routeMetaStyle}>
              {gpxRoute.points.length.toLocaleString()} pts
            </span>
            <button onClick={onClearGpx} style={clearBtnStyle}>✕</button>
          </div>

          <div style={sliderRowStyle}>
            <span style={sliderLabelStyle}>Rayon</span>
            <input
              type="range"
              min={100}
              max={5000}
              step={100}
              value={radiusM}
              onChange={(e) => onRadiusChange(Number(e.target.value))}
              style={sliderStyle}
            />
            <span style={sliderValueStyle}>{radiusM >= 1000 ? `${radiusM / 1000}km` : `${radiusM}m`}</span>
          </div>

          <button
            onClick={onSearch}
            disabled={poiLoading}
            style={{ ...searchBtnStyle, ...(poiLoading ? searchBtnDisabledStyle : null) }}
          >
            {poiLoading ? 'Recherche...' : 'Rechercher POI'}
          </button>
        </>
      )}

      {gpxError && <div style={gpxErrorStyle}>{gpxError}</div>}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingBottom: 8,
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.4)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const uploadBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '7px 12px',
  borderRadius: 8,
  border: '1px dashed rgba(255,255,255,0.2)',
  background: 'rgba(255,255,255,0.04)',
  color: 'rgba(255,255,255,0.7)',
  fontSize: 11,
  cursor: 'pointer',
};

const routeInfoStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 8px',
  borderRadius: 8,
  background: 'rgba(255,107,53,0.12)',
  border: '1px solid rgba(255,107,53,0.25)',
};

const routeNameStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  fontWeight: 600,
  color: '#ffb088',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const routeMetaStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.45)',
  flexShrink: 0,
};

const clearBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'rgba(255,255,255,0.5)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '0 2px',
  lineHeight: 1,
};

const sliderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const sliderLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.5)',
  flexShrink: 0,
  width: 34,
};

const sliderStyle: React.CSSProperties = {
  flex: 1,
  height: 4,
  accentColor: '#ff6b35',
};

const sliderValueStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'rgba(255,255,255,0.6)',
  fontVariantNumeric: 'tabular-nums',
  width: 32,
  textAlign: 'right',
  flexShrink: 0,
};

const searchBtnStyle: React.CSSProperties = {
  padding: '7px 0',
  borderRadius: 8,
  border: '1px solid rgba(255,107,53,0.4)',
  background: 'rgba(255,107,53,0.18)',
  color: '#ffb088',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
};

const searchBtnDisabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: 'default',
};

const gpxErrorStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#fca5a5',
  padding: '4px 6px',
  background: 'rgba(127,29,29,0.3)',
  borderRadius: 6,
};
