import type { ChangeEvent } from 'react';
import { useRef } from 'react';
import type { GpxRoute } from '../types';

// ── Step 1 : GPX upload / info ────────────────────────────────────────

interface GpxUploadProps {
  gpxRoute: GpxRoute | null;
  gpxLoading: boolean;
  gpxError: string | null;
  onLoadGpx: (file: File) => void;
  onClearGpx: () => void;
}

export function GpxUpload({ gpxRoute, gpxLoading, gpxError, onLoadGpx, onClearGpx }: GpxUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onLoadGpx(file);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div style={sectionStyle}>
      <div style={stepStyle}><span style={stepNumStyle}>1</span> Trace GPX</div>

      {!gpxRoute ? (
        <label style={uploadBtnStyle}>
          {gpxLoading ? 'Chargement...' : '+ Charger un fichier GPX'}
          <input
            ref={inputRef}
            type="file"
            accept=".gpx"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
        </label>
      ) : (
        <div style={routeInfoStyle}>
          <span style={routeNameStyle}>{gpxRoute.name ?? 'Sans nom'}</span>
          <span style={routeMetaStyle}>{gpxRoute.points.length.toLocaleString()} pts</span>
          <button onClick={onClearGpx} style={clearBtnStyle}>✕</button>
        </div>
      )}

      {gpxError && <div style={gpxErrorStyle}>{gpxError}</div>}
    </div>
  );
}

// ── Step 2 : Radius slider ────────────────────────────────────────────

interface RadiusSliderProps {
  radiusM: number;
  onRadiusChange: (v: number) => void;
}

export function RadiusSlider({ radiusM, onRadiusChange }: RadiusSliderProps) {
  return (
    <div style={sectionStyle}>
      <div style={stepStyle}><span style={stepNumStyle}>2</span> Rayon de recherche</div>
      <div style={sliderRowStyle}>
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
    </div>
  );
}

// ── Step 4 : Search button ────────────────────────────────────────────

interface SearchButtonProps {
  poiLoading: boolean;
  disabled: boolean;
  onSearch: () => void;
}

export function SearchButton({ poiLoading, disabled, onSearch }: SearchButtonProps) {
  return (
    <button
      onClick={onSearch}
      disabled={disabled || poiLoading}
      style={{
        ...searchBtnStyle,
        ...((disabled || poiLoading) ? searchBtnDisabledStyle : null),
      }}
    >
      {poiLoading ? 'Recherche en cours...' : 'Rechercher les POI'}
    </button>
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

const stepStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 10,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.4)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const stepNumStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  borderRadius: '50%',
  background: 'rgba(255,107,53,0.25)',
  color: '#ff9a6c',
  fontSize: 9,
  fontWeight: 700,
  flexShrink: 0,
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

const sliderStyle: React.CSSProperties = {
  flex: 1,
  height: 4,
  accentColor: '#ff6b35',
};

const sliderValueStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(255,255,255,0.7)',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
  width: 36,
  textAlign: 'right',
  flexShrink: 0,
};

const searchBtnStyle: React.CSSProperties = {
  padding: '9px 0',
  borderRadius: 10,
  border: '1px solid rgba(255,107,53,0.5)',
  background: 'rgba(255,107,53,0.22)',
  color: '#ffb088',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: '0.02em',
  marginTop: 2,
};

const searchBtnDisabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: 'default',
};

const gpxErrorStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#fca5a5',
  padding: '4px 6px',
  background: 'rgba(127,29,29,0.3)',
  borderRadius: 6,
};
