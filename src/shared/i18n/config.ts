export type AppLocale = 'fr' | 'en';
export type AppTranslationValue = string | number;
export type AppTranslationVars = Record<string, AppTranslationValue>;

export type AppTranslationBundle = {
  locale: AppLocale;
  entries: Record<string, string>;
};

export const PROJECT_BROWSER_SETTINGS_STORAGE_KEY = 'redview:project-browser-settings:v1';

export const APP_LOCALE_OPTIONS = [
  {
    value: 'en',
    label: 'English (US)',
    flag: '/landing/svg/US.svg',
    flagCode: 'US',
  },
  {
    value: 'fr',
    label: 'Français',
    flag: '/landing/svg/FR.svg',
    flagCode: 'FR',
  },
] as const;

const LEGACY_LANGUAGE_TO_LOCALE: Record<string, AppLocale> = {
  en: 'en',
  fr: 'fr',
  'English (US)': 'en',
  Français: 'fr',
};

const TRANSLATION_PAIRS = [
  { fr: 'Loading...', en: 'Loading...' },
  { fr: 'Redirecting...', en: 'Redirecting...' },
  { fr: 'Loading dashboard...', en: 'Loading dashboard...' },
  { fr: 'Réglages globaux', en: 'Global settings' },
  { fr: 'Langue', en: 'Language' },
  { fr: 'Unité de mesure', en: 'Unit system' },
  { fr: 'Paramètre de carte', en: 'Map preset' },
  { fr: 'Préférence d’affichage', en: 'Display preference' },
  { fr: 'Réglage', en: 'Setting' },
  { fr: 'Activer le réglage', en: 'Enable setting' },
  { fr: 'Mètre', en: 'Meters' },
  { fr: 'Pieds', en: 'Feet' },
  { fr: 'Jour (nuit couché de soleil)', en: 'Day (sunset night)' },
  { fr: 'Nuit', en: 'Night' },
  { fr: 'System preference', en: 'System preference' },
  { fr: 'Light mode', en: 'Light mode' },
  { fr: 'Dark mode', en: 'Dark mode' },
  { fr: 'Construit avec et pour la communauté', en: 'Built with and for the community' },
  {
    fr: "RedView s'appuie sur de nombreuses rencontres, discussions et observations réalisées avec la communauté cycliste. Si vous voulez contribuer au développement de l'outil, vous pouvez utiliser notre questionnaire de feedback ci-dessous.",
    en: 'RedView is shaped by many conversations, field observations, and exchanges with the cycling community. If you want to contribute to the product, you can use our feedback questionnaire below.',
  },
  { fr: 'Notre questionnaire de feedback', en: 'Our feedback questionnaire' },
  { fr: 'Coordonnees', en: 'Contact details' },
  { fr: 'First name *', en: 'First name *' },
  { fr: 'Last name *', en: 'Last name *' },
  { fr: 'Email address *', en: 'Email address *' },
  { fr: 'Annuler', en: 'Cancel' },
  { fr: 'Enregistrement...', en: 'Saving...' },
  { fr: 'Enregistrer', en: 'Save' },
  { fr: 'Pratique', en: 'Practice' },
  { fr: 'Pays', en: 'Country' },
  { fr: 'Sport', en: 'Sport' },
  { fr: 'Level', en: 'Level' },
  { fr: 'Moyenne annuelle', en: 'Yearly average' },
  { fr: 'Ajouter un sport', en: 'Add a sport' },
  { fr: 'Velo de route', en: 'Road cycling' },
  { fr: 'Gravel', en: 'Gravel' },
  { fr: 'VTT', en: 'MTB' },
  { fr: 'Trail', en: 'Trail running' },
  { fr: 'Randonnee', en: 'Hiking' },
  { fr: 'Debutant', en: 'Beginner' },
  { fr: 'Intermediaire', en: 'Intermediate' },
  { fr: 'Avance', en: 'Advanced' },
  { fr: 'Expert', en: 'Expert' },
  { fr: 'Mot de passe', en: 'Password' },
  { fr: 'Current password *', en: 'Current password *' },
  { fr: 'Current password', en: 'Current password' },
  { fr: 'Mise a jour...', en: 'Updating...' },
  { fr: 'Changer le mot de passe', en: 'Change password' },
  { fr: 'Coordonnees enregistrees.', en: 'Contact details saved.' },
  { fr: 'Impossible d’enregistrer le compte.', en: 'Unable to save the account.' },
  { fr: 'Impossible d’enregistrer les informations de pratique.', en: 'Unable to save practice details.' },
  { fr: 'Mot de passe mis a jour.', en: 'Password updated.' },
  { fr: 'Impossible de mettre a jour le mot de passe.', en: 'Unable to update the password.' },
  { fr: 'Chargement du compte...', en: 'Loading account...' },
  { fr: 'Aucune information de compte disponible.', en: 'No account information available.' },
  { fr: 'Compte', en: 'Account' },
  { fr: 'Enregistrement de votre e-mail de facturation…', en: 'Saving your billing email...' },
  { fr: 'E-mail de facturation enregistré.', en: 'Billing email saved.' },
  { fr: 'Impossible d’enregistrer l’e-mail de facturation.', en: 'Unable to save the billing email.' },
  { fr: 'Impossible de charger les informations d’abonnement.', en: 'Unable to load subscription details.' },
  { fr: 'Gestion de l’abonnement', en: 'Subscription management' },
  { fr: 'Découvrir les offres payantes', en: 'Explore paid plans' },
  { fr: 'Reprendre', en: 'Resume' },
  { fr: 'Interrompre', en: 'Pause' },
  { fr: 'Basculer sur cette offre', en: 'Switch to this plan' },
  { fr: 'Choisir cette offre', en: 'Choose this plan' },
  { fr: 'Choisir une offre payante', en: 'Choose a paid plan' },
  { fr: 'Remplacer mon moyen de paiement', en: 'Replace my payment method' },
  { fr: 'Ajouter un moyen de paiement', en: 'Add a payment method' },
  { fr: 'Passer à une offre payante', en: 'Upgrade to a paid plan' },
  { fr: 'Remplacer le moyen de paiement', en: 'Replace payment method' },
  { fr: 'Adresse indisponible', en: 'Address unavailable' },
  { fr: 'billing@votre-domaine.com', en: 'billing@your-domain.com' },
  { fr: 'Aucun moyen de paiement par défaut', en: 'No default payment method' },
  { fr: 'Plan Demo sans paiement', en: 'Demo plan without payment' },
  { fr: 'Ajoutez ou remplacez votre carte directement dans RedView App.', en: 'Add or replace your card directly in RedView App.' },
  {
    fr: 'Le plan Demo ne requiert aucun paiement. Ajoutez un moyen de paiement uniquement lorsque vous passez à une offre payante.',
    en: 'The Demo plan does not require payment. Add a payment method only when you switch to a paid plan.',
  },
  { fr: 'Carte Bancaire', en: 'Bank card' },
  { fr: 'Numéro de carte', en: 'Card number' },
  { fr: 'Amazon Pay', en: 'Amazon Pay' },
  { fr: 'Numéro de carte *', en: 'Card number *' },
  { fr: 'CVV *', en: 'CVV *' },
  { fr: 'Name on card *', en: 'Name on card *' },
  { fr: 'Expiry *', en: 'Expiry *' },
  { fr: 'Country *', en: 'Country *' },
  { fr: 'Aucun abonnement Stripe à synchroniser après confirmation.', en: 'No Stripe subscription to sync after confirmation.' },
  { fr: 'Saisissez le nom du titulaire de la carte.', en: 'Enter the cardholder name.' },
  { fr: 'Le champ de carte Stripe est introuvable.', en: 'The Stripe card field could not be found.' },
  { fr: 'Stripe n’a pas renvoyé de SetupIntent exploitable.', en: 'Stripe did not return a usable SetupIntent.' },
  { fr: 'La confirmation Stripe a échoué.', en: 'Stripe confirmation failed.' },
  { fr: 'Projets', en: 'Projects' },
  { fr: 'Abonnement', en: 'Subscription' },
  { fr: 'Réglages', en: 'Settings' },
  { fr: 'Navigation principale du menu projet', en: 'Main project menu navigation' },
  { fr: 'Utilisateur', en: 'User' },
  { fr: 'Déconnexion...', en: 'Signing out...' },
  { fr: 'Se déconnecter', en: 'Sign out' },
  { fr: 'Sélecteur de projet principal', en: 'Main project selector' },
  { fr: 'Confirmer le changement de plan', en: 'Confirm plan change' },
  { fr: 'Finaliser votre abonnement', en: 'Complete your subscription' },
  {
    fr: 'Validez ici le paiement ou le prorata éventuel sans quitter RedView.',
    en: 'Confirm payment or any proration here without leaving RedView.',
  },
  { fr: 'Choisissez votre mode de paiement pour vous abonner.', en: 'Choose your payment method to subscribe.' },
  { fr: 'Confirmer le changement', en: 'Confirm change' },
  { fr: 'Activer l’abonnement', en: 'Activate subscription' },
  { fr: 'Mettre à jour votre moyen de paiement', en: 'Update your payment method' },
  {
    fr: 'Ajoutez ou remplacez votre carte sans sortir de RedView. Les prochains prélèvements utiliseront ce moyen de paiement.',
    en: 'Add or replace your card without leaving RedView. Future charges will use this payment method.',
  },
  { fr: 'Enregistrer cette carte', en: 'Save this card' },
  { fr: 'Impossible d’ouvrir le formulaire de carte.', en: 'Unable to open the card form.' },
  { fr: 'Impossible de lancer cette action de facturation.', en: 'Unable to start this billing action.' },
  { fr: 'Impossible de mettre à jour le renouvellement automatique.', en: 'Unable to update auto-renewal.' },
  { fr: 'Impossible de se déconnecter.', en: 'Unable to sign out.' },
  { fr: 'Impossible de charger les informations du compte.', en: 'Unable to load account details.' },
  { fr: 'Affichage des projets', en: 'Project display' },
  { fr: 'Grille', en: 'Grid' },
  { fr: 'Liste', en: 'List' },
  { fr: 'Rechercher…', en: 'Search...' },
  { fr: 'Rechercher un projet', en: 'Search for a project' },
  { fr: 'Créer un dossier', en: 'Create folder' },
  { fr: 'Création…', en: 'Creating...' },
  { fr: 'Créer un projet', en: 'Create project' },
  { fr: 'Créer un élément', en: 'Create item' },
  { fr: 'Créer un projet ici', en: 'Create project here' },
  { fr: 'Créer un dossier ici', en: 'Create folder here' },
  { fr: 'Contenu du dossier courant', en: 'Current folder contents' },
  { fr: 'Liste des projets', en: 'Project list' },
  { fr: 'Chargement…', en: 'Loading...' },
  { fr: 'Aucun dossier ou projet ne correspond à votre recherche.', en: 'No folder or project matches your search.' },
  { fr: 'Ce dossier est vide. Créez un sous-dossier ou un projet pour commencer.', en: 'This folder is empty. Create a subfolder or project to get started.' },
  { fr: 'Vous n’avez pas encore de projet. Créez un dossier ou un projet pour commencer.', en: 'You do not have any project yet. Create a folder or project to get started.' },
  { fr: 'Racine / Projets', en: 'Root / Projects' },
  { fr: 'Nouveau nom du projet', en: 'New project name' },
  { fr: 'Nouveau nom du dossier', en: 'New folder name' },
  { fr: 'Actions du projet', en: 'Project actions' },
  { fr: 'Actions du dossier', en: 'Folder actions' },
  { fr: 'Double-cliquer pour renommer', en: 'Double-click to rename' },
  { fr: 'Aperçu de projet', en: 'Project preview' },
  { fr: 'Chemin du dossier courant', en: 'Current folder path' },
  { fr: 'Renommer le dossier', en: 'Rename folder' },
  { fr: 'Renommer le projet', en: 'Rename project' },
  { fr: 'Déplacer vers…', en: 'Move to...' },
  { fr: 'Destinations disponibles', en: 'Available destinations' },
  { fr: 'Dupliquer le projet', en: 'Duplicate project' },
  { fr: 'Supprimer le dossier', en: 'Delete folder' },
  { fr: 'Supprimer le projet', en: 'Delete project' },
  { fr: 'Projet', en: 'Project' },
  { fr: 'Dossier', en: 'Folder' },
  { fr: 'Découvrir les offres', en: 'Explore plans' },
  { fr: 'Abonnements', en: 'Subscriptions' },
  { fr: 'Découvrez nos offres d’abonnement.', en: 'Explore our subscription offers.' },
  { fr: 'Informations de paiement', en: 'Payment information' },
  { fr: 'E-mail de contact', en: 'Contact email' },
  { fr: 'Envoyer sur mon e-mail de compte', en: 'Send to my account email' },
  { fr: 'Envoyer sur un e-mail alternatif', en: 'Send to an alternative email' },
  { fr: 'Vous êtes sur une démo réduite de RedView. Pour activer l’interface, choisissez votre abonnement:', en: 'You are on a reduced RedView demo. To unlock the full interface, choose your subscription:' },
  { fr: 'Démo', en: 'Demo' },
  { fr: 'Gratuit', en: 'Free' },
  { fr: 'Abonnement Explorer', en: 'Explorer plan' },
  { fr: 'Abonnement Pro', en: 'Pro plan' },
  { fr: 'Engagement de 6 mois', en: '6-month commitment' },
  { fr: 'Sans engagement', en: 'No commitment' },
  { fr: 'Stockage Cloud', en: 'Cloud storage' },
  { fr: 'Gestionnaire de projet', en: 'Project manager' },
  { fr: 'Cartographie 3D HD', en: 'HD 3D mapping' },
  { fr: 'Cartographie 3D haute fidélité', en: 'High-fidelity 3D mapping' },
  { fr: 'Analyse LIDAR 20cm', en: '20 cm LIDAR analysis' },
  { fr: 'Analyse du terrain', en: 'Terrain analysis' },
  { fr: 'Analyse des pentes', en: 'Slope analysis' },
  { fr: 'Analyse de l’altitude', en: 'Altitude analysis' },
  { fr: 'Météo et ensoleillement', en: 'Weather and sunlight' },
  { fr: 'Simulation ensoleillement', en: 'Sunlight simulation' },
  { fr: 'Prévisions et tendances Météo', en: 'Weather forecasts and trends' },
  { fr: 'Vent en temps réel', en: 'Real-time wind' },
  { fr: 'Simulation de la neige en temps réel', en: 'Real-time snow simulation' },
  { fr: 'Création d’itinéraire avancée', en: 'Advanced route planning' },
  { fr: 'Création d’itinéraire customisable', en: 'Customizable route creation' },
  { fr: 'Comparaison d’itinéraire', en: 'Route comparison' },
  { fr: 'Analyse d’itinéraire', en: 'Route analysis' },
  { fr: 'Graphique customisable', en: 'Customizable chart' },
  { fr: 'Feuille de route et timeline exportables', en: 'Exportable roadbook and timeline' },
  { fr: 'Export multi format', en: 'Multi-format export' },
  { fr: 'Gestion des Points d’Intérêts', en: 'POI management' },
  { fr: 'Sélection et édition des POIs', en: 'POI selection and editing' },
  { fr: 'Estimation du rythme', en: 'Pace estimation' },
  { fr: 'Pacing et gestion des pauses', en: 'Pacing and pause management' },
  { fr: 'Votre mode de paiement :', en: 'Your payment method:' },
  { fr: 'Card details', en: 'Card details' },
  { fr: 'CVV', en: 'CVV' },
  { fr: 'Name on card', en: 'Name on card' },
  { fr: 'Expiry', en: 'Expiry' },
  { fr: 'Country', en: 'Country' },
  { fr: 'Configuration Stripe incomplète', en: 'Incomplete Stripe configuration' },
  { fr: 'Ajoutez VITE_STRIPE_PUBLISHABLE_KEY côté app pour activer la page de paiement intégrée.', en: 'Add VITE_STRIPE_PUBLISHABLE_KEY on the app side to enable the embedded payment page.' },
  { fr: 'Stripe indisponible', en: 'Stripe unavailable' },
  { fr: 'Confirmation…', en: 'Confirming...' },
  { fr: 'En fournissant vos informations de carte bancaire, vous autorisez RedView à débiter votre carte pour les paiements futurs conformément à ses conditions. Les données de votre carte sont traitées par Stripe, RedView n’enregistre jamais le PAN complet.', en: 'By providing your card information, you authorize RedView to charge your card for future payments in accordance with its terms. Your card data is processed by Stripe; RedView never stores the full PAN.' },
  { fr: 'Ouvrir RedView Web', en: 'Open RedView Web' },
  { fr: 'Premium', en: 'Premium' },
  { fr: 'Actif', en: 'Active' },
  { fr: 'Essai', en: 'Trial' },
  { fr: 'Statut indisponible', en: 'Status unavailable' },
  { fr: 'Votre compte démarre sur le plan Demo. Ouvrez RedView Web depuis cet onglet pour passer à une offre payante quand vous le souhaitez.', en: 'Your account starts on the Demo plan. Open RedView Web from this tab to switch to a paid plan whenever you want.' },
  { fr: 'Votre abonnement RedView Pro est actif.', en: 'Your RedView Pro subscription is active.' },
  { fr: 'Public', en: 'Public' },
  { fr: 'Privé', en: 'Private' },
  { fr: 'Sans nom', en: 'Untitled' },
  { fr: 'copie', en: 'copy' },
  { fr: 'Projet introuvable.', en: 'Project not found.' },
  { fr: 'Session expirée. Reconnectez-vous pour gérer votre abonnement.', en: 'Session expired. Sign back in to manage your subscription.' },
  { fr: 'La requête de facturation a échoué.', en: 'The billing request failed.' },
  { fr: 'Session utilisateur introuvable.', en: 'User session not found.' },
  { fr: 'Impossible de charger les projets.', en: 'Unable to load projects.' },
  { fr: 'Échec de la création du projet.', en: 'Failed to create the project.' },
  { fr: 'Échec de la création du dossier.', en: 'Failed to create the folder.' },
  { fr: 'Échec du renommage.', en: 'Rename failed.' },
  { fr: 'Échec de la suppression.', en: 'Delete failed.' },
  { fr: 'Échec du renommage du dossier.', en: 'Folder rename failed.' },
  { fr: 'Échec de la suppression du dossier.', en: 'Folder deletion failed.' },
  { fr: 'Projet déplacé dans le dossier.', en: 'Project moved to the folder.' },
  { fr: 'Projet déplacé à la racine.', en: 'Project moved to the root.' },
  { fr: 'Impossible de déplacer ce projet.', en: 'Unable to move this project.' },
  { fr: 'Dossier déplacé.', en: 'Folder moved.' },
  { fr: 'Dossier déplacé à la racine.', en: 'Folder moved to the root.' },
  { fr: 'Impossible de déplacer ce dossier.', en: 'Unable to move this folder.' },
  { fr: 'Impossible de dupliquer ce projet.', en: 'Unable to duplicate this project.' },
  { fr: 'Dernière connexion indisponible', en: 'Last connection unavailable' },
  { fr: 'Projet dupliqué: {{name}}', en: 'Project duplicated: {{name}}' },
  { fr: 'Dernière connexion le {{date}} à {{time}}', en: 'Last connection on {{date}} at {{time}}' },
  { fr: '{{brand}} se terminant par {{last4}}', en: '{{brand}} ending in {{last4}}' },
  { fr: 'Expire {{date}}.', en: 'Expires {{date}}.' },
  { fr: 'Votre abonnement se terminera le {{date}}.', en: 'Your subscription will end on {{date}}.' },
  { fr: 'Votre abonnement se renouvelle automatiquement le {{date}}.', en: 'Your subscription renews automatically on {{date}}.' },
  { fr: 'Supprimer définitivement « {{name}} » ?', en: 'Permanently delete “{{name}}”?' },
  { fr: 'Supprimer définitivement le dossier « {{name}} » ? Il doit être vide avant suppression.', en: 'Permanently delete the folder “{{name}}”? It must be empty before deletion.' },
  { fr: 'Ouvrir {{name}}', en: 'Open {{name}}' },
  { fr: 'Entrer dans {{name}}', en: 'Enter {{name}}' },
  { fr: 'Ouvrir le dossier {{name}}', en: 'Open folder {{name}}' },
  { fr: 'Entrer dans le dossier {{name}}', en: 'Enter folder {{name}}' },
  { fr: 'Nouveau projet', en: 'New project' },
  { fr: 'Nom du projet', en: 'Project name' },
  { fr: 'Projet non enregistré', en: 'Unsaved project' },
  { fr: 'Non enregistré', en: 'Unsaved' },
  { fr: 'Retour au gestionnaire en cours', en: 'Returning to project browser' },
  { fr: 'Retour au gestionnaire de projet', en: 'Back to project browser' },
  { fr: 'Paramètres du projet', en: 'Project settings' },
  { fr: 'Télécharger', en: 'Download' },
  { fr: 'Partager', en: 'Share' },
  { fr: 'Traçage', en: 'Routing' },
  { fr: "Mode d'édition", en: 'Edit mode' },
  { fr: 'Panneau d’itinéraire', en: 'Itinerary panel' },
  { fr: 'Timeline en plein écran', en: 'Fullscreen timeline' },
  { fr: 'Redimensionner le panneau', en: 'Resize panel' },
  { fr: 'Itinéraires', en: 'Routes' },
  { fr: 'Renommer {{name}}', en: 'Rename {{name}}' },
  { fr: 'Cliquer à nouveau pour renommer', en: 'Click again to rename' },
  { fr: 'Itinéraire chargé depuis un GPX', en: 'Route imported from a GPX file' },
  { fr: 'Supprimer {{name}}', en: 'Delete {{name}}' },
  { fr: 'Nouvel itinéraire', en: 'New route' },
  { fr: 'Gravel (défaut)', en: 'Gravel (default)' },
  { fr: 'Route', en: 'Road' },
  { fr: 'VTT', en: 'MTB' },
  { fr: 'Touring', en: 'Touring' },
  { fr: 'Personnalisé', en: 'Custom' },
  { fr: 'Rechercher un lieu', en: 'Search for a place' },
  { fr: 'Fonds de carte', en: 'Basemaps' },
  { fr: 'Activer {{title}}', en: 'Enable {{title}}' },
  { fr: 'Réduire', en: 'Collapse' },
  { fr: 'Développer', en: 'Expand' },
  { fr: 'Topographique', en: 'Topographic' },
  { fr: 'Tuiles LIDAR ( {{count}} )', en: 'LIDAR tiles ( {{count}} )' },
  { fr: 'Téléchargement {{progress}}', en: 'Downloading {{progress}}' },
  { fr: 'Téléchargement en cours', en: 'Download in progress' },
  { fr: 'Télécharger une tuile LIDAR', en: 'Download a LIDAR tile' },
  { fr: 'Clique sur la carte pour choisir une tuile', en: 'Click on the map to choose a tile' },
  { fr: 'Mode sélection actif', en: 'Selection mode active' },
  { fr: 'Active le mode puis clique sur la carte', en: 'Enable the mode, then click on the map' },
  { fr: 'Cliquer pour renommer', en: 'Click to rename' },
  { fr: 'Ouvrir dans le viewer 3D', en: 'Open in 3D viewer' },
  { fr: 'Ouvrir dans le viewer 3D LIDAR', en: 'Open in LIDAR 3D viewer' },
  { fr: 'Supprimer la tuile', en: 'Delete tile' },
  { fr: 'Tuile {{index}} (LIDAR) ({{size}}mo) ({{year}} IGN)', en: 'Tile {{index}} (LIDAR) ({{size}} MB) ({{year}} IGN)' },
  { fr: 'Itinéraire {{index}}', en: 'Route {{index}}' },
  { fr: 'Variante 2', en: 'Variant 2' },
  { fr: "Synthèse d'itinéraire", en: 'Route summary' },
  { fr: 'Synthèse', en: 'Summary' },
  { fr: 'Aucun itinéraire', en: 'No route' },
  { fr: "Plus d'options", en: 'More options' },
  { fr: '{{name}} commence à {{distance}} km', en: '{{name}} starts at {{distance}} km' },
  { fr: 'Replier les traces filles', en: 'Collapse child traces' },
  { fr: 'Déplier les traces filles', en: 'Expand child traces' },
  { fr: 'Masquer le graphique', en: 'Hide chart' },
  { fr: 'Afficher le graphique', en: 'Show chart' },
  { fr: 'Nouveau nom pour {{name}}', en: 'New name for {{name}}' },
  { fr: '{{name}} · Double-cliquez pour renommer', en: '{{name}} · Double-click to rename' },
  { fr: "Plus d'options pour {{name}}", en: 'More options for {{name}}' },
  { fr: 'Actions pour {{name}}', en: 'Actions for {{name}}' },
  { fr: 'Renommer la trace', en: 'Rename route' },
  { fr: 'Dupliquer la trace', en: 'Duplicate route' },
  { fr: 'Supprimer la trace', en: 'Delete route' },
  { fr: 'Analyse du parcours', en: 'Route analysis' },
  { fr: 'Analyse', en: 'Analysis' },
  { fr: "Mode d'analyse", en: 'Analysis mode' },
  { fr: 'Distance', en: 'Distance' },
  { fr: 'Temps', en: 'Time' },
  { fr: 'Heures', en: 'Hours' },
  { fr: 'Détail', en: 'Detail' },
  { fr: 'Zoom du graphique', en: 'Chart zoom' },
  { fr: 'Dézoomer le graphique', en: 'Zoom out chart' },
  { fr: 'Zoomer le graphique', en: 'Zoom in chart' },
  { fr: 'Axe 1', en: 'Axis 1' },
  { fr: 'Axe 2', en: 'Axis 2' },
  { fr: 'Filtres', en: 'Filters' },
  { fr: "Graphique d'analyse", en: 'Analysis chart' },
  { fr: 'Renseigne une date et une heure de départ pour activer Jour/nuit.', en: 'Set a departure date and time to enable Day/Night.' },
  { fr: 'Waypoint', en: 'Waypoint' },
  { fr: 'Pause', en: 'Pause' },
  { fr: 'Alertes', en: 'Alerts' },
  { fr: "Profil d'altitude", en: 'Altitude profile' },
  { fr: 'Jour/nuit', en: 'Day/Night' },
  { fr: 'Vitesse', en: 'Speed' },
  { fr: 'Vitesse moyenne', en: 'Average speed' },
  { fr: 'Puissance', en: 'Power' },
  { fr: 'Puissance moyenne', en: 'Average power' },
  { fr: 'Inclinaison (°)', en: 'Slope (deg)' },
  { fr: 'Inclinaison (%)', en: 'Slope (%)' },
  { fr: 'Surface', en: 'Surface' },
  { fr: 'Température', en: 'Temperature' },
  { fr: 'Température ressentie (°)', en: 'Feels like (deg)' },
  { fr: 'Pluie (mm)', en: 'Rain (mm)' },
  { fr: 'Vent (km/h)', en: 'Wind (km/h)' },
  { fr: 'Couverture nuageuse (%)', en: 'Cloud cover (%)' },
  { fr: 'Humidité (%)', en: 'Humidity (%)' },
  { fr: 'Ensoleillement (min)', en: 'Sunshine (min)' },
  { fr: 'Itinéraire(s)', en: 'Route(s)' },
  { fr: 'Feuille de route', en: 'Roadbook' },
  { fr: 'Timeline', en: 'Timeline' },
  { fr: 'Graphique', en: 'Chart' },
  { fr: 'Exporter', en: 'Export' },
  { fr: "Panneau central d'analyse", en: 'Central analysis panel' },
  { fr: 'Trace supprimée', en: 'Route deleted' },
  { fr: 'Nouvel itinéraire créé', en: 'New route created' },
  { fr: 'Réduction possible: {{count}} point en moins', en: 'Possible reduction: {{count}} fewer point' },
  { fr: 'Réduction possible: {{count}} points en moins', en: 'Possible reduction: {{count}} fewer points' },
  { fr: 'Trace déjà assez légère', en: 'Route is already light enough' },
  { fr: '{{count}} passage trop raide détecté', en: '{{count}} section too steep detected' },
  { fr: '{{count}} passages trop raides détectés', en: '{{count}} sections too steep detected' },
  { fr: 'Aucun passage trop raide détecté', en: 'No section too steep detected' },
  { fr: 'Nettoyage de trace disponible', en: 'Route cleanup available' },
  { fr: 'Trace réduite à {{value}} pts/km', en: 'Route reduced to {{value}} pts/km' },
  { fr: 'Aucune aberration détectée', en: 'No anomalies detected' },
  { fr: 'Trace nettoyée', en: 'Route cleaned' },
  { fr: 'Sens du GPX inversé', en: 'GPX direction reversed' },
  { fr: 'Inversion indisponible pour cette trace', en: 'Reverse is unavailable for this route' },
  { fr: 'Audit indisponible pour cette trace', en: 'Audit is unavailable for this route' },
  { fr: 'Aucune galère détectée', en: 'No issues detected' },
  { fr: '{{count}} portion à vérifier', en: '{{count}} section to review' },
  { fr: '{{count}} portions à vérifier', en: '{{count}} sections to review' },
  { fr: 'Audit masqué', en: 'Audit hidden' },
  { fr: 'Barre d\'outils centrale', en: 'Central toolbar' },
  { fr: "Outils d'édition du parcours", en: 'Route editing tools' },
  { fr: 'Lecture du parcours', en: 'Route playback' },
  { fr: 'Ralentir le flyover', en: 'Slow down flyover' },
  { fr: 'Mettre en pause le flyover', en: 'Pause flyover' },
  { fr: 'Lancer le flyover', en: 'Start flyover' },
  { fr: 'Accélérer le flyover', en: 'Speed up flyover' },
  { fr: 'Revenir au début du flyover', en: 'Return to start of flyover' },
  { fr: 'Résumé de lecture', en: 'Playback summary' },
  { fr: 'Réduction de points GPX', en: 'GPX point reduction' },
  { fr: 'Simplification intelligente', en: 'Smart simplification' },
  { fr: 'Detaillé courant: {{value}} pts/km', en: 'Current detail: {{value}} pts/km' },
  { fr: 'Repères utiles: détaillé 40-80 pts/km, léger 15-30 pts/km', en: 'Useful markers: detailed 40-80 pts/km, light 15-30 pts/km' },
  { fr: 'Densité cible', en: 'Target density' },
  { fr: 'Distance indisponible', en: 'Distance unavailable' },
  { fr: 'Nouveau point', en: 'New point' },
  { fr: 'Erreur de recherche', en: 'Search error' },
  { fr: 'Eau', en: 'Water' },
  { fr: 'Toilettes', en: 'Toilets' },
  { fr: 'Supermarché', en: 'Supermarket' },
  { fr: 'Carburant', en: 'Fuel' },
  { fr: 'Boulangerie', en: 'Bakery' },
  { fr: 'Fast-food', en: 'Fast food' },
  { fr: 'Café', en: 'Cafe' },
  { fr: 'Bar', en: 'Bar' },
  { fr: 'Restaurant', en: 'Restaurant' },
  { fr: 'Vélo', en: 'Bike' },
  { fr: 'Hôtel', en: 'Hotel' },
  { fr: 'Refuge', en: 'Refuge' },
  { fr: 'Col', en: 'Pass' },
  { fr: 'Activez au moins un export avant de lancer le téléchargement.', en: 'Enable at least one export before starting the download.' },
  { fr: 'Aucun itinéraire actif à exporter.', en: 'No active route to export.' },
  { fr: "Le format sélectionné n'est pas encore pris en charge pour l'itinéraire.", en: 'The selected format is not yet supported for the route.' },
  { fr: 'La feuille de route est uniquement disponible en export Excel.', en: 'The roadbook is only available as an Excel export.' },
  { fr: "{{files}} exporté depuis l'itinéraire actif.", en: '{{files}} exported from the active route.' },
  { fr: "{{files}} exportés depuis l'itinéraire actif.", en: '{{files}} exported from the active route.' },
  { fr: "Impossible d'exporter l'itinéraire actif.", en: 'Unable to export the active route.' },
  { fr: "Panneau d'export", en: 'Export panel' },
  { fr: 'Réduire le module exporter', en: 'Collapse export module' },
  { fr: 'Développer le module exporter', en: 'Expand export module' },
  { fr: 'Export...', en: 'Exporting...' },
] as const;

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'fr' || value === 'en';
}

export function resolveAppLocale(value: unknown): AppLocale {
  if (Array.isArray(value)) {
    return resolveAppLocale(value[0]);
  }

  if (typeof value !== 'string') {
    return 'fr';
  }

  return LEGACY_LANGUAGE_TO_LOCALE[value] ?? (value.toLowerCase().startsWith('en') ? 'en' : 'fr');
}

export function detectNavigatorAppLocale(): AppLocale {
  if (typeof navigator === 'undefined') {
    return 'fr';
  }

  return resolveAppLocale(navigator.language);
}

export function readStoredAppLocale(): AppLocale {
  if (typeof window === 'undefined') {
    return 'fr';
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return detectNavigatorAppLocale();
    }

    const parsed = JSON.parse(raw) as { language?: unknown };
    return resolveAppLocale(parsed.language);
  } catch {
    return detectNavigatorAppLocale();
  }
}

export function writeStoredAppLocale(locale: AppLocale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_BROWSER_SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    window.localStorage.setItem(
      PROJECT_BROWSER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        ...parsed,
        language: locale,
      }),
    );
  } catch {
    // Best effort only.
  }
}

export function interpolateAppTranslation(template: string, vars?: AppTranslationVars): string {
  if (!vars) {
    return template;
  }

  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
    const value = vars[key];
    return value == null ? match : String(value);
  });
}

export function readDocumentAppLocale(): AppLocale {
  if (typeof document !== 'undefined') {
    return resolveAppLocale(document.documentElement.lang || undefined);
  }

  return readStoredAppLocale();
}

export function createAppTranslationBundle(locale: AppLocale): AppTranslationBundle {
  const entries: Record<string, string> = {};

  for (const pair of TRANSLATION_PAIRS) {
    const target = locale === 'fr' ? pair.fr : pair.en;
    entries[pair.fr] = target;
    entries[pair.en] = target;
  }

  return {
    locale,
    entries,
  };
}

export function translateAppText(
  text: string,
  vars?: AppTranslationVars,
  locale: AppLocale = readDocumentAppLocale(),
): string {
  const bundle = createAppTranslationBundle(locale);
  const translated = bundle.entries[text] ?? text;
  return interpolateAppTranslation(translated, vars);
}