import mapboxgl from 'mapbox-gl';
import type { Map as MapboxMap } from 'mapbox-gl';

const DOT_CLASS = 'rvi-analysis-hover-dot';

/**
 * Point blanc cerclé de la couleur de l'itinéraire, posé sur la trace : survol
 * du graphique d'analyse et tête de lecture du flyover ont le même rendu.
 */
export function createRouteDotMarker(map: MapboxMap, lngLat: [number, number], color: string): mapboxgl.Marker {
  const el = document.createElement('div');
  el.className = DOT_CLASS;
  el.style.width = '14px';
  el.style.height = '14px';
  el.style.boxSizing = 'border-box';
  el.style.borderRadius = '50%';
  el.style.backgroundColor = '#ffffff';
  el.style.border = `3px solid ${color}`;
  el.style.boxShadow = '0 0 0 1.5px rgba(0, 0, 0, 0.75), 0 2px 8px rgba(0, 0, 0, 0.85)';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '1';
  el.dataset.rvHoverColor = color;

  const marker = new mapboxgl.Marker({
    element: el,
    anchor: 'center',
    pitchAlignment: 'viewport',
    rotationAlignment: 'viewport',
    occludedOpacity: 1,
  })
    .setLngLat(lngLat)
    .addTo(map);

  const wrapper = marker.getElement();
  if (wrapper) wrapper.style.pointerEvents = 'none';
  return marker;
}

/** Hot path : ne touche le DOM que si la couleur change. */
export function setRouteDotMarkerColor(marker: mapboxgl.Marker, color: string): void {
  const el = marker.getElement();
  if (!el || el.dataset.rvHoverColor === color) return;
  el.dataset.rvHoverColor = color;
  el.style.pointerEvents = 'none';
  const inner = (el.classList.contains(DOT_CLASS) ? el : el.querySelector(`.${DOT_CLASS}`)) as HTMLElement | null;
  if (inner) inner.style.borderColor = color;
}
