/**
 * Plan de marquage : chaque événement mesuré, avec ses propriétés. Nommage
 * `objet_action` au passé, propriétés en snake_case ; valeurs = catégories,
 * tranches (`countBucket`…) ou nombres arrondis (`roundTo`) — jamais un nom,
 * un e-mail, un id ou des coordonnées. Dictionnaire et rapports :
 * docs/ANALYTICS.md ; entonnoirs et objectifs : scripts/umami/spec.ts.
 */

import type { ProjectAgeBucket } from './buckets';

export type AuthMethod = 'email' | 'google';
export type AuthFailureReason = 'credentials' | 'exists' | 'rate_limited' | 'network' | 'code' | 'other';
export type RouteKind = 'full' | 'patch' | 'extend';
type RouteFailureReason =
  | 'rate_limited'
  | 'seam'
  | 'restricted'
  | 'not_mapped'
  | 'no_route'
  | 'timeout'
  | 'out_of_zone'
  | 'network'
  | 'other';
type ExportFormat = 'gpx' | 'kml' | 'fit';
export type MapTool = 'tracer' | 'split' | 'merge' | 'forbidden_zone' | 'chart_placement' | 'comment' | 'flyover' | 'lidar_select';
export type MapLayer =
  | 'labels'
  | 'contours'
  | 'slopes'
  | 'altitude'
  | 'weather'
  | 'wind'
  | 'snow'
  | 'sunlight'
  | 'routes';
export type LidarTool =
  | 'distance'
  | 'height'
  | 'area'
  | 'profile'
  | 'fall_line'
  | 'viewshed'
  | 'avalanche'
  | 'pin'
  | 'look_around'
  | 'photo';
type LidarEngine = 'webgpu' | 'webgl' | 'terrain';

export type AnalyticsEvent =
  // Compte
  | { name: 'signup_completed'; data: { method: AuthMethod } }
  | { name: 'login_completed'; data: { method: AuthMethod } }
  | { name: 'auth_failed'; data: { method: AuthMethod; step: 'login' | 'signup' | 'verification' | 'reset'; reason: AuthFailureReason } }
  | { name: 'password_reset_requested' }
  | { name: 'password_reset_completed' }
  | { name: 'logout' }
  | { name: 'theme_changed'; data: { mode: 'system' | 'light' | 'dark' } }
  | { name: 'language_changed'; data: { language: string } }
  | { name: 'feedback_opened' }
  | { name: 'account_data_exported'; data: { projects: string } }
  | { name: 'account_deleted' }
  // Monétisation (Stripe gelé : interface seulement ; l'offre vue = écran /projects/subscription)
  | { name: 'checkout_started'; data: { plan: string } }
  | { name: 'checkout_completed'; data: { plan: string } }
  // Projets
  | { name: 'project_created'; data: { source: 'blank' | 'import' } }
  | { name: 'project_opened'; data: { last_saved: ProjectAgeBucket; shared: boolean } }
  | { name: 'project_deleted' }
  | { name: 'shared_project_left' }
  | { name: 'project_duplicated' }
  | { name: 'folder_created' }
  | { name: 'project_file_exported'; data: { from: 'editor' | 'browser' } }
  | { name: 'project_file_imported'; data: { outcome: 'ok' | 'error'; files: string } }
  | { name: 'editor_ready'; data: { ms: number; cold: boolean; itineraries: string } }
  // Itinéraires
  | { name: 'itinerary_added'; data: { method: 'blank' | 'gpx' | 'lidar' | 'duplicate' | 'map' | 'poi' } }
  | { name: 'gpx_imported'; data: { format: string; points: string } }
  | { name: 'route_calculated'; data: { kind: RouteKind; distance_km: number; elevation_m: number; ms: number; profile: string } }
  | { name: 'route_failed'; data: { kind: RouteKind; reason: RouteFailureReason } }
  | { name: 'route_editing_summary'; data: { routes: string; patches: string } }
  | { name: 'route_exported'; data: { format: ExportFormat; scope: 'itinerary' | 'all' } }
  | { name: 'route_action'; data: { action: 'undo' | 'redo' | 'reverse' | 'delete' } }
  // Carte
  | { name: 'map_tool_selected'; data: { tool: MapTool } }
  | { name: 'layer_toggled'; data: { layer: MapLayer; enabled: boolean } }
  | { name: 'basemap_changed'; data: { basemap: string } }
  | { name: 'freecam_entered' }
  | { name: 'google_earth_opened'; data: { from: 'map' | 'lidar' } }
  | { name: 'place_selected' }
  | { name: 'map_filter_toggled'; data: { filter: string } }
  | { name: 'context_menu_action'; data: { action: string } }
  | { name: 'poi_favorited'; data: { enabled: boolean; category: string } }
  | { name: 'roadbook_tab_opened'; data: { tab: string } }
  | { name: 'fit_uploaded'; data: { files: string } }
  | { name: 'pace_prediction_run'; data: { sport: 'bike' | 'trail' | 'running'; fit_files: string } }
  // Flyover
  | { name: 'flyover_played'; data: { distance_km: number } }
  | { name: 'flyover_finished'; data: { completed: string } }
  | { name: 'flyover_video_exported'; data: { format: 'landscape' | 'portrait'; outcome: 'done' | 'cancelled' | 'error'; duration: string } }
  // LiDAR
  | { name: 'lidar_tile_downloaded'; data: { territory: string; outcome: 'ok' | 'error' | 'cancelled' } }
  | { name: 'lidar_viewer_opened'; data: { engine: LidarEngine; tiles: string } }
  | { name: 'lidar_tool_used'; data: { tool: LidarTool } }
  | { name: 'snow_mode_enabled'; data: { mode: string } }
  | { name: 'gpu_context_lost'; data: { engine: LidarEngine } }
  // Co-édition
  | { name: 'share_dialog_opened' }
  | { name: 'share_invite_sent' }
  | { name: 'share_invite_failed' }
  | { name: 'collab_session_joined'; data: { peers: string } }
  | { name: 'comment_created'; data: { anchor: 'point' | 'zone'; on: 'map' | 'lidar' } }
  | { name: 'comment_replied'; data: { on: 'map' | 'lidar' } }
  | { name: 'comment_resolved'; data: { on: 'map' | 'lidar' } }
  | { name: 'follow_started'; data: { via: 'avatar' | 'spotlight' } }
  | { name: 'spotlight_started' };
