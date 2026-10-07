/**
 * Tableaux de bord Umami de RedView, pensés pour quelqu'un qui n'est pas
 * technique : chaque graphique a un titre en question simple et une phrase qui
 * dit comment le lire, et chaque tableau commence par un bloc « Comment lire ».
 * Appliqués par `npm run analytics:sync` après les entonnoirs et objectifs
 * (les blocs `funnel` / `goal` citent un rapport de spec.ts par son nom).
 *
 * Composants d'Umami 3.4 (boardComponentRegistry.tsx) : WebsiteMetricsBar,
 * WebsiteChart, EventsMetricsBar, EventsChart, MetricsTable {type, limit},
 * UTM {param, limit}, WorldMap, WeeklyTraffic, Goal / Funnel {reportId},
 * RealtimeActiveUsers, TextBlock {text}. 4 colonnes au plus par ligne.
 */

export type BoardBlock =
  | { kind: 'text'; text: string; size?: number }
  | { kind: 'component'; type: string; title: string; description?: string; props?: Record<string, unknown>; size?: number }
  | { kind: 'funnel'; funnel: string; title: string; description?: string; size?: number }
  | { kind: 'goal'; goal: string; title: string; description?: string; size?: number };

export interface BoardSpec {
  name: string;
  description: string;
  rows: BoardBlock[][];
}

const text = (lines: string[], size?: number): BoardBlock => ({ kind: 'text', text: lines.join('\n'), ...(size ? { size } : {}) });
const component = (type: string, title: string, description?: string, props?: Record<string, unknown>, size?: number): BoardBlock =>
  ({ kind: 'component', type, title, ...(description ? { description } : {}), ...(props ? { props } : {}), ...(size ? { size } : {}) });
const table = (type: string, title: string, description: string, limit = 10): BoardBlock =>
  component('MetricsTable', title, description, { type, limit });

const READING_TIPS = [
  'Choisissez la période en haut à droite (7 derniers jours, mois…). Tous les chiffres suivent.',
  '« Visiteurs » = personnes différentes (même réseau + même navigateur dans le mois : une personne sur deux appareils compte deux fois).',
  '« Visites » = séances d’utilisation (une nouvelle commence au bout de 30 minutes environ).',
  'Aucune donnée personnelle ici : pas de nom, pas d’e-mail, pas de nom de projet. Les comptes de l’équipe ne sont pas comptés.',
];

export const BOARDS: BoardSpec[] = [
  {
    name: 'RedView 1 · L’essentiel',
    description: 'La santé de l’app en une page : fréquentation, inscriptions, parcours exportés, et où les nouveaux décrochent.',
    rows: [
      [
        text([
          'COMMENT LIRE CE TABLEAU',
          '',
          ...READING_TIPS.map((tip) => `• ${tip}`),
          '',
          'LE CHIFFRE QUI COMPTE LE PLUS : « Parcours envoyés vers un GPS ». Un parcours exporté = quelqu’un va vraiment rouler avec RedView.',
          'Détail par compte (qui revient après 7 jours, combien de km planifiés) : rapport de la base, demandez-le à l’équipe technique (npm run analytics:report).',
        ]),
      ],
      [component('WebsiteMetricsBar', 'Fréquentation', 'Personnes, séances, écrans vus, rebond (séance d’un seul écran) et temps moyen passé.')],
      [component('WebsiteChart', 'Jour après jour', 'Écrans vus et personnes, jour par jour. Un saut brutal ? Comparez avec la date des mises à jour (repères « Déploiement » sur la vue d’ensemble du site).')],
      [
        { kind: 'goal', goal: 'Nouveaux comptes', title: 'Inscriptions', description: 'Part des personnes venues qui ont créé un compte.' },
        { kind: 'goal', goal: 'Parcours envoyés vers un GPS', title: 'Parcours envoyés vers un GPS', description: 'Part des personnes qui ont exporté au moins un parcours.' },
        { kind: 'goal', goal: 'Invitations à collaborer', title: 'Invitations', description: 'Part des personnes qui ont invité quelqu’un sur un projet.' },
      ],
      [
        { kind: 'funnel', funnel: '1. Activation : de l’inscription au GPS', title: 'Où les nouveaux décrochent-ils ?', description: 'Chaque barre = une étape. Le pourcentage entre deux barres = ceux qui passent à l’étape suivante.', size: 2 },
        text([
          'LIRE L’ENTONNOIR',
          '',
          '• La plus grosse chute entre deux barres = le problème n°1 à régler.',
          '• Inscription → Projet créé : l’accueil après inscription n’est pas clair.',
          '• Projet créé → Itinéraire calculé : tracer un premier itinéraire est trop difficile (c’est la chute observée en bêta).',
          '• Itinéraire → Export GPS : l’export n’est pas trouvé, ou le parcours ne convainc pas.',
          '',
          'Peu de monde = chiffres très variables : regardez au moins un mois.',
        ]),
      ],
      [
        table('event', 'Ce que les gens font le plus', 'Les actions les plus fréquentes, toutes fonctions confondues.'),
        table('path', 'Écrans les plus vus', 'Mes projets, Éditeur 3D, Viewer LiDAR, Connexion…'),
      ],
    ],
  },
  {
    name: 'RedView 2 · Nouveaux utilisateurs',
    description: 'D’où viennent les nouveaux, leur première journée, et à quelle étape ils abandonnent.',
    rows: [
      [
        text([
          'COMMENT LIRE CE TABLEAU',
          '',
          'Ce tableau suit les personnes qui découvrent RedView.',
          '• Entonnoir 1 : toutes les inscriptions, sur 7 jours.',
          '• Entonnoir 2 : uniquement les comptes créés le jour même. Réussir en une journée = l’app se comprend seule.',
          '• En bas : d’où ils arrivent (Instagram, site vitrine, Google…).',
          '',
          'Un lien de campagne (UTM) permet de savoir quelle publication ou quel partenaire amène des inscrits : demandez un lien à l’équipe technique avant chaque campagne.',
        ]),
      ],
      [{ kind: 'funnel', funnel: '1. Activation : de l’inscription au GPS', title: 'De la page d’inscription au premier export GPS', description: '7 jours au plus entre deux étapes.' }],
      [{ kind: 'funnel', funnel: '2. Première journée des nouveaux comptes', title: 'La première journée', description: 'Comptes créés le jour même : projet → itinéraire → tracé → export.' }],
      [
        { kind: 'goal', goal: 'Nouveaux comptes', title: 'Inscriptions', description: 'Part des personnes venues qui ont créé un compte.' },
        table('referrer', 'Sites d’où ils viennent', 'Le site visité juste avant RedView (vide = lien direct, favori ou appli).'),
        component('UTM', 'Campagnes', 'Liens de campagne utilisés (source).', { param: 'utm_source', limit: 10 }),
      ],
    ],
  },
  {
    name: 'RedView 3 · Fonctions utilisées',
    description: 'Quelles fonctions servent vraiment : tracé, couches, LiDAR, survol 3D, travail à plusieurs.',
    rows: [
      [
        text([
          'COMMENT LIRE CE TABLEAU',
          '',
          'Chaque action dans l’app est un « événement » au nom en français (« Couche de carte allumée ou éteinte », « Outil du viewer LiDAR utilisé »…).',
          '',
          'POUR LE DÉTAIL D’UNE ACTION : menu Événements à gauche → cliquer son nom → onglet Propriétés. Par exemple « Couche de carte allumée ou éteinte » → propriété « couche » montre Pentes, Météo, Neige… ; « Itinéraire calculé » → « profil de routage » (Route, Gravel, VTT…) et « distance (km) ».',
          '',
          'Une fonction quasi absente du classement : peu connue, mal placée, ou peu utile. À croiser avec les retours des utilisateurs.',
        ]),
      ],
      [component('EventsMetricsBar', 'Activité', 'Personnes, séances et nombre total d’actions sur la période.')],
      [component('EventsChart', 'Actions jour après jour', 'Chaque couleur = une action. Survolez pour lire les nombres.')],
      [table('event', 'Classement des actions', 'De la plus fréquente à la plus rare.', 20)],
      [
        { kind: 'funnel', funnel: '4. Travailler à plusieurs', title: 'Travail à plusieurs', description: 'Partage → invitation → session à plusieurs.' },
        { kind: 'funnel', funnel: '5. LiDAR : télécharger, ouvrir, analyser', title: 'LiDAR', description: 'Tuile → viewer → outil d’analyse.' },
        { kind: 'funnel', funnel: '6. Survol 3D jusqu’à la vidéo', title: 'Survol 3D', description: 'Lancé → vu en entier → vidéo exportée.' },
      ],
      [
        { kind: 'funnel', funnel: '3. Retour sur un projet jusqu’à l’export', title: 'Préparer sa sortie', description: 'Projet rouvert → retravaillé → exporté, dans la même séance.' },
        { kind: 'goal', goal: 'Ouvertures du viewer LiDAR', title: 'Viewer LiDAR', description: 'Part des personnes qui ouvrent le LiDAR en 3D.' },
        { kind: 'goal', goal: 'Vidéos de survol', title: 'Vidéos de survol', description: 'Part des personnes qui exportent une vidéo.' },
      ],
    ],
  },
  {
    name: 'RedView 4 · Qui et sur quoi',
    description: 'Pays, langues, appareils et navigateurs : pour décider des traductions, des pays LiDAR et des écrans à soigner.',
    rows: [
      [
        text([
          'COMMENT LIRE CE TABLEAU',
          '',
          '• Pays et langue : où traduire, quels pays LiDAR ajouter en priorité.',
          '• Taille d’écran : l’app vise l’ordinateur ; beaucoup de petits écrans = travail d’affichage à prévoir.',
          '• Navigateur : Firefox et Safari n’ont pas toujours le moteur 3D le plus rapide (le viewer LiDAR bascule alors sur un mode compatible).',
          '• Le tableau des horaires montre quand l’app est utilisée : utile pour choisir l’heure d’une mise à jour.',
          '',
          'La ville est la localisation la plus précise : aucune adresse IP n’est conservée.',
        ]),
      ],
      [component('WorldMap', 'Carte des visiteurs', 'Plus c’est foncé, plus il y a de monde.', undefined, 2), table('country', 'Pays', 'Nombre de personnes par pays.')],
      [table('language', 'Langue du navigateur', 'fr-FR, en-US… (la langue de l’app se lit dans le détail des actions).'), table('city', 'Villes', 'Ville estimée (jamais plus précis).')],
      [table('device', 'Type d’appareil', 'Ordinateur portable, fixe, tablette, téléphone.'), table('browser', 'Navigateur', 'Chrome, Firefox, Safari, Edge…'), table('screen', 'Taille d’écran', 'Largeur × hauteur en pixels.')],
      [component('WeeklyTraffic', 'Quand l’app est utilisée', 'Jours de la semaine × heures : plus c’est foncé, plus il y a de monde.')],
    ],
  },
  {
    name: 'RedView 5 · Vitesse et pannes',
    description: 'L’app est-elle rapide et fiable ? Temps de chargement, calculs ratés, plantages 3D.',
    rows: [
      [
        text([
          'COMMENT LIRE CE TABLEAU',
          '',
          'VITESSE : menu Performance à gauche. Repères de Google (75 % des visites doivent les tenir) :',
          '• LCP (affichage du contenu principal) : bon sous 2,5 s, mauvais au-delà de 4 s.',
          '• INP (réaction à un clic) : bon sous 0,2 s, mauvais au-delà de 0,5 s.',
          '• CLS (la page qui saute pendant le chargement) : bon sous 0,1.',
          'Filtrer par « tag » compare deux versions de l’app : une version plus lente se voit tout de suite.',
          '',
          'CARTE 3D : l’action « Carte 3D prête (temps d’ouverture) » mesure le temps réel entre l’ouverture d’un projet et la carte affichée (propriété « durée (secondes) »). Au-delà de 5 s, c’est long.',
        ]),
      ],
      [
        text([
          'PANNES À SURVEILLER (dans le classement à droite)',
          '',
          '• « Calcul d’itinéraire raté » : propriété « cause » — Calcul trop long, Point loin de toute route, Zone interdite, Problème de réseau…',
          '• « Plantage de la carte graphique (LiDAR) » : l’ordinateur n’a pas tenu le nuage de points.',
          '• « Échec de connexion ou d’inscription » : propriété « cause » — un pic de « Problème de réseau » signale un incident serveur.',
          '• « Invitation ratée » : l’adresse invitée n’a pas de compte RedView.',
          '',
          'Les erreurs techniques détaillées sont dans GlitchTip (errors.redview.tech), pour l’équipe technique.',
        ]),
        table('event', 'Toutes les actions', 'Cherchez les lignes « raté », « échec », « plantage ».', 20),
      ],
      [table('browser', 'Navigateurs', 'Une panne qui ne touche qu’un navigateur se voit en filtrant sur lui.'), table('os', 'Systèmes', 'Windows, macOS, Linux…')],
    ],
  },
];
