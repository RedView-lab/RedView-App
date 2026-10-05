import type { SportDiscipline } from '@/shared/lib/discipline';
import type { PoiAutoSortSummary, PoiCategory, PoiEntry } from './poi';
import type { ItineraryProject, PanelMode, ProjectSaveStatus } from './project';
import type { RhythmState } from './rhythm';
import type { PrioritiesState, RoadTypesState, RouteProfile } from './routing';
import type {
  TimelineAddItemKind,
  TimelineAddItemOptions,
  TimelineFilterState,
  TimelineItem,
  TimelineView,
} from './timeline';

// Props du panneau d'itinéraire (callbacks fournis par le conteneur).

/** Éditeur présent sur un projet partagé (pastille de l'en-tête). */
export interface ProjectCollaborator {
  userId: string;
  name: string;
}

/** Session de co-édition : état du serveur attendu, en ligne, ou connexion coupée. */
export type ProjectSessionStatus = 'connecting' | 'online' | 'offline';

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
  /** Explicit project save (header Save button). */
  onSaveProject?: () => void;
  saveStatus?: ProjectSaveStatus;
  /** Détail (déjà traduit) de l'état d'enregistrement : erreur, attente hors-ligne. */
  saveStatusMessage?: string;
  /** « Partager » de l'en-tête (co-édition) ; reçoit le bouton (échelle de la pop-in). */
  onShareProject?: (anchor: HTMLElement) => void;
  /** Éditeurs présents sur le projet (co-édition), cet utilisateur compris. */
  collaborators?: ProjectCollaborator[];
  /** État de la session de co-édition (absent hors session). */
  sessionStatus?: ProjectSessionStatus;
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
  /**
   * Name of a GPX file currently being parsed, or null. While set, the
   * itinerary list shows a loading row in the position the parsed itinerary
   * will occupy, so the user gets immediate feedback after picking the file.
   */
  pendingImportName?: string | null;
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
  /** Change the sport of the active itinerary (bike / trail / running). */
  onChangeDiscipline?: (discipline: SportDiscipline) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onSaveProfile?: (profile?: any) => void;
  onDeleteProfile?: (id: string) => void;
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
  onBatchChangeRoadTypes?: (
    roadUpdates: Partial<RoadTypesState>,
    priorityUpdates?: Partial<PrioritiesState>,
  ) => void;
  onRefreshRoute?: () => void;
  onCancelRoute?: () => void;
  /** Recalculate the full GPX trace segment-by-segment via BRouter. */
  onRecalculateTrace?: () => void;
  /** Whether recalculation is running. */
  recalculateLoading?: boolean;
  /** Recalculation progress 0–1. */
  recalculateProgress?: number | null;
  /** Whether the recalculate button should be shown. */
  showRecalculateTrace?: boolean;

  // rythme
  onChangeRhythm?: <K extends keyof RhythmState>(key: K, value: RhythmState[K]) => void;
  onUploadFit?: () => void;
  /** Noms des .fit de référence chargés pour l'itinéraire actif. */
  fitFileNames?: string[];
  onRemoveFitFile?: (index: number) => void;
  onClearFitFiles?: () => void;
  onCalculate?: () => void;
  onCancelCalculate?: () => void;
  calculateLabel?: string;
  calculateDisabled?: boolean;
  /** Dernière erreur de prédiction, affichée sous le bouton d'action. */
  calculateError?: string | null;
  /** Avertissement non bloquant sur les .fit (fichiers écartés, envoi impossible). */
  fitNotice?: string | null;

  // poi
  onChangePoiEntry?: (category: PoiCategory, next: PoiEntry) => void;
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
  /** POI chargés avec d'autres catégories / distances que les réglages courants. */
  poiSearchStale?: boolean;
  /** Tri automatique (toggle « Affiner les résultats ») : ne garde dans la feuille de route que les POI retenus d'après des règles horaires. */
  poiAutoSortEnabled?: boolean;
  onTogglePoiAutoSort?: (enabled: boolean) => void;
  /** Rien à trier pour l'instant (pas de trace / de POI chargés, recherche en cours). */
  poiAutoSortDisabled?: boolean;
  /** Dernier tri auto de l'itinéraire actif (null = jamais lancé) ; `stale` si ses entrées ont changé. */
  poiAutoSort?: { summary: PoiAutoSortSummary; stale: boolean } | null;

  // timeline
  selectedTimelineIds?: string[];
  onSelectTimelineRow?: (id: string, item: TimelineItem) => void;
  onSelectionTimelineChange?: (selectedIds: string[]) => void;
  onChangeTimelineView?: (view: TimelineView) => void;
  onAddTimelineItem?: (kind: TimelineAddItemKind, options?: TimelineAddItemOptions) => void;
  onToggleTimelineItem?: (id: string, visible: boolean) => void;
  onMoveTimelinePause?: (id: string, distanceKm: number) => void;
  onChangeTimelinePauseDuration?: (id: string, durationMin: number) => void;
  onRemoveTimelineItem?: (id: string) => void;
  onFavoriteTimelineItem?: (id: string, favorite: boolean) => void;
  onSearchTimeline?: () => void;
  onOpenTimelineSettings?: () => void;
  globalFilters?: TimelineFilterState;

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
