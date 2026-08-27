/**
 * Types for the left-dock Itinerary Panel (Figma nodes 1539:19209 / 1539:19715).
 *
 * The panel hosts an editable project with 1..n itineraries. Each itinerary
 * has four editing modes (Traçage, Rythme, POI, Nutrition) and a shared
 * timeline (Feuille de route) at the bottom.
 */
import type { ExpertProfileState } from './expert/types';
import type { Surface } from './lib/route-metrics/types';
import type { ControlPanelPersistedState } from '../controlPanel/lib/persistedState';
import type { PredictionResult } from '../fitPredictor/types';
import type { PoiFeature } from '../poi/types';

export type GpxQualityPreset = 'default' | 'balanced' | 'max';
export type GpxQualityMode = GpxQualityPreset | 'expert';

/**
 * Persisted state of the bottom analysis chart (centerPanel). Stored on
 * the project so axis selections, filter chips and the X-axis mode
 * (distance / elapsed time / clock time) survive across sessions.
 */
export type AnalysisAxisMetricId =
  | 'Altitude'
  | 'Vitesse'
  | 'Vitesse moyenne'
  | 'Puissance'
  | 'Puissance moyenne'
  | 'Inclinaison (°)'
  | 'Inclinaison (%)'
  | 'Surface'
  | 'Température'
  | 'Température ressentie (°)'
  | 'Pluie (mm)'
  | 'Vent (km/h)'
  | 'Couverture nuageuse (%)'
  | 'Humidité (%)'
  | 'Ensoleillement (min)';

export type AnalysisAxisMode = 'distance' | 'temps' | 'heure';

export interface AnalysisFiltersState {
  waypoint: boolean;
  poi: boolean;
  pause: boolean;
  alertes: boolean;
  pente: boolean;
  jourNuit: boolean;
}

export interface AnalysisPanelState {
  xMode: AnalysisAxisMode;
  axis1: AnalysisAxisMetricId;
  axis2: AnalysisAxisMetricId;
  axis1Color?: string;
  axis2Color?: string;
  filters: AnalysisFiltersState;
  detailZoom: number;
  detailOffset: number;
}

export type PanelMode = 'tracage' | 'rythme' | 'poi' | 'nutrition';

/** Value a routing/road preference slot can take. */
export type RoadPreference = 'avoid' | 'prefer' | 'tolerate' | 'forbid';

/** Visual profile applied to routing ("Gravel (défaut)" etc.). */
export interface RouteProfile {
  id: string;
  name: string;
  isDefault?: boolean;
}

export interface PrioritiesState {
  /** Each value ∈ [0, 100]. */
  duration: number;
  elevation: number;
  distance: number;
  tranquility: number;
}

export interface RoadTypesState {
  road: RoadPreference;
  gravel: RoadPreference;
  singletrack: RoadPreference;
  offroad: RoadPreference;
  bikeLanes: RoadPreference;
  majorRoads: RoadPreference;
  ferry: RoadPreference;
  turns: RoadPreference;
  /** Max slope in percent (0–100). */
  maxSlopePercent: number;
  cities: RoadPreference;
  /**
   * When true, the current road-type settings are applied to every itinerary
   * of the project. Figma 1705:23497 (Appliquer à tout les itinéraires).
   */
  applyToAllItineraries: boolean;
}

/** One POI type row: enabled + search radius (metres, or null when disabled). */
export interface PoiEntry {
  enabled: boolean;
  /** Search radius in metres. Null when the row is fully disabled. */
  distanceM: number | null;
}

export type PoiCategory =
  | 'fountains'
  | 'toilets'
  | 'supermarkets'
  | 'gasStations'
  | 'bakeries'
  | 'fastFood'
  | 'cafes'
  | 'bars'
  | 'restaurants'
  | 'bikeShops'
  | 'hotels'
  | 'refuges'
  | 'passes';

export interface PoiState {
  fountains: PoiEntry;
  toilets: PoiEntry;
  supermarkets: PoiEntry;
  gasStations: PoiEntry;
  bakeries: PoiEntry;
  fastFood: PoiEntry;
  cafes: PoiEntry;
  bars: PoiEntry;
  restaurants: PoiEntry;
  bikeShops: PoiEntry;
  hotels: PoiEntry;
  refuges: PoiEntry;
  passes: PoiEntry;
  /** "Affiner les résultats (beta)" toggle. */
  refineResults: boolean;
  /** Max POI kept per category over a 1 km sliding window. */
  refineLimitPerKm?: 2 | 4 | 6;
}

/** A single user-defined pause inserted at a recurring interval. */
export interface PauseIntervalRow {
  id: string;
  /** Display label ("Pause 1", "Pause 2", …). */
  label: string;
  /** Pause duration in minutes (e.g. 5, 210 → 3h30). */
  durationMin: number;
  /** Repetition interval in minutes (e.g. 60 → every hour). */
  intervalMin: number;
}

export type RhythmGender = 'default' | 'male' | 'female';

export interface RhythmState {
  /** ISO date (yyyy-mm-dd) or null when empty. */
  startDate: string | null;
  /** 24h time (HH:MM) or null when empty. */
  startTime: string | null;
  /** Prediction engine gender override. `default` lets the backend decide. */
  gender?: RhythmGender;
  usePastActivities: boolean;
  ftp: number | null;
  systemWeightKg: number | null;
  tiresMm: number | null;
  useWeather: boolean;
  weatherWeight: number;
  useSurfaces: boolean;
  surfacesWeight: number;
  pauseAtFavoritePois: boolean;
  /**
   * Per-POI pause durations (in minutes). Displayed in the expanded grid
   * below the "Ajouter des pauses à chaque POI favori" toggle (Figma
   * 1695:22638 Variant2). A value of `null` means the user has unchecked
   * that POI category — it still appears in the grid (greyed out) but is
   * excluded from routing. Keys mirror `PoiCategory`.
   */
  poiPauseDurations: Record<PoiCategory, number | null>;
  /**
   * Master toggle for "pauses par interval". When false the rows are kept in
   * `pauseIntervals` but the routing engine ignores them. When true and the
   * list is empty, the section auto-creates a single default row.
   */
  pauseEveryIntervalEnabled: boolean;
  /**
   * @deprecated kept for backward compatibility with previously-saved
   * projects that only stored a single "every N minutes" value. New code
   * should rely on `pauseIntervals`.
   */
  pauseEveryIntervalMin: number | null;
  /** User-defined pause rows displayed when the master toggle is on. */
  pauseIntervals: PauseIntervalRow[];
  /** Per-generated-pause distance overrides keyed by pause id. */
  pausePositionOverridesKm: Record<string, number>;
}

export type TimelineItemKind =
  | 'start'
  | 'end'
  | 'waypoint'
  | 'water'
  | 'supermarket'
  | 'poi'
  | 'pause';

export type TimelineAddItemKind =
  | 'step'
  | 'waypoint'
  | 'poi'
  | 'pause'
  | 'start'
  | 'end';

export interface TimelineAddItemOptions {
  distanceKm?: number;
}

export interface TimelineItem {
  id: string;
  kind: TimelineItemKind;
  label: string;
  /** Distance from start in km. */
  distanceKm: number | null;
  /** For pause: duration in minutes. */
  durationMin?: number;
  favorite?: boolean;
  visible?: boolean;
  /** Synthetic rows derived from another source and not directly persisted in timeline. */
  autoGenerated?: 'intervalPause';
  /** Geo coordinates once the user has resolved a place via search. */
  lat?: number;
  lon?: number;
  /**
   * For `kind: 'poi'` items injected by the corridor search — the panel
   * POI category, used by `KindBadge` to render the right teardrop pin
   * and by `kindLabel` to display the sub-category name (Eau, Boulangerie…).
   */
  poiCategory?: PoiCategory;
  /** Stable OSM id of the source feature, when the row was injected by POI search. */
  osmId?: number;
}

export type TimelineView = 'sheet' | 'timeline';

/**
 * Configuration for the "Timeline" (vertical km-rail) view.
 *
 * The rail is a stack of fixed-height rows, each representing `kmPerRow`
 * kilometres. Items are absolutely positioned on top of the rail at a
 * pixel offset of `(distanceKm / kmPerRow) * rowHeightPx`.
 */
export interface TimelineRailConfig {
  /** Kilometres represented by each row. Defaults to 10. */
  kmPerRow: number;
  /** Pixel height of a single row. Defaults to 32. */
  rowHeightPx: number;
}

export const DEFAULT_TIMELINE_RAIL: TimelineRailConfig = {
  kmPerRow: 10,
  rowHeightPx: 32,
};

/** How an itinerary's polyline is colorised on the map (right-panel control). */
export type RouteRenderMode = 'default' | 'slope' | 'speedEst';

/**
 * Computed metrics persisted on the itinerary after a successful BRouter
 * routing run. All values are optional — when absent the synth row
 * displays "--". Distance is also kept on the timeline "end" row for
 * backward compatibility with previously-saved projects.
 */
export interface ItineraryMetrics {
  distanceKm?: number;
  /** Moving / cumulative duration in seconds. Not yet wired. */
  durationSec?: number;
  ascentM?: number;
  descentM?: number;
  /** Average slope in percent (positive). */
  avgSlopePercent?: number;
  /** Tarmac vs off-road share (each 0–100). */
  tarmacPercent?: number;
  offroadPercent?: number;
}

export interface ItineraryRouteAuditFinding {
  id: string;
  kind: 'hikeabike' | 'restricted' | 'steep';
  title: string;
  detail: string;
  coordinates: [number, number][];
}

export interface ItineraryRouteAuditState {
  visible?: boolean;
  findings: ItineraryRouteAuditFinding[];
}

export interface ItineraryPendingTraceExtension {
  from: {
    lat: number;
    lon: number;
  };
  to: {
    lat: number;
    lon: number;
  };
}

export interface ItineraryPendingRoutePatch {
  start: {
    lat: number;
    lon: number;
    kind: 'start' | 'waypoint';
  };
  end: {
    lat: number;
    lon: number;
    kind: 'waypoint' | 'end';
  };
  via: Array<{
    lat: number;
    lon: number;
  }>;
}

export interface ItineraryForbiddenZonePoint {
  lat: number;
  lon: number;
}

export interface ItineraryForbiddenZone {
  id: string;
  points: ItineraryForbiddenZonePoint[];
  createdAt: string;
}

export interface ItineraryFitUpload {
  name: string;
  type: string;
  lastModified: number;
  size: number;
  path?: string;
  /** Legacy inline payload kept only so older saved projects still hydrate. */
  base64?: string;
}

export interface ItinerarySplitRelation {
  parentItineraryId: string;
  rootItineraryId: string;
  startDistanceKm: number;
  depth: number;
}

export interface Itinerary {
  id: string;
  name: string;
  color: string;
  profileId: string;
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  rhythm: RhythmState;
  poi: PoiState;
  timeline: TimelineItem[];
  /** Map render visibility (right-panel "eye" toggle). Defaults to true. */
  visible?: boolean;
  /** Bottom analysis chart visibility (center summary "eye" toggle). Defaults to true. */
  analysisVisible?: boolean;
  /** Right-panel polyline render mode. Defaults to 'default'. */
  renderMode?: RouteRenderMode;
  /** Right-panel opacity slider (0–100). Defaults to 100. */
  opacity?: number;
  /**
   * Hierarchical split metadata used to render child traces as a continuation
   * of their parent on the center summary and analysis chart.
   */
  splitRelation?: ItinerarySplitRelation;
  /** Computed metrics shown in the center synth table. */
  metrics?: ItineraryMetrics;
  /**
   * Optional GPX track loaded for this itinerary. When present, the POI
   * search runs in "corridor" mode along these points instead of bbox mode.
   *
   * `source: 'brouter'` means the polyline was synthesised from a BRouter
   * computation (no user GPX upload) — in that case the route is already
   * rendered by the BRouter layer and `useItineraryPoiMap` skips its own
   * GPX rendering to avoid drawing two stacked lines.
   */
  gpxRoute?: {
    name: string | null;
    points: {
      lat: number;
      lon: number;
      distanceM?: number;
      elevationM?: number | null;
      gradientPct?: number | null;
      surface?: Surface;
    }[];
    source?: 'gpx' | 'brouter';
    originalPoints?: {
      lat: number;
      lon: number;
      distanceM?: number;
      elevationM?: number | null;
      gradientPct?: number | null;
      surface?: Surface;
    }[];
    gpxQuality?: GpxQualityMode;
    gpxQualityPointsPerKm?: number | null;
  };
  /**
   * Expert Mode profile state. When `enabled`, every parameter the user
   * has changed is sent to BRouter as a `profile:xxx` URL override on top
   * of the active preset. Defaults to a disabled state with stock values
   * mirroring `trekking.brf`.
   */
  expertProfile?: ExpertProfileState;
  /**
   * Latest successful FIT prediction result for this itinerary. Persisted
   * on the project so reopening it restores the analysis chart without
   * having to re-run the (expensive) prediction. Null / undefined means
   * no prediction has been computed yet.
   */
  prediction?: PredictionResult | null;
  /**
   * POI features rendered on the map for this itinerary, persisted so
   * that closing/reopening the project restores the icons without the
   * user having to click "Charger" again. Populated by the corridor
   * search; empty/undefined means no search has been run yet.
   */
  poiFeatures?: PoiFeature[];
  /** BRouter-backed rideability audit findings for this itinerary. */
  routeAudit?: ItineraryRouteAuditState;
  /** Persisted no-go polygons sent to BRouter as absolute forbidden areas. */
  forbiddenZones?: ItineraryForbiddenZone[];
  /** Persisted FIT uploads used as prediction history for this itinerary. */
  fitUploads?: ItineraryFitUpload[];
  /** Pending tail-segment append produced by the tracer subtool. */
  pendingTraceExtension?: ItineraryPendingTraceExtension;
  /** Pending local reroute patch for waypoint edits/removals. */
  pendingRoutePatch?: ItineraryPendingRoutePatch;
  /** Internal flag to auto-run FIT timing again once the route is ready. */
  pendingFitRecompute?: boolean;
}

export interface ItineraryProject {
  name: string;
  /** Null when the project has never been saved. */
  savedAt: string | null;
  /** Bytes of the saved project, null if not yet saved. */
  sizeBytes: number | null;
  privacy: 'private' | 'public';
  itineraries: Itinerary[];
  activeItineraryId: string;
  activeMode: PanelMode;
  timelineView: TimelineView;
  /** Persisted UI state for the right-side control panel. */
  controlPanel?: ControlPanelPersistedState;
  /** Persisted UI state for the bottom analysis chart. */
  analysis?: AnalysisPanelState;
  /** Persisted dashboard chrome + map viewport. */
  dashboard?: {
    rightPanelWidth?: number;
    leftPanelWidth?: number;
    centerPanelHeight?: number | null;
    lidarDownloadModeEnabled?: boolean;
    mapViewport?: {
      center: [number, number];
      zoom: number;
      pitch: number;
      bearing: number;
    };
  };
}

export interface ItineraryPanelProps {
  project: ItineraryProject;
  profiles: RouteProfile[];
  className?: string;
  width?: number;
  onResizeStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;
  isReturningToBrowser?: boolean;

  // project-level
  onBackToHome?: () => void;
  onSaveProject?: () => void;
  onDownloadProject?: () => void;
  onShareProject?: () => void;
  onRenameProject?: (next: string) => void;

  // itineraries
  onSelectItinerary?: (id: string) => void;
  onAddItinerary?: () => void;
  onAddButtonRef?: (element: HTMLButtonElement | null) => void;
  /**
   * Open the "Nouvel itinéraire" picker (from-scratch vs from-GPX).
   * If wired, replaces `onAddItinerary` UX in the tab bar.
   */
  onOpenAddItinerary?: () => void;
  /**
   * Add a brand-new itinerary loaded from a GPX file.
   * The container is expected to call `parseGpxFile()` and store the route.
   */
  onAddItineraryFromGpx?: (file: File) => Promise<void> | void;
  /** Duplicate an itinerary by id. */
  onDuplicateItinerary?: (id: string) => void;
  /** Remove an itinerary by id. The container should refuse if it's the last one. */
  onRemoveItinerary?: (id: string) => void;
  /** Inline-rename an itinerary from its tab. */
  onRenameItinerary?: (id: string, name: string) => void;
  /** Toggle visibility of an itinerary. */
  onToggleItineraryVisibility?: (id: string) => void;

  // mode tabs
  onChangeMode?: (mode: PanelMode) => void;

  // profile bar
  onChangeProfile?: (profileId: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onSaveProfile?: () => void;
  /** Open the Expert Mode profile editor modal. */
  onOpenExpertEditor?: () => void;
  /** Whether Expert Mode is currently enabled for the active itinerary. */
  expertEnabled?: boolean;

  // tracage
  onChangePriority?: (key: keyof PrioritiesState, value: number) => void;
  onChangeRoadType?: <K extends keyof RoadTypesState>(
    key: K,
    value: RoadTypesState[K],
  ) => void;
  onRefreshRoute?: () => void;
  onCancelRoute?: () => void;

  // rythme
  onChangeRhythm?: <K extends keyof RhythmState>(key: K, value: RhythmState[K]) => void;
  onUploadFit?: () => void;
  uploadFitLabel?: string;
  onCalculate?: () => void;
  onCancelCalculate?: () => void;
  calculateLabel?: string;
  calculateDisabled?: boolean;

  // poi
  onChangePoiEntry?: (category: PoiCategory, next: PoiEntry) => void;
  onChangePoiRefine?: (value: boolean) => void;
  onChangePoiRefineLimit?: (value: 2 | 4 | 6) => void;
  onOpenPoiCategories?: () => void;
  onLoadPois?: () => void;
  onCancelLoadPois?: () => void;
  /** Map-level POI loading state (corridor / viewport fetch). */
  poiLoading?: boolean;
  /** 0..1 progress for the chunked corridor search (null when idle). */
  poiProgress?: number | null;
  /** Number of POIs currently rendered on the map. */
  poiCount?: number;
  /** Last error from the POI engine (Overpass / network). */
  poiError?: string | null;
  /** Disable the "Charger" button (e.g. no GPX route attached). */
  poiLoadDisabled?: boolean;
  /** Optional helper text rendered when the load button is disabled. */
  poiLoadDisabledReason?: string | null;

  // timeline
  onChangeTimelineView?: (view: TimelineView) => void;
  onAddTimelineItem?: (kind: TimelineAddItemKind, options?: TimelineAddItemOptions) => void;
  onToggleTimelineItem?: (id: string, visible: boolean) => void;
  onMoveTimelinePause?: (id: string, distanceKm: number) => void;
  onChangeTimelinePauseDuration?: (id: string, durationMin: number) => void;
  onRemoveTimelineItem?: (id: string) => void;
  onFavoriteTimelineItem?: (id: string, favorite: boolean) => void;
  onSearchTimeline?: () => void;
  onOpenTimelineSettings?: () => void;

  /**
   * Called when the user picks a geocoded place for a timeline row
   * (typically Départ / Fin). The container persists the lon/lat on the
   * row and triggers a BRouter recompute when both endpoints are set.
   */
  onSelectTimelinePlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;

  /** True while a BRouter request is in-flight. */
  routeLoading?: boolean;
  /** Last BRouter error, if any. */
  routeError?: string | null;
  /**
   * Smart-validator messages for the active itinerary's road-type
   * filters (e.g. "tout interdit → on relâche les voies cyclables"). Empty
   * array when the user's selection is internally consistent.
   */
  routeWarnings?: string[];
}
