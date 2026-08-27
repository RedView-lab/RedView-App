import type { Dispatch, ReactNode, SetStateAction } from 'react';

import type {
  GpxQualityMode,
  Itinerary,
  ItineraryForbiddenZone,
  ItineraryProject,
  RouteRenderMode,
} from '../../types';
import type { MergeItineraryConnectorSegment, MergeItineraryProjectResult, SplitItineraryProjectResult } from '../../lib/project';

export interface TraceHistoryEntry {
  itineraryId: string;
  before: ItineraryProject;
  after: ItineraryProject;
}

export interface ProjectStoreValue {
  project: ItineraryProject;
  setProject: Dispatch<SetStateAction<ItineraryProject>>;
  undoTraceEdit: () => void;
  redoTraceEdit: () => void;
  canUndoTraceEdit: boolean;
  canRedoTraceEdit: boolean;
  rollbackPendingTraceAppend: (itineraryId: string) => boolean;
  addItinerary: (overrides?: Partial<Itinerary>) => string | null;
  updateItinerary: (
    id: string,
    mut: (draft: ItineraryProject['itineraries'][number]) => void,
  ) => void;
  setItineraryName: (id: string, name: string) => void;
  setItineraryColor: (id: string, color: string) => void;
  setItineraryVisibility: (id: string, visible: boolean) => void;
  setItineraryAnalysisVisibility: (id: string, visible: boolean) => void;
  setItineraryRenderMode: (id: string, mode: RouteRenderMode) => void;
  setItineraryOpacity: (id: string, opacity: number) => void;
  duplicateItinerary: (id: string) => { createdItineraryId: string; createdItineraryName: string } | null;
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
  children: ReactNode;
}