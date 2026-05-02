import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { MapCanvasGlassBackdrop } from '@/shared/components/MapCanvasGlassBackdrop';
import { PlaceSearchInput } from '@/features/itineraryPanel/sections/timeline/components';
import type { GeocodeSuggestion } from '@/features/itineraryPanel/lib/geocoding';
import './dashboard-place-search.css';

interface DashboardPlaceSearchProps {
  map: MapboxMap | null;
  visible: boolean;
  left: number;
  top: number;
}

const SEARCH_FLY_TO_DURATION_MS = 900;
const SEARCH_MIN_ZOOM = 13.5;
const SEARCH_COUNTRIES = 'fr,ch,be,lu,it,de,es,ad';

function SearchIcon() {
  return (
    <svg
      className="rvd-place-search__icon-svg"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7 2.25a4.75 4.75 0 1 0 2.982 8.45l2.659 2.658a.75.75 0 0 0 1.06-1.06l-2.658-2.659A4.75 4.75 0 0 0 7 2.25Zm-3.25 4.75a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function DashboardPlaceSearch({
  map,
  visible,
  left,
  top,
}: DashboardPlaceSearchProps) {
  const [proximity, setProximity] = useState<{ lon: number; lat: number } | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!map) {
      setProximity(undefined);
      return;
    }

    const syncProximity = () => {
      const center = map.getCenter();
      setProximity({ lon: center.lng, lat: center.lat });
    };

    syncProximity();
    map.on('moveend', syncProximity);

    return () => {
      map.off('moveend', syncProximity);
    };
  }, [map]);

  const handlePick = useCallback(
    (suggestion: GeocodeSuggestion) => {
      if (!map) return;
      map.easeTo({
        center: [suggestion.lon, suggestion.lat],
        zoom: Math.max(map.getZoom(), SEARCH_MIN_ZOOM),
        duration: SEARCH_FLY_TO_DURATION_MS,
        essential: true,
      });
    },
    [map],
  );

  const wrapperStyle: CSSProperties = {
    position: 'absolute',
    top,
    left,
    zIndex: 30,
    opacity: visible ? 1 : 0,
    pointerEvents: visible ? 'auto' : 'none',
  };

  return (
    <div className="rvd-place-search" style={wrapperStyle} aria-hidden={!visible}>
      <div className="rvd-place-search__shell">
        <MapCanvasGlassBackdrop blur={30} saturate={1.8} tint="rgba(15, 15, 15, 0.74)" />
        <span className="rvd-place-search__icon">
          <SearchIcon />
        </span>
        <PlaceSearchInput
          value=""
          placeholder="Find..."
          proximity={proximity}
          countries={SEARCH_COUNTRIES}
          debounceMs={220}
          className="rvd-place-search__field"
          onPick={handlePick}
        />
      </div>
    </div>
  );
}