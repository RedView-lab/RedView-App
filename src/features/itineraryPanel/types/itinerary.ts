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

/** Comment la polyligne d'un itinéraire est colorée sur la carte (réglage du panneau de droite). */
export type RouteRenderMode = 'default' | 'slope' | 'speedEst';

/**
 * Métriques calculées persistées sur l'itinéraire après une passe de routage
 * BRouter réussie. Toutes les valeurs sont optionnelles — absentes, la ligne de
 * synthèse affiche « -- ». La distance est aussi gardée sur la ligne « end » de
 * la timeline pour la compatibilité avec les projets enregistrés auparavant.
 */
export interface ItineraryMetrics {
  distanceKm?: number;
  /** Durée en mouvement / cumulée en secondes. Pas encore branchée. */
  durationSec?: number;
  ascentM?: number;
  descentM?: number;
  /** Pente moyenne en pourcentage (positive). */
  avgSlopePercent?: number;
  /** Part bitume / hors bitume (chacune 0–100). */
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
  /** Ancienne charge en ligne gardée seulement pour que les anciens projets enregistrés s'hydratent encore. */
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
   * Sport de cet itinéraire : pilote le moteur de prédiction, l'affichage de
   * l'allure et le réseau de routage (trail / course → profil BRouter piéton).
   */
  discipline?: SportDiscipline;
  priorities: PrioritiesState;
  roadTypes: RoadTypesState;
  rhythm: RhythmState;
  poi: PoiState;
  timeline: TimelineItem[];
  /** Vue (par utilisateur) : map render visibility ("eye" toggle). Defaults to true. */
  visible?: boolean;
  /** Vue (par utilisateur) : bottom analysis chart visibility. Defaults to true. */
  analysisVisible?: boolean;
  /** Vue (par utilisateur) : right-panel polyline render mode. Defaults to 'default'. */
  renderMode?: RouteRenderMode;
  /** Vue (par utilisateur) : right-panel opacity slider (0–100). Defaults to 100. */
  opacity?: number;
  /**
   * Métadonnées de découpe hiérarchique servant à afficher les traces enfants
   * comme la suite de leur parent dans le résumé central et le graphique d'analyse.
   */
  splitRelation?: ItinerarySplitRelation;
  /** Métriques calculées affichées dans le tableau de synthèse central. */
  metrics?: ItineraryMetrics;
  /**
   * Trace GPX optionnelle chargée pour cet itinéraire. Quand elle est présente,
   * la recherche de POI tourne en mode « couloir » le long de ces points au lieu
   * du mode emprise.
   *
   * `source: 'brouter'` signifie que la polyligne a été synthétisée par un
   * calcul BRouter (pas d'envoi de GPX par l'utilisateur) — le tracé est alors
   * déjà rendu par la couche BRouter et `useItineraryPoiMap` saute son propre
   * rendu GPX pour éviter de dessiner deux lignes empilées.
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
   * État du profil du mode expert. Quand `enabled`, chaque paramètre modifié par
   * l'utilisateur est envoyé à BRouter en surcharge d'URL `profile:xxx`
   * par-dessus le préréglage actif. Par défaut, un état désactivé avec les
   * valeurs d'origine de `trekking.brf`.
   */
  expertProfile?: ExpertProfileState;
  /**
   * Dernier résultat de prédiction FIT réussi pour cet itinéraire. Persisté sur
   * le projet pour que sa réouverture restaure le graphique d'analyse sans
   * relancer la prédiction (coûteuse). Null / undefined signifie qu'aucune
   * prédiction n'a encore été calculée.
   */
  prediction?: PredictionResult | null;
  /**
   * Estampille des entrées de `prediction` (`buildPredictionStamp` : tracé,
   * discipline, rythme, fichiers .fit) : une prédiction qui la porte encore
   * est à jour, personne ne la recalcule (ni à la réouverture, ni chez un
   * autre éditeur). Absente sur les prédictions antérieures.
   */
  predictionInputsKey?: string;
  /**
   * Éléments POI affichés sur la carte pour cet itinéraire, persistés pour que
   * fermer/rouvrir le projet restaure les icônes sans que l'utilisateur ait à
   * recliquer sur « Charger ». Remplis par la recherche dans le couloir ;
   * vide/undefined signifie qu'aucune recherche n'a encore été lancée.
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
  /** Constats de l'audit de praticabilité de cet itinéraire, appuyé sur BRouter. */
  routeAudit?: ItineraryRouteAuditState;
  /** Polygones interdits persistés, envoyés à BRouter comme zones absolument interdites. */
  forbiddenZones?: ItineraryForbiddenZone[];
  /** Alertes pente reclassées ou ignorées par l'utilisateur (clé = `steepAlertKey`). */
  steepAlertOverrides?: Record<string, ItinerarySteepAlertOverride>;
  /** Envois FIT persistés servant d'historique de prédiction pour cet itinéraire. */
  fitUploads?: ItineraryFitUpload[];
  /**
   * Travail local (jamais dans le document partagé, cf. `lib/project/layers.ts`) :
   * prolongement du tracé en attente, produit par l'outil Tracer.
   */
  pendingTraceExtension?: ItineraryPendingTraceExtension;
  /** Travail local : patch de reroutage local en attente pour les modifications/suppressions d'étapes. */
  pendingRoutePatch?: ItineraryPendingRoutePatch;
  /** Travail local : relancer automatiquement le chronométrage FIT une fois le tracé prêt. */
  pendingFitRecompute?: boolean;
  /**
   * Vrai dès que l'utilisateur a interagi avec le mode « Rythme » (modifié un
   * champ, envoyé un FIT ou cliqué sur « Calculer »). La prédiction automatique
   * ne tourne qu'après : un tracé fraîchement importé/dessiné n'a pas
   * d'estimation de vitesse/de temps.
   */
  rhythmConfigured?: boolean;
}
