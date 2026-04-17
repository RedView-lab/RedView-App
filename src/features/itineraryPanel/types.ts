/**
 * Types for the left-dock Itinerary Panel (Figma nodes 1539:19209 / 1539:19715).
 *
 * The panel hosts an editable project with 1..n itineraries. Each itinerary
 * has four editing modes (Traçage, Rythme, POI, Nutrition) and a shared
 * timeline (Feuille de route) at the bottom.
 */

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
}

export interface RhythmState {
  /** ISO date (yyyy-mm-dd) or null when empty. */
  startDate: string | null;
  /** 24h time (HH:MM) or null when empty. */
  startTime: string | null;
  usePastActivities: boolean;
  ftp: number | null;
  systemWeightKg: number | null;
  tiresMm: number | null;
  useWeather: boolean;
  weatherWeight: number;
  useSurfaces: boolean;
  surfacesWeight: number;
  pauseAtFavoritePois: boolean;
  pauseEveryIntervalMin: number | null;
}

export type TimelineItemKind =
  | 'start'
  | 'end'
  | 'waypoint'
  | 'water'
  | 'supermarket'
  | 'pause';

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
}

export type TimelineView = 'sheet' | 'timeline';

export interface Itinerary {
  id: string;
  name: string;
  color: string;
  profileId: string;
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  rhythm: RhythmState;
  timeline: TimelineItem[];
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
}

export interface ItineraryPanelProps {
  project: ItineraryProject;
  profiles: RouteProfile[];
  className?: string;
  width?: number;
  onResizeStart?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  isResizing?: boolean;

  // project-level
  onClose?: () => void;
  onSaveProject?: () => void;
  onDownloadProject?: () => void;
  onShareProject?: () => void;
  onRenameProject?: (next: string) => void;

  // itineraries
  onSelectItinerary?: (id: string) => void;
  onAddItinerary?: () => void;

  // mode tabs
  onChangeMode?: (mode: PanelMode) => void;

  // profile bar
  onChangeProfile?: (profileId: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onSaveProfile?: () => void;

  // tracage
  onChangePriority?: (key: keyof PrioritiesState, value: number) => void;
  onChangeRoadType?: <K extends keyof RoadTypesState>(
    key: K,
    value: RoadTypesState[K],
  ) => void;

  // rythme
  onChangeRhythm?: <K extends keyof RhythmState>(key: K, value: RhythmState[K]) => void;
  onUploadFit?: () => void;
  onCalculate?: () => void;

  // timeline
  onChangeTimelineView?: (view: TimelineView) => void;
  onAddTimelineItem?: () => void;
  onToggleTimelineItem?: (id: string, visible: boolean) => void;
  onRemoveTimelineItem?: (id: string) => void;
  onFavoriteTimelineItem?: (id: string, favorite: boolean) => void;
  onSearchTimeline?: () => void;
  onOpenTimelineSettings?: () => void;
}
