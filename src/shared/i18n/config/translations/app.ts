import type { AppTranslationPair } from '../types';

export const appTranslationPairs: ReadonlyArray<AppTranslationPair> = [
  // ── Coquille de l'app / document ────────────────────────────────────────
  { fr: 'RedView — Cartographie 3D Haute Résolution & LiDAR Outdoor', en: 'RedView — High-Resolution 3D Mapping & Outdoor LiDAR' },
  { fr: 'Chargement du projet…', en: 'Loading project…' },
  { fr: 'Afficher le panneau gauche', en: 'Show left panel' },
  { fr: 'Masquer le panneau gauche', en: 'Hide left panel' },
  { fr: 'Épicerie', en: 'Convenience store' },
  { fr: 'Carte', en: 'Map' },
  { fr: 'Carte prête', en: 'Map ready' },

  // ── Écran d'authentification de dev ─────────────────────────────────────
  { fr: "Visualisation 3D haute résolution & calculs d'itinéraires en temps réel.", en: 'High-resolution 3D visualization & real-time route computation.' },
  { fr: "⚡ Accéder à l'application (Accès Démo Immédiat)", en: '⚡ Open the app (instant demo access)' },
  { fr: 'ou', en: 'or' },
  { fr: '← Revenir au site vitrine RedView (', en: '← Back to the RedView website (' },

  // ── Limite d'erreur globale ─────────────────────────────────────────────
  { fr: "Anomalie d'affichage 3D", en: '3D display issue' },
  { fr: "Une erreur inattendue est survenue dans le moteur graphique ou l'interface. Vous pouvez recharger l'application en toute sécurité.", en: 'An unexpected error occurred in the graphics engine or the interface. You can safely reload the app.' },
  { fr: "Recharger l'application", en: 'Reload the app' },
  { fr: 'Réinitialiser la vue et recharger', en: 'Reset the view and reload' },
  { fr: 'Détails techniques', en: 'Technical details' },

  // ── Paywall ─────────────────────────────────────────────────────────────
  { fr: "La facturation se fait désormais directement dans l'app RedView. Reconnectez-vous avec un compte où la démo est activée ou contactez le support si cet accès devrait encore être actif.", en: 'Billing now happens directly inside RedView App. Reconnect with a demo-enabled account or contact support if this access should still be active.' },
  { fr: "Actualiser l'accès", en: 'Refresh access' },

  // ── Feedback ────────────────────────────────────────────────────────────
  { fr: 'Donner un avis', en: 'Give feedback' },
  { fr: 'Donner un avis ou signaler un bug', en: 'Give feedback or report a bug' },

  // ── Projets / dossiers (outils partagés) ────────────────────────────────
  { fr: 'Nouveau dossier', en: 'New folder' },
  { fr: 'Le nom du dossier ne peut pas être vide', en: 'Folder name cannot be empty' },
  { fr: 'Le nom du projet ne peut pas être vide', en: 'Project name cannot be empty' },
  { fr: 'Non authentifié', en: 'Not authenticated' },
  { fr: 'IndexedDB indisponible dans cet environnement', en: 'IndexedDB not available in this environment' },

  // ── Navigateur de projets : cartes, compte ──────────────────────────────
  { fr: 'Modifier', en: 'Edit' },
  { fr: 'Impossible de mettre à jour le mot de passe.', en: 'Could not update the password.' },

  // ── Navigateur de projets : facturation ─────────────────────────────────
  { fr: 'Finaliser votre paiement', en: 'Complete your payment' },
  { fr: 'Validation...', en: 'Validating...' },
  { fr: 'Une erreur est survenue lors du chargement de la page de paiement', en: 'An error occurred while loading the payment page' },
  { fr: 'Erreur inattendue', en: 'Unexpected error' },
  { fr: "Date d'expiration", en: 'Expiration date' },
  { fr: 'Impossible de définir ce moyen de paiement par défaut.', en: 'Unable to set this payment method as default.' },
  { fr: 'Par défaut', en: 'Primary' },
  { fr: 'Définir par défaut', en: 'Set as default' },
  { fr: 'CARTE', en: 'CARD' },

  // ── État de la surcouche météo / vent ───────────────────────────────────
  { fr: 'Météo (VPS)', en: 'Weather (VPS)' },
  { fr: 'Préparation de la grille vent', en: 'Preparing the wind grid' },
  { fr: 'Aucune grille vent disponible', en: 'No wind grid available' },
  { fr: 'Vent {{date}} {{time}} {{cols}}×{{rows}}', en: 'Wind {{date}} {{time}} {{cols}}×{{rows}}' },
  { fr: 'Pause API {{seconds}} s avant nouvelle requête', en: 'API pause {{seconds}} s before the next request' },
  { fr: 'Champ de vent chargé', en: 'Wind field loaded' },
  { fr: 'Impossible de charger le vent', en: 'Unable to load wind' },
  { fr: 'Carte non prête, attente du chargement Mapbox', en: 'Map not ready, waiting for Mapbox to load' },
  { fr: "Échec de l'initialisation des particules de vent", en: 'Wind particle init failed' },
  { fr: 'Échec du chargement du vent', en: 'Wind fetch failed' },
  { fr: 'Rendu', en: 'Rendering' },
  { fr: 'Overlay prêt', en: 'Overlay ready' },
  { fr: 'Overlay VPS prêt', en: 'VPS overlay ready' },
  { fr: 'Chargement des prévisions', en: 'Loading forecasts' },
  { fr: 'Connexion serveur météo', en: 'Connecting to the weather server' },
  { fr: 'Préparation des cartes', en: 'Preparing maps' },
  { fr: 'Affichage {{layer}}', en: 'Displaying {{layer}}' },
  { fr: 'Tuile météo indisponible ({{layer}})', en: 'Weather tile unavailable ({{layer}})' },
  { fr: 'Données météo non disponibles sur le serveur', en: 'Weather data not available on the server' },
  { fr: 'Erreur chargement météo VPS', en: 'VPS weather loading error' },
  { fr: 'Récupération météo', en: 'Fetching weather' },
  { fr: 'Téléchargement données', en: 'Downloading data' },
  { fr: 'Erreur chargement météo', en: 'Weather loading error' },
  { fr: 'Synchronisation du style', en: 'Syncing map style' },
  { fr: 'Échec de la requête Open-Meteo', en: 'Open-Meteo fetch failed' },
  { fr: 'Préparation vent {{date}} {{time}} ({{cols}}×{{rows}})', en: 'Preparing wind {{date}} {{time}} ({{cols}}×{{rows}})' },
  { fr: 'Vent {{date}} {{time}} {{batch}}/{{total}}', en: 'Wind {{date}} {{time}} {{batch}}/{{total}}' },
  { fr: 'Vent {{date}} {{time}} {{batch}}/{{total}} via {{source}}', en: 'Wind {{date}} {{time}} {{batch}}/{{total}} via {{source}}' },
  { fr: 'Réutilisation du chargement vent en cours {{key}} ({{cols}}×{{rows}})', en: 'Reusing the wind load in progress {{key}} ({{cols}}×{{rows}})' },
  { fr: 'Échec de compilation du shader', en: 'Shader compilation failed' },
  { fr: "Échec de l'édition de liens du programme WebGL", en: 'Program link failed' },
  { fr: 'Open-Meteo 429 : trop de requêtes', en: 'Open-Meteo 429: Too Many Requests' },
  { fr: 'Open-Meteo a renvoyé une réponse vide', en: 'Open-Meteo returned an empty response' },

  // ── Panneau de contrôle ─────────────────────────────────────────────────
  { fr: 'Choisir une couleur', en: 'Choose a color' },
  { fr: 'Choisir {{color}}', en: 'Choose {{color}}' },
  { fr: 'Choisir la couleur du seuil {{threshold}}', en: 'Choose the color for the {{threshold}} threshold' },
  { fr: 'Tuile {{x}}×{{y}} (LIDAR) ({{size}}mo) ({{year}} IGN)', en: 'Tile {{x}}×{{y}} (LIDAR) ({{size}} MB) ({{year}} IGN)' },
  { fr: '30 m (Monde - Rapide)', en: '30 m (World - Fast)' },
  { fr: '1 m Sol Nu (MNT IGN - Tracé net)', en: '1 m Bare Ground (IGN DTM - Sharp track)' },
  { fr: '0.40 m Surface (MNS - Bâtiments 3D)', en: '0.40 m Surface (DSM - 3D buildings)' },
  { fr: '1 m (LiDAR Terrain IGN)', en: '1 m (IGN LiDAR terrain)' },
  { fr: '0.40 m (LiDAR Surface IGN)', en: '0.40 m (IGN LiDAR surface)' },
  { fr: 'Qualité tracé', en: 'Track quality' },
  { fr: 'Auto : rapide en 2D et sur le relief 30 m, maximum en 3D sur le relief HD (1 m, 0,40 m).', en: 'Auto: fast in 2D and on the 30 m relief, maximum in 3D on the HD relief (1 m, 0.40 m).' },
  { fr: 'Rapide', en: 'Fast' },
  { fr: 'Équilibré', en: 'Balanced' },
  { fr: 'Maximum', en: 'Maximum' },
  { fr: "Cliquer pour modifier la durée d'ensoleillement", en: 'Click to edit the sunshine duration' },
  { fr: "Durée d'ensoleillement", en: 'Sunshine duration' },
  { fr: 'Radar pluie direct (Instant T · Nowcasting)', en: 'Live rain radar (real time · nowcasting)' },
  { fr: 'Prévision modèle DWD ICON-EU', en: 'DWD ICON-EU model forecast' },
  { fr: 'Prévisions (+2 j)', en: 'Forecast (+2 days)' },
  { fr: 'Température (°)', en: 'Temperature (°)' },
];
