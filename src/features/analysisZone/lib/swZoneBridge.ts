/**
 * Bridge between the page and the DEM Service Worker for the analysis zone.
 *
 * The SW keeps a small registry `hash → polygon ring` used by the slope /
 altitude tile handlers to (a) reject tiles outside the polygon before any
 * DEM fetch and (b) alpha-mask partially covered tiles. The registry lives in
 * the SW's memory, so it is lost whenever the SW restarts (browser idle,
 * update, crash). This module therefore re-registers the current zone on
 * `controllerchange`, matching the page ↔ SW contract used by the DEM sources
 * (the page only (re)adds tile sources after the SW controls the page).
 *
 * Degradation contract: if a tile request carries a `?zone=<hash>` the SW
 * does not know, the handler builds the tile WITHOUT the polygon mask — a
 * correct (if untrimmed) tile rather than an error.
 */

import {
  analysisZoneRingPayload,
  hashAnalysisZone,
  type AnalysisZone,
} from './geometry';

export function postAnalysisZoneToSw(zone: AnalysisZone | null): void {
  try {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return;
    if (!zone) {
      controller.postMessage({ type: 'CLEAR_ANALYSIS_ZONE' });
      return;
    }
    controller.postMessage({
      type: 'SET_ANALYSIS_ZONE',
      hash: hashAnalysisZone(zone),
      ring: analysisZoneRingPayload(zone),
    });
  } catch {
    /* SW not controlling yet — the controllerchange watcher re-sends */
  }
}

/**
 * Keeps `zone` registered in the SW for the lifetime of the returned cleanup
 * function: registers SYNCHRONOUSLY on subscribe / zone change (the slope
 * source swap in a child component can issue `?zone=` tile requests within
 * the same commit — the registry must be populated before they reach the
 * SW), and re-registers (deferred one tick) whenever the controller changes.
 */
export function keepAnalysisZoneRegistered(zone: AnalysisZone | null): () => void {
  postAnalysisZoneToSw(zone);

  let unsubscribe: (() => void) | null = null;
  try {
    const registration = navigator.serviceWorker;
    if (registration) {
      const onChange = () => {
        // On `controllerchange` the new controller may not be exposed as
        // `navigator.serviceWorker.controller` yet — defer one tick.
        setTimeout(() => postAnalysisZoneToSw(zone), 60);
      };
      registration.addEventListener('controllerchange', onChange);
      unsubscribe = () => registration.removeEventListener('controllerchange', onChange);
    }
  } catch {
    /* no service worker support */
  }

  return () => {
    unsubscribe?.();
  };
}
