/**
 * Ce que voit une personne non technique dans Umami : chaque événement, chaque
 * propriété et chaque valeur en français courant (« Parcours exporté vers le
 * GPS — format : GPX » plutôt que `route_exported {format: gpx}`). Le code garde
 * ses noms typés (events.ts) ; la traduction se fait au départ, dans le
 * before-send, et les rapports versionnés (scripts/analytics/umami/spec.ts) passent par
 * les mêmes tables. Changer un libellé = un nouvel événement pour Umami
 * (l'historique de l'ancien nom ne s'y rattache pas) : à éviter une fois en prod.
 *
 * Module sans import de l'app (lu aussi par les scripts sous tsx).
 */

import type { AnalyticsEvent } from './events';

type EventName = AnalyticsEvent['name'];
type DisplayValue = string | number;

/** Nom affiché de chaque événement (≤ 50 caractères, limite d'Umami). */
export const EVENT_LABELS: Record<EventName, string> = {
  signup_completed: 'Inscription réussie',
  login_completed: 'Connexion réussie',
  auth_failed: 'Échec de connexion ou d’inscription',
  password_reset_requested: 'Mot de passe oublié : demande',
  password_reset_completed: 'Mot de passe réinitialisé',
  logout: 'Déconnexion',
  theme_changed: 'Thème d’affichage changé',
  language_changed: 'Langue changée',
  feedback_opened: 'Formulaire d’avis ouvert',
  account_data_exported: 'Données du compte téléchargées',
  account_deleted: 'Compte supprimé',
  checkout_started: 'Paiement commencé',
  checkout_completed: 'Paiement confirmé',
  project_created: 'Projet créé',
  project_opened: 'Projet rouvert',
  project_deleted: 'Projet supprimé',
  shared_project_left: 'Projet partagé quitté',
  project_duplicated: 'Projet dupliqué',
  folder_created: 'Dossier créé',
  project_file_exported: 'Projet exporté en fichier .redview',
  project_file_imported: 'Projet importé depuis un fichier',
  editor_ready: 'Carte 3D prête (temps d’ouverture)',
  itinerary_added: 'Itinéraire ajouté',
  gpx_imported: 'Trace GPX importée',
  route_calculated: 'Itinéraire calculé',
  route_failed: 'Calcul d’itinéraire raté',
  route_editing_summary: 'Bilan des retouches du tracé',
  route_exported: 'Parcours exporté vers le GPS',
  route_action: 'Action sur le tracé',
  map_tool_selected: 'Outil de carte choisi',
  layer_toggled: 'Couche de carte allumée ou éteinte',
  basemap_changed: 'Fond de carte changé',
  freecam_entered: 'Caméra libre (vol) lancée',
  google_earth_opened: 'Vue ouverte dans Google Earth',
  place_selected: 'Lieu recherché puis choisi',
  map_filter_toggled: 'Filtre de carte basculé',
  context_menu_action: 'Clic droit sur la carte : action',
  poi_favorited: 'Point d’intérêt mis en favori',
  roadbook_tab_opened: 'Onglet de la feuille de route ouvert',
  fit_uploaded: 'Sorties FIT importées',
  pace_prediction_run: 'Prédiction du temps de parcours',
  flyover_played: 'Survol 3D lancé',
  flyover_finished: 'Survol 3D arrêté',
  flyover_video_exported: 'Vidéo du survol 3D exportée',
  lidar_tile_downloaded: 'Tuile LiDAR téléchargée',
  lidar_viewer_opened: 'Viewer LiDAR ouvert',
  lidar_tool_used: 'Outil du viewer LiDAR utilisé',
  snow_mode_enabled: 'Mode neige activé (LiDAR)',
  gpu_context_lost: 'Plantage de la carte graphique (LiDAR)',
  share_dialog_opened: 'Fenêtre de partage ouverte',
  share_invite_sent: 'Invitation envoyée',
  share_invite_failed: 'Invitation ratée',
  collab_session_joined: 'Session à plusieurs rejointe',
  comment_created: 'Commentaire posé',
  comment_replied: 'Réponse à un commentaire',
  comment_resolved: 'Commentaire résolu',
  follow_started: 'Suivi de la vue d’un collègue',
  spotlight_started: 'Présentation de sa vue aux autres',
};

/** Nom affiché de chaque propriété. */
export const PROPERTY_LABELS: Record<string, string> = {
  surface: 'espace',
  plan: 'formule',
  account_age: 'ancienneté du compte',
  lang: 'langue de l’app',
  theme: 'thème',
  method: 'manière',
  step: 'étape',
  reason: 'cause',
  mode: 'mode',
  language: 'langue choisie',
  projects: 'projets',
  source: 'origine',
  last_saved: 'dernière modification',
  shared: 'projet partagé',
  from: 'depuis',
  outcome: 'résultat',
  files: 'fichiers',
  ms: 'durée (secondes)',
  cold: 'ouvert par un lien direct',
  itineraries: 'itinéraires',
  format: 'format',
  points: 'points GPS',
  kind: 'type de calcul',
  distance_km: 'distance (km)',
  elevation_m: 'dénivelé (m)',
  profile: 'profil de routage',
  routes: 'itinéraires retouchés',
  patches: 'retouches',
  scope: 'portée',
  action: 'action',
  tool: 'outil',
  layer: 'couche',
  enabled: 'allumé',
  basemap: 'fond de carte',
  filter: 'filtre',
  category: 'catégorie',
  tab: 'onglet',
  sport: 'sport',
  fit_files: 'sorties FIT',
  completed: 'part du parcours vue',
  duration: 'durée',
  territory: 'pays',
  engine: 'moteur 3D',
  tiles: 'tuiles',
  peers: 'personnes connectées',
  anchor: 'forme',
  on: 'sur',
  via: 'déclenché par',
  capped: 'arrêtée au délai de 12 s',
  waiting: 'encore en chargement',
};

const BOOLEAN_LABELS = { true: 'oui', false: 'non' } as const;

/** Valeurs affichées, par propriété ; une valeur absente de la table passe telle quelle. */
export const VALUE_LABELS: Record<string, Record<string, string>> = {
  surface: { app: 'Application', viewer: 'Viewer LiDAR' },
  plan: { demo: 'Bêta gratuite', monthly: 'Abonnement 1 mois', semiannual: 'Abonnement 6 mois', annual: 'Abonnement 1 an', unknown: 'Inconnue' },
  account_age: { d0: 'Jour de l’inscription', d1_7: 'Première semaine', d8_30: 'Premier mois', d30_plus: 'Plus d’un mois' },
  lang: { fr: 'Français', en: 'Anglais' },
  // Catégories jointes par « + » (lib/loadingDiagnostics.ts) : chacune est traduite.
  waiting: {
    dem: 'Relief', satellite: 'Satellite', basemap: 'Fond de carte', poi: 'POI', weather: 'Météo', route: 'Tracé',
    slope: 'Pente', altitude: 'Altitude', lidar: 'LiDAR', sunlight: 'Ensoleillement', other: 'Autre', none: 'Rien',
  },
  language: { fr: 'Français', en: 'Anglais' },
  theme: { light: 'Clair', dark: 'Sombre' },
  mode: { system: 'Comme le système', light: 'Clair', dark: 'Sombre', cover: 'Couverture neigeuse', thickness: 'Épaisseur de neige' },
  method: {
    email: 'E-mail',
    google: 'Google',
    blank: 'Itinéraire vierge',
    gpx: 'Trace GPX importée',
    lidar: 'Tracé dans le viewer LiDAR',
    duplicate: 'Copie d’un itinéraire',
    map: 'Clic droit sur la carte',
    poi: 'Depuis un point d’intérêt',
  },
  step: { login: 'Connexion', signup: 'Inscription', verification: 'Code reçu par e-mail', reset: 'Mot de passe oublié' },
  reason: {
    credentials: 'E-mail ou mot de passe refusé',
    exists: 'Compte déjà existant',
    rate_limited: 'Trop d’essais rapprochés',
    network: 'Problème de réseau',
    code: 'Code invalide',
    seam: 'Tracé impossible à raccorder',
    restricted: 'Point dans une zone interdite',
    not_mapped: 'Point loin de toute route ou chemin',
    no_route: 'Aucun chemin possible',
    timeout: 'Calcul trop long',
    out_of_zone: 'Hors de la zone couverte',
    other: 'Autre',
  },
  source: { blank: 'Projet vierge', import: 'Fichier importé' },
  last_saved: { today: 'Aujourd’hui', this_week: 'Cette semaine', this_month: 'Ce mois-ci', older: 'Il y a plus d’un mois', unknown: 'Inconnue' },
  from: { editor: 'Éditeur', browser: 'Gestionnaire de projets', map: 'Carte 3D', lidar: 'Viewer LiDAR' },
  outcome: { ok: 'Réussi', error: 'Raté', done: 'Terminée', cancelled: 'Annulée' },
  kind: { full: 'Itinéraire complet', patch: 'Retouche locale', extend: 'Prolongement du tracé' },
  profile: {
    road: 'Route',
    'gravel-default': 'Gravel',
    mtb: 'VTT',
    running: 'Course à pied',
    trail: 'Trail',
    custom: 'Profil personnalisé',
  },
  scope: { itinerary: 'Itinéraire affiché', all: 'Tous les itinéraires' },
  action: {
    undo: 'Annuler',
    redo: 'Rétablir',
    reverse: 'Inverser le sens',
    delete: 'Effacer le tracé',
    'copy-coordinates': 'Copier les coordonnées',
    'create-poi': 'Créer un point d’intérêt',
    'set-start': 'Placer le départ',
    'add-waypoint': 'Ajouter un point de passage',
    'set-finish': 'Placer l’arrivée',
    'delete-forbidden-zone': 'Supprimer une zone interdite',
    'add-comment': 'Commenter ici',
  },
  tool: {
    tracer: 'Tracer',
    split: 'Découper',
    merge: 'Fusionner',
    forbidden_zone: 'Zone interdite',
    chart_placement: 'Ajout sur le profil',
    comment: 'Commentaire',
    flyover: 'Survol 3D',
    lidar_select: 'Sélection LiDAR',
    distance: 'Mesure de distance',
    height: 'Hauteur et angle',
    area: 'Mesure de surface',
    profile: 'Profil en long',
    fall_line: 'Ligne de pente',
    viewshed: 'Zone visible',
    avalanche: 'Exposition aux avalanches',
    pin: 'Repère',
    look_around: 'Vue à 360°',
  },
  layer: {
    labels: 'Noms et libellés',
    contours: 'Courbes de niveau',
    slopes: 'Pentes',
    altitude: 'Altitude',
    weather: 'Météo',
    wind: 'Vent',
    snow: 'Neige',
    sunlight: 'Ensoleillement',
    routes: 'Itinéraires',
  },
  basemap: {
    satellite: 'Satellite',
    streets: 'Rues',
    osm: 'OpenStreetMap',
    topographic: 'Topographique',
    standard: 'Standard',
    light: 'Clair',
    dark: 'Sombre',
  },
  filter: { favoris: 'Favoris', pois: 'Points d’intérêt', waypoints: 'Points de passage', pauses: 'Pauses', alertes: 'Alertes', pente: 'Pente' },
  category: {
    fountains: 'Fontaines',
    toilets: 'Toilettes',
    supermarkets: 'Supermarchés',
    gasStations: 'Stations-service',
    bakeries: 'Boulangeries',
    fastFood: 'Restauration rapide',
    cafes: 'Cafés',
    bars: 'Bars',
    restaurants: 'Restaurants',
    bikeShops: 'Magasins de vélo',
    hotels: 'Hôtels',
    refuges: 'Refuges',
    passes: 'Cols',
    health: 'Santé',
    transport: 'Transports',
    other: 'Autre',
  },
  tab: { sheet: 'Feuille de route', agenda: 'Agenda' },
  sport: { bike: 'Vélo', trail: 'Trail', running: 'Course à pied' },
  format: { gpx: 'GPX', kml: 'KML', fit: 'FIT', landscape: 'Paysage 16:9', portrait: 'Portrait 9:16' },
  engine: { webgpu: 'WebGPU (le plus rapide)', webgl: 'WebGL 2 (compatibilité)', terrain: 'Terrain seul (secours)' },
  territory: { FXX: 'France', REU: 'La Réunion', CH: 'Suisse', NZ: 'Nouvelle-Zélande', JP: 'Japon', NL: 'Pays-Bas', BE: 'Belgique (Flandre)' },
  anchor: { point: 'Point', zone: 'Zone' },
  on: { map: 'Carte 3D', lidar: 'Viewer LiDAR' },
  via: { avatar: 'Clic sur son avatar', spotlight: 'Présentation lancée par lui' },
  completed: { '<25': 'Moins d’un quart', '25-50': 'Un quart à la moitié', '50-75': 'La moitié aux trois quarts', '75-99': 'Presque tout', '100': 'En entier' },
};

export function eventLabel(name: string): string | undefined {
  return (EVENT_LABELS as Record<string, string>)[name];
}

export function propertyLabel(key: string): string {
  return PROPERTY_LABELS[key] ?? key;
}

export function valueLabel(key: string, value: string | number | boolean): DisplayValue {
  if (typeof value === 'boolean') return BOOLEAN_LABELS[String(value) as 'true' | 'false'];
  // Durées mesurées en millisecondes, affichées en secondes (1 décimale).
  if (key === 'ms' && typeof value === 'number') return Math.round(value / 100) / 10;
  if (typeof value === 'number') return value;
  const table = VALUE_LABELS[key];
  // Liste de catégories « a+b » (waiting) : chaque partie traduite, « Relief + POI ».
  if (table && value.includes('+') && !(value in table)) {
    return value.split('+').map((part) => table[part] ?? part).join(' + ');
  }
  return table?.[value] ?? value;
}

/** Données d'un événement, en clés et valeurs lisibles (après le garde vie privée). */
export function toDisplayData(data: Record<string, string | number | boolean>): Record<string, DisplayValue> {
  const display: Record<string, DisplayValue> = {};
  for (const [key, value] of Object.entries(data)) display[propertyLabel(key)] = valueLabel(key, value);
  return display;
}
