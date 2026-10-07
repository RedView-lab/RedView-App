import { useEffect } from 'react';
import type { Map as MapboxMap } from 'mapbox-gl';
import { isTypingTarget } from '@/shared/lib/isTypingTarget';
import { isGoogleEarthShortcut, openGoogleEarthView } from '@/shared/lib/googleEarthView';
import { googleEarthViewFromMap } from '../lib/googleEarthCamera';

/** M : ouvre Google Earth dans un nouvel onglet, sur le point de vue exact de la carte 3D. */
export function useGoogleEarthShortcut(map: MapboxMap | null): void {
  useEffect(() => {
    if (!map) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isGoogleEarthShortcut(event) || isTypingTarget(event.target)) return;
      const view = googleEarthViewFromMap(map);
      if (!view) return;
      event.preventDefault();
      openGoogleEarthView(view);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [map]);
}
