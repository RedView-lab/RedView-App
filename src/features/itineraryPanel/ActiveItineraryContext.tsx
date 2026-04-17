/**
 * Cross-feature context exposing the active itinerary and a small set of
 * mutators so other dock panels (POI, weather, etc.) can react to its state
 * without a full prop-drilling refactor.
 *
 * The provider lives at the Dashboard level; `ItineraryPanelContainer`
 * publishes its in-memory project to it on every change, and `PoiPanel`
 * reads `gpxRoute` + `enabledPoiCategories` from it.
 *
 * Designed to stay lightweight: no reducer, no normalized store. Add a real
 * store (Zustand / Redux / Supabase sync) once persistence is required.
 */
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PoiCategory as FeaturePoiCategory } from '@/features/poi/types';
import type { Itinerary, PoiCategory as PanelPoiCategory } from './types';

/** Map between the panel's category names and the POI feature categories. */
export const PANEL_TO_FEATURE_POI: Record<PanelPoiCategory, FeaturePoiCategory[]> =
  {
    fountains: ['drinking_water'],
    bakeries: ['bakery'],
    supermarkets: ['supermarket', 'convenience'],
    restaurants: [], // Not yet supported by the OSM categories list.
    hotels: [], // Not yet mapped.
    refuges: ['shelter', 'camp_site'],
    bars: [],
    passes: [], // Mountain passes — handled separately by the slope/POI layers.
  };

export interface ActiveItineraryContextValue {
  /** Currently active itinerary, or null when none exists yet. */
  active: Itinerary | null;
  /** All loaded itineraries for the active project. */
  itineraries: Itinerary[];
  /** Fired by the panel whenever the active itinerary changes. */
  setActive: (it: Itinerary | null) => void;
  setItineraries: (list: Itinerary[]) => void;
  /** Set of POI feature categories currently enabled in the panel. */
  enabledPoiCategories: Set<FeaturePoiCategory>;
  /** Average search radius from the panel POI rows (metres). */
  poiSearchRadiusM: number;
  /** Trigger a manual corridor search using the current GPX route. */
  triggerCorridorSearch: () => void;
  /** Subscribe to corridor-search requests. Returns an unsubscribe function. */
  onCorridorSearchRequested: (cb: () => void) => () => void;
}

const noop = () => {};

const ActiveItineraryContext = createContext<ActiveItineraryContextValue>({
  active: null,
  itineraries: [],
  setActive: noop,
  setItineraries: noop,
  enabledPoiCategories: new Set(),
  poiSearchRadiusM: 1000,
  triggerCorridorSearch: noop,
  onCorridorSearchRequested: () => noop,
});

export function ActiveItineraryProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Itinerary | null>(null);
  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [listeners] = useState<Set<() => void>>(() => new Set());

  const value = useMemo<ActiveItineraryContextValue>(() => {
    const enabled = new Set<FeaturePoiCategory>();
    let radiusSum = 0;
    let radiusCount = 0;
    if (active) {
      for (const [panelKey, value] of Object.entries(active.poi)) {
        if (panelKey === 'refineResults') continue;
        const entry = value as { enabled: boolean; distanceM: number | null };
        if (!entry.enabled) continue;
        const featureKeys =
          PANEL_TO_FEATURE_POI[panelKey as PanelPoiCategory] ?? [];
        for (const fk of featureKeys) enabled.add(fk);
        if (entry.distanceM && entry.distanceM > 0) {
          radiusSum += entry.distanceM;
          radiusCount += 1;
        }
      }
    }
    const radius = radiusCount > 0 ? Math.round(radiusSum / radiusCount) : 1000;

    return {
      active,
      itineraries,
      setActive,
      setItineraries,
      enabledPoiCategories: enabled,
      poiSearchRadiusM: radius,
      triggerCorridorSearch: () => {
        for (const cb of listeners) cb();
      },
      onCorridorSearchRequested: (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    };
  }, [active, itineraries, listeners]);

  return (
    <ActiveItineraryContext.Provider value={value}>
      {children}
    </ActiveItineraryContext.Provider>
  );
}

export function useActiveItinerary() {
  return useContext(ActiveItineraryContext);
}
