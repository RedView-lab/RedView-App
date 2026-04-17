import { useState, useCallback, useEffect, useMemo } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import type { PoiCategory } from '../types';
import { POI_GROUPS, POI_LABELS, POI_COLORS, POI_CATEGORIES } from '../types';
import { usePoi } from '../hooks/usePoi';
import { useGpxRoute } from '../hooks/useGpxRoute';
import { GpxUpload, RadiusSlider, SearchButton } from './GpxSection';
import { useActiveItinerary } from '@/features/itineraryPanel/ActiveItineraryContext';
import { addGpxRoute, fitMapToRoute, removeGpxRoute, isGpxRouteOnMap } from '../lib/gpx-layer';

interface PoiPanelProps {
  map: MapboxMap | null;
  isMapLoaded: boolean;
}

export function PoiPanel({ map, isMapLoaded }: PoiPanelProps) {
  const [open, setOpen] = useState(false);
  const [enabledCategories, setEnabledCategories] = useState<Set<PoiCategory>>(new Set());

  const ctx = useActiveItinerary();
  const itineraryGpxRoute = ctx.active?.gpxRoute ?? null;

  const gpx = useGpxRoute(map, isMapLoaded);

  // Effective route: prefer the active itinerary's GPX (loaded via the
  // "Nouvel itinéraire → Importer un GPX" dialog) over the local upload.
  const effectiveRoute = useMemo(
    () => itineraryGpxRoute ?? gpx.gpxRoute,
    [itineraryGpxRoute, gpx.gpxRoute],
  );

  const { loading, error, poiCount, searchCorridor } = usePoi(
    map, isMapLoaded, enabledCategories, effectiveRoute, gpx.radiusM,
  );

  // Render the itinerary GPX as a Mapbox layer when no local upload is active.
  useEffect(() => {
    if (!map || !isMapLoaded) return;
    if (gpx.gpxRoute) return; // local upload owns the layer
    if (itineraryGpxRoute) {
      addGpxRoute(map, itineraryGpxRoute.points);
      fitMapToRoute(map, itineraryGpxRoute.points);
    } else if (isGpxRouteOnMap(map)) {
      try { removeGpxRoute(map); } catch { /* noop */ }
    }
    return () => {
      if (!gpx.gpxRoute) {
        try { removeGpxRoute(map); } catch { /* noop */ }
      }
    };
  }, [map, isMapLoaded, itineraryGpxRoute, gpx.gpxRoute]);

  // Auto-enable POI categories from the active itinerary's panel toggles
  // (mapped via the ActiveItineraryContext).
  useEffect(() => {
    if (ctx.enabledPoiCategories.size === 0) return;
    setEnabledCategories((prev) => {
      // Don't override if user has already manually picked categories.
      if (prev.size > 0) return prev;
      return new Set(ctx.enabledPoiCategories);
    });
  }, [ctx.enabledPoiCategories]);

  // Open the panel + run corridor search when the itinerary container fires
  // the "search corridor" event (e.g. right after a GPX import).
  useEffect(() => {
    return ctx.onCorridorSearchRequested(() => {
      setOpen(true);
      // Defer so usePoi has the latest effectiveRoute reference.
      setTimeout(() => searchCorridor(), 50);
    });
  }, [ctx, searchCorridor]);

  const hasAny = enabledCategories.size > 0;

  const toggle = useCallback((cat: PoiCategory) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setEnabledCategories(new Set(POI_CATEGORIES));
  }, []);

  const selectNone = useCallback(() => {
    setEnabledCategories(new Set());
  }, []);

  return (
    <div style={dockStyle}>
      <div style={toolbarStyle}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ ...modeButtonStyle, ...(hasAny ? modeButtonActiveStyle : null) }}
        >
          POI
        </button>
        {hasAny && (
          <span style={badgeStyle}>
            {loading ? '...' : poiCount}
          </span>
        )}
        {error && <span style={errorChipStyle}>!</span>}
      </div>

      {open && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>
              Points d'intérêt
            </span>
          </div>

          <GpxUpload
            gpxRoute={effectiveRoute}
            gpxLoading={gpx.gpxLoading}
            gpxError={gpx.gpxError}
            onLoadGpx={gpx.loadGpx}
            onClearGpx={gpx.clearGpx}
          />

          {effectiveRoute && (
            <RadiusSlider
              radiusM={gpx.radiusM}
              onRadiusChange={gpx.setRadiusM}
            />
          )}

          <div style={{ ...sectionStyle, paddingBottom: 0, borderBottom: 'none' }}>
            <div style={stepStyle}>
              <span style={stepNumStyle}>3</span> Catégories
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={selectAll} style={quickBtnStyle}>Tout</button>
                <button onClick={selectNone} style={quickBtnStyle}>Rien</button>
              </div>
            </div>
          </div>

          {POI_GROUPS.map((group) => (
            <div key={group.label} style={groupStyle}>
              <div style={groupLabelStyle}>{group.label}</div>
              {group.categories.map((cat) => (
                <label key={cat} style={rowStyle}>
                  <div
                    style={{
                      ...dotStyle,
                      backgroundColor: enabledCategories.has(cat) ? POI_COLORS[cat] : 'rgba(255,255,255,0.15)',
                    }}
                  />
                  <input
                    type="checkbox"
                    checked={enabledCategories.has(cat)}
                    onChange={() => toggle(cat)}
                    style={checkboxStyle}
                  />
                  <span style={labelStyle}>{POI_LABELS[cat]}</span>
                </label>
              ))}
            </div>
          ))}

          {effectiveRoute && (
            <SearchButton
              poiLoading={loading}
              disabled={enabledCategories.size === 0}
              onSearch={searchCorridor}
            />
          )}

          {error && (
            <div style={errorMsgStyle}>{error}</div>
          )}
        </div>
      )}
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

const dockStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontFamily: 'system-ui, sans-serif',
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const modeButtonStyle: React.CSSProperties = {
  background: 'rgba(12, 16, 24, 0.8)',
  color: 'rgba(255,255,255,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 999,
  padding: '8px 12px',
  fontSize: 12,
  cursor: 'pointer',
  backdropFilter: 'blur(16px)',
};

const modeButtonActiveStyle: React.CSSProperties = {
  background: 'rgba(22, 100, 52, 0.86)',
  borderColor: 'rgba(74, 222, 128, 0.44)',
};

const badgeStyle: React.CSSProperties = {
  padding: '5px 9px',
  borderRadius: 999,
  background: 'rgba(15, 23, 42, 0.78)',
  border: '1px solid rgba(74,222,128,0.24)',
  color: '#b8f5cc',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
};

const errorChipStyle: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: 999,
  background: 'rgba(78, 14, 14, 0.85)',
  border: '1px solid rgba(248,113,113,0.24)',
  color: '#ffd3d3',
  fontSize: 11,
};

const panelStyle: React.CSSProperties = {
  width: 'min(260px, calc(100vw - 24px))',
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: 'rgba(12, 14, 20, 0.84)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 16,
  backdropFilter: 'blur(18px)',
  maxHeight: 'min(500px, calc(100dvh - 120px))',
  overflowY: 'auto',
};

const panelHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  paddingBottom: 4,
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

const quickBtnStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  color: 'rgba(255,255,255,0.6)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 10,
  cursor: 'pointer',
};

const groupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const groupLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.4)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  padding: '4px 0 2px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 6px',
  borderRadius: 8,
  cursor: 'pointer',
};

const dotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: '50%',
  flexShrink: 0,
  transition: 'background-color 0.15s',
};

const checkboxStyle: React.CSSProperties = {
  display: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'rgba(255,255,255,0.82)',
  userSelect: 'none',
};

const errorMsgStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#fca5a5',
  padding: '6px 8px',
  background: 'rgba(127,29,29,0.3)',
  borderRadius: 8,
};
