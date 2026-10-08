import type { SportDiscipline } from '@/shared/lib/discipline';
import type { PoiAutoSortSummary, PoiCategory, PoiEntry } from './poi';
import type { ItineraryProject, PanelMode, ProjectSaveStatus } from './project';
import type { RhythmState } from './rhythm';
import type { PrioritiesState, RoadTypesState, RouteProfile, SavedCustomProfile } from './routing';
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
  /** Cet utilisateur : sa pastille ouvre « Présenter ma vue ». */
  isSelf?: boolean;
  /** Je suis cet éditeur (mode observation) ; pour moi-même : je présente ma vue. */
  followed?: boolean;
  /** Il présente sa vue (Spotlight). */
  presenting?: boolean;
  /** Il me suit. */
  followsMe?: boolean;
}

/** Action sur une pastille d'éditeur (comme Figma) : le suivre, ou présenter sa propre vue. */
export type CollaboratorAction = 'follow' | 'unfollow' | 'spotlight-start' | 'spotlight-stop';

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

  // niveau projet
  onBackToHome?: () => void;
  /** Enregistrement explicite du projet (bouton Enregistrer de l'en-tête). */
  onSaveProject?: () => void;
  saveStatus?: ProjectSaveStatus;
  /** Détail (déjà traduit) de l'état d'enregistrement : erreur, attente hors-ligne. */
  saveStatusMessage?: string;
  /** « Partager » de l'en-tête (co-édition) ; reçoit le bouton (échelle de la pop-in). */
  onShareProject?: (anchor: HTMLElement) => void;
  /** Éditeurs présents sur le projet (co-édition), cet utilisateur compris. */
  collaborators?: ProjectCollaborator[];
  /** Clic sur une pastille : suivre l'éditeur, ou présenter sa vue (sa propre pastille). */
  onCollaboratorAction?: (userId: string, action: CollaboratorAction) => void;
  /** État de la session de co-édition (absent hors session). */
  sessionStatus?: ProjectSessionStatus;
  onRenameProject?: (next: string) => void;

  // itineraries
  onSelectItinerary?: (id: string) => void;
  onAddItinerary?: () => void;
  onAddButtonRef?: (element: HTMLButtonElement | null) => void;
  /**
   * Ouvre le sélecteur « Nouvel itinéraire » (de zéro ou depuis un GPX).
   * S'il est branché, remplace l'expérience `onAddItinerary` dans la barre d'onglets.
   */
  onOpenAddItinerary?: () => void;
  /**
   * Ajoute un tout nouvel itinéraire chargé depuis un fichier GPX.
   * Le conteneur doit appeler `parseGpxFile()` et stocker le tracé.
   */
  onAddItineraryFromGpx?: (file: File) => Promise<void> | void;
  /**
   * Nom d'un fichier GPX en cours de parse, ou null. Tant qu'il est posé, la
   * liste des itinéraires affiche une ligne de chargement à la place qu'occupera
   * l'itinéraire parsé : l'utilisateur a un retour immédiat après avoir choisi le fichier.
   */
  pendingImportName?: string | null;
  /** Duplique un itinéraire par son id. */
  onDuplicateItinerary?: (id: string) => void;
  /** Supprime un itinéraire par son id. Le conteneur doit refuser si c'est le dernier. */
  onRemoveItinerary?: (id: string) => void;
  /** Renomme en place un itinéraire depuis son onglet. */
  onRenameItinerary?: (id: string, name: string) => void;
  /** Bascule la visibilité d'un itinéraire. */
  onToggleItineraryVisibility?: (id: string) => void;

  // onglets de mode
  onChangeMode?: (mode: PanelMode) => void;

  // barre de profil
  onChangeProfile?: (profileId: string) => void;
  /** Change le sport de l'itinéraire actif (vélo / trail / course). */
  onChangeDiscipline?: (discipline: SportDiscipline) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onSaveProfile?: (profile?: SavedCustomProfile) => void;
  onDeleteProfile?: (id: string) => void;
  /** Ouvre la fenêtre modale d'édition du profil du mode expert. */
  onOpenExpertEditor?: () => void;
  /** Indique si le mode expert est activé pour l'itinéraire actif. */
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
  /** Recalcule toute la trace GPX segment par segment via BRouter. */
  onRecalculateTrace?: () => void;
  /** Indique si le recalcul tourne. */
  recalculateLoading?: boolean;
  /** Progression du recalcul 0–1. */
  recalculateProgress?: number | null;
  /** Indique si le bouton de recalcul doit être affiché. */
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
  /** État de chargement des POI au niveau de la carte (requête couloir / vue). */
  poiLoading?: boolean;
  /** Progression 0..1 de la recherche par morceaux dans le couloir (null au repos). */
  poiProgress?: number | null;
  /** Nombre de POI actuellement affichés sur la carte. */
  poiCount?: number;
  /** Dernière erreur du moteur de POI (Overpass / réseau). */
  poiError?: string | null;
  /** Désactive le bouton « Charger » (par ex. aucun tracé GPX attaché). */
  poiLoadDisabled?: boolean;
  /** Texte d'aide optionnel affiché quand le bouton de chargement est désactivé. */
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
   * Appelé quand l'utilisateur choisit un lieu géocodé pour une ligne de
   * timeline (en général Départ / Fin). Le conteneur persiste le lon/lat sur la
   * ligne et déclenche un recalcul BRouter quand les deux extrémités sont posées.
   */
  onSelectTimelinePlace?: (
    id: string,
    place: { name: string; fullName: string; lat: number; lon: number },
  ) => void;

  /** Vrai pendant qu'une requête BRouter est en cours. */
  routeLoading?: boolean;
  /** Dernière erreur BRouter, s'il y en a une. */
  routeError?: string | null;
  /**
   * Messages du validateur intelligent pour les filtres de types de route de
   * l'itinéraire actif (par ex. « tout interdit → on relâche les voies
   * cyclables »). Tableau vide quand la sélection de l'utilisateur est cohérente.
   */
  routeWarnings?: string[];
}
