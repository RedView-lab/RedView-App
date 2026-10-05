import type { ControlPanelPersistedState } from '../../controlPanel/lib/persistedState';
import type { AnalysisPanelState } from './analysis';
import type { Itinerary } from './itinerary';
import type { SavedCustomProfile } from './routing';
import type { TimelineView } from './timeline';

// Projet (1..N itinéraires) et état d'enregistrement.

export type PanelMode = 'tracage' | 'rythme' | 'poi' | 'nutrition';

/**
 * Projet tel que l'interface le manipule : la composition de trois couches
 * (cf. `lib/project/layers.ts`) :
 *  - le document partagé (nom, itinéraires, profils de tracé référencés…),
 *    seul envoyé dans `projects.data` ;
 *  - la vue propre à chaque utilisateur (itinéraire et mode actifs, panneaux,
 *    vue carte, panneau de droite, graphe, affichage de chaque itinéraire),
 *    stockée à part (`project_views`) ;
 *  - le travail en attente sur cet appareil (`pending*` des itinéraires),
 *    jamais partagé.
 * Un nouveau champ va dans le document par défaut : un état d'affichage doit
 * être ajouté à `PROJECT_VIEW_KEYS` / `ITINERARY_VIEW_KEYS`.
 */
export interface ItineraryProject {
  name: string;
  /** Null when the project has never been saved. */
  savedAt: string | null;
  /** Bytes of the saved project, null if not yet saved. */
  sizeBytes: number | null;
  privacy: 'private' | 'public';
  itineraries: Itinerary[];
  /**
   * Document : copie des profils de tracé perso référencés par les
   * itinéraires (`profileId`), tenue à jour depuis la bibliothèque du compte à
   * chaque sauvegarde. Absent quand aucun profil perso n'est utilisé.
   */
  routingProfiles?: SavedCustomProfile[];
  /** Vue : itinéraire sélectionné. */
  activeItineraryId: string;
  /** Vue : mode du panneau itinéraire. */
  activeMode: PanelMode;
  /** Vue : feuille de route en tableau ou en frise. */
  timelineView: TimelineView;
  /** Vue : persisted UI state for the right-side control panel. */
  controlPanel?: ControlPanelPersistedState;
  /** Vue : persisted UI state for the bottom analysis chart. */
  analysis?: AnalysisPanelState;
  /** Vue : persisted dashboard chrome + map viewport. */
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
