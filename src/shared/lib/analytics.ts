/**
 * Umami Analytics Helper
 * Provides type-safe custom event and pageview tracking for RedView.
 */

declare global {
  interface Window {
    umami?: {
      track: (eventName: string, eventData?: Record<string, string | number | boolean>) => void;
      identify: (userData: Record<string, string | number | boolean>) => void;
    };
  }
}

export type AnalyticsEvent =
  | { name: 'route_calculated'; data?: { distance_km?: number; elevation_gain?: number; surface?: string } }
  | { name: 'fit_simulation_run'; data?: { ftp_w?: number; mass_kg?: number } }
  | { name: 'snow_layer_activated'; data?: { date?: string } }
  | { name: 'lidar_tile_loaded'; data?: { tile_name?: string } }
  | { name: 'poi_search_executed'; data?: { category?: string } }
  | { name: 'gpx_imported'; data?: { format?: string } }
  | { name: 'gpx_exported'; data?: { format?: string; total_points?: number } }
  | { name: 'user_login'; data?: { method?: string } }
  | { name: 'user_signup'; data?: { provider?: string; method?: string } }
  | { name: 'click_upgrade_pro'; data?: { plan?: string; source?: string; status?: string } };

export function trackAnalyticsEvent(event: AnalyticsEvent): void {
  if (typeof window !== 'undefined' && window.umami) {
    try {
      window.umami.track(event.name, event.data);
    } catch (e) {
      console.warn('[Analytics] Failed to track event:', event.name, e);
    }
  }
}

export function trackCustomEvent(
  name: string,
  data?: Record<string, string | number | boolean>,
): void {
  if (typeof window !== 'undefined' && window.umami) {
    try {
      window.umami.track(name, data);
    } catch (e) {
      console.warn('[Analytics] Failed to track event:', name, e);
    }
  }
}
