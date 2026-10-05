import type { Dispatch, ReactNode, SetStateAction } from 'react';

import type {
  GpxQualityMode,
  Itinerary,
  ItineraryForbiddenZone,
  ItineraryProject,
  RouteRenderMode,
} from '../../types';
import type { MergeItineraryConnectorSegment, MergeItineraryProjectResult, SplitItineraryProjectResult } from '../../lib/project';
import type { DerivedComputeGate, ProjectCollabLink } from './collab';

/**
 * Identity of a copy already made elsewhere (LiDAR viewer), so both sides keep
 * referring to the same itinerary.
 */
export interface DuplicateItineraryOverrides {
  id?: string;
  name?: string;
  color?: string;
  visible?: boolean;
}

export interface TraceHistoryEntry {
  itineraryId: string;
  before: ItineraryProject;
  after: ItineraryProject;
}

export interface ProjectStoreValue {
  project: ItineraryProject;
  /**
   * Modification utilisateur : tout changement du document (itinéraires) est
   * enregistré dans l'historique undo/redo (rafales regroupées).
   */
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  /**
   * Écriture en arrière-plan (résultat async dérivé : routage, altimétrie,
   * POI, prédiction…). Jamais enregistrée, ne vide jamais « Rétablir ».
   */
  setProjectWithoutHistory: Dispatch<SetStateAction<ItineraryProject>>;
  undoTraceEdit: () => void;
  redoTraceEdit: () => void;
  canUndoTraceEdit: boolean;
  canRedoTraceEdit: boolean;
  /**
   * Incrémenté à chaque restauration d'historique (undo / redo / rollback).
   * Les traitements async (routage, recalcul) l'observent pour abandonner
   * leurs requêtes en vol et ne jamais recalculer un tracé restauré.
   */
  historyRevision: number;
  /**
   * Incrémenté quand des modifications d'autres éditeurs sont appliquées
   * (co-édition). Les traitements dérivés (routage…) revérifient alors les
   * résultats stockés par leur estampille au lieu de recalculer.
   */
  externalRevision: number;
  /** Qui calcule les résultats dérivés (toujours cet appareil hors session). */
  derivedComputeGate: DerivedComputeGate;
  /** Une session de co-édition est ouverte sur ce projet. */
  collabActive: boolean;
  /**
   * Applique une mutation au projet en l'enregistrant dans l'historique undo/redo.
   * Retourne `false` si la mutation a été déclarée sans effet (aucune entrée créée).
   */
  commitTraceMutation: (
    itineraryId: string,
    mutate: (draft: ItineraryProject) => boolean | void,
  ) => boolean;
  rollbackPendingTraceAppend: (itineraryId: string) => boolean;
  addItinerary: (overrides?: Partial<Itinerary>) => string | null;
  updateItinerary: (
    id: string,
    mut: (draft: ItineraryProject['itineraries'][number]) => void,
  ) => void;
  /** Variante hors historique, pour les compléments async d'une action. */
  updateItineraryWithoutHistory: (
    id: string,
    mut: (draft: ItineraryProject['itineraries'][number]) => void,
  ) => void;
  setItineraryName: (id: string, name: string) => void;
  setItineraryColor: (id: string, color: string) => void;
  setItineraryVisibility: (id: string, visible: boolean) => void;
  setItineraryAnalysisVisibility: (id: string, visible: boolean) => void;
  setItineraryRenderMode: (id: string, mode: RouteRenderMode) => void;
  setItineraryOpacity: (id: string, opacity: number) => void;
  duplicateItinerary: (
    id: string,
    overrides?: DuplicateItineraryOverrides,
  ) => { createdItineraryId: string; createdItineraryName: string } | null;
  removeItinerary: (id: string) => boolean;
  clearItineraryRoute: (id: string) => void;
  reverseItineraryGpx: (id: string) => boolean;
  appendTracePoint: (
    id: string,
    point: { lat: number; lon: number; label: string },
  ) => boolean;
  addForbiddenZone: (
    id: string,
    points: Array<{ lat: number; lon: number }>,
  ) => ItineraryForbiddenZone | null;
  removeForbiddenZone: (
    id: string,
    options?: { zoneId?: string; point?: { lat: number; lon: number } },
  ) => boolean;
  simplifyItineraryGpx: (id: string, targetPointsPerKm: number) => void;
  changeItineraryGpxQuality: (
    id: string,
    quality: GpxQualityMode,
    options?: { pointsPerKm?: number | null },
  ) => void;
  cleanItineraryGpxGlitches: (id: string) => void;
  mergeItineraries: (
    sourceId: string,
    targetId: string,
    options?: { connector?: MergeItineraryConnectorSegment },
  ) => Omit<MergeItineraryProjectResult, 'project'> | null;
  splitItineraryAtPointIndex: (
    id: string,
    splitIndex: number,
  ) => Omit<SplitItineraryProjectResult, 'project'> | null;
  updateItineraryRoutePoints: (
    id: string,
    points: Array<{ lat: number; lon: number; elevationM?: number | null; distanceM?: number }>,
    options?: { source?: string; actionName?: string },
  ) => boolean;
}

export interface ProjectProviderProps {
  initialProject?: ItineraryProject;
  onProjectChange?: (project: ItineraryProject) => void;
  /** Session de co-édition ouverte sur ce projet (null : seul sur le projet). */
  collab?: ProjectCollabLink | null;
  children: ReactNode;
}