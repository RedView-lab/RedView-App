import type { ExpertProfileState } from '../expert/types';
import type { Surface } from '../lib/route-metrics/types';
import type { PredictionResult } from '../../fitPredictor/types';
import type { PoiFeature } from '../../poi/types';
import type { SportDiscipline } from '@/shared/lib/discipline';
import type { GpxQualityMode } from './analysis';
import type { PoiAutoSortState, PoiState } from './poi';
import type { RhythmState } from './rhythm';
import type { PrioritiesState, RoadTypesState } from './routing';
import type { TimelineItem } from './timeline';

// Un itinéraire (variante de route) et ses données persistées.

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
  kind: 'hikeabike' | 'restricted' | 'steep' | 'technical';
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
    /**
     * Borne prise sur le tracé stocké (fenêtre locale autour de l'édition) :
     * sa distance le long du tracé, pour la retrouver sans ambiguïté sur une
     * boucle ou un aller-retour.
     */
    distanceM?: number;
  };
  end: {
    lat: number;
    lon: number;
    kind: 'waypoint' | 'end';
    /** Cf. `start.distanceM`. */
    distanceM?: number;
  };
  via: Array<{
    lat: number;
    lon: number;
  }>;
  /**
   * Fenêtre locale (cf. narrowRoutePatchToEdit) : `start` / `end` sont alors
   * des bornes provisoires prises sur le tracé stocké. Une borne que le
   * nouveau tracé ne rejoint pas déjà en suivant l'ancien est reculée, au plus
   * jusqu'aux bornes réelles ci-dessous : jamais de point de passage imposé.
   */
  window?: {
    /** Bornes réelles (lignes voisines de l'édition). */
    start: ItineraryPendingRoutePatch['start'];
    end: ItineraryPendingRoutePatch['end'];
    /** Portion du tracé stocké que l'édition invalide (m depuis le départ). */
    fromM: number;
    toM: number;
    /** Position déduite d'une projection (cf. RoutePatchEdit.projected). */
    projected: boolean;
  };
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

/** Niveau d'une alerte pente affichée sur la carte (menu « Type »). */
export type SteepAlertKind = 'alert' | 'warning' | 'info';

/** Réglage utilisateur d'une alerte pente, indexé par sa clé stable (milieu du tronçon). */
export interface ItinerarySteepAlertOverride {
  kind?: SteepAlertKind;
  ignored?: boolean;
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
  /**
   * Sport of this itinerary: drives the prediction engine, pace display and
   * the routing network (Trail / Running → pedestrian BRouter profile).
   */
  discipline?: SportDiscipline;
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
      /** Rugosité OSM (smoothness/tracktype) 1 bonne … 4 très mauvaise ; absente = inconnue. */
      roughness?: number;
      /**
       * Contexte de voie pour le moteur de temps (route-metrics/engineCodes.ts) :
       * type de voie, agglomération, feu au point ; absent = inconnu.
       */
      wayCode?: number;
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
    /**
     * Entrées de routage (points, profil, priorités, zones…) pour lesquelles
     * BRouter a produit ce tracé (`getRoutingInputsSignature`). Après un
     * undo/redo, un tracé dont l'estampille ne correspond plus aux entrées
     * restaurées (figé en plein recalcul) est recalculé ; sinon il fait foi.
     * Absent (anciens projets, GPX importé) = tracé considéré à jour.
     */
    routedInputsKey?: string;
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
  /**
   * Réglages (catégories cochées + distances X) de la dernière recherche POI
   * terminée : s'ils diffèrent des réglages courants, le panneau propose
   * « Relancer la recherche ». Voir `buildPoiSearchSignature`.
   */
  poiSearchSignature?: string;
  /**
   * Empreinte de la trace (`buildPoiRouteSignature`) sur laquelle les POI
   * enregistrés ont été cherchés : si la trace change, ils sont retirés et la
   * recherche relancée.
   */
  poiRouteSignature?: string;
  /** Toggle « Affiner les résultats » : le tri auto filtre les POI de la feuille de route. */
  poiAutoSortEnabled?: boolean;
  /** Dernier tri automatique des POI (POI retenus, bilan affiché dans la pop-in). */
  poiAutoSort?: PoiAutoSortState;
  /** BRouter-backed rideability audit findings for this itinerary. */
  routeAudit?: ItineraryRouteAuditState;
  /** Persisted no-go polygons sent to BRouter as absolute forbidden areas. */
  forbiddenZones?: ItineraryForbiddenZone[];
  /** Alertes pente reclassées ou ignorées par l'utilisateur (clé = `steepAlertKey`). */
  steepAlertOverrides?: Record<string, ItinerarySteepAlertOverride>;
  /** Persisted FIT uploads used as prediction history for this itinerary. */
  fitUploads?: ItineraryFitUpload[];
  /** Pending tail-segment append produced by the tracer subtool. */
  pendingTraceExtension?: ItineraryPendingTraceExtension;
  /** Pending local reroute patch for waypoint edits/removals. */
  pendingRoutePatch?: ItineraryPendingRoutePatch;
  /** Internal flag to auto-run FIT timing again once the route is ready. */
  pendingFitRecompute?: boolean;
  /**
   * True once the user has interacted with the "Rythme" mode (edited a field,
   * uploaded a FIT or clicked "Calculer"). The automatic prediction only runs
   * after that, so a freshly imported/drawn route has no speed/time estimate.
   */
  rhythmConfigured?: boolean;
}
