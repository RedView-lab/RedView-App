import type { ControlPanelPersistedState } from '../../controlPanel/lib/persistedState';
import type { AnalysisPanelState } from './analysis';
import type { Itinerary } from './itinerary';
import type { TimelineView } from './timeline';

// Projet (1..N itinéraires) et état d'enregistrement.

export type PanelMode = 'tracage' | 'rythme' | 'poi' | 'nutrition';

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

/** `pending` : modifications conservées localement, synchronisation cloud en attente (hors-ligne). */
export type ProjectSaveStatus = 'idle' | 'saving' | 'saved' | 'pending' | 'error';
