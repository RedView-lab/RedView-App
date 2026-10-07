# Lire les statistiques de RedView — guide sans jargon

Ce guide est pour toute l'équipe, technique ou non. Il dit où regarder, comment
lire chaque écran, et quelles questions se poser chaque semaine.

## Où regarder

| Quoi | Où | Pour quoi |
|---|---|---|
| **Statistiques d'audience** | [analytics.redview.tech](https://analytics.redview.tech) → menu **Tableaux de bord** | Ce que les gens font dans l'app, d'où ils viennent, ce qui marche ou bloque |
| **Rapport des comptes** | Demander à l'équipe technique : `npm run analytics:report` | Combien de comptes reviennent, combien de kilomètres planifiés, qui paie |

Premier réglage dans Umami : **Profil → Langue → Français**. Tous les noms
d'actions, d'écrans et de détails sont déjà en français.

## Les 5 tableaux de bord

Chaque tableau commence par un bloc « Comment lire ce tableau ». La période se
choisit en haut à droite (7 jours, 30 jours…).

1. **RedView 1 · L'essentiel** — la page à ouvrir en premier : fréquentation,
   inscriptions, parcours envoyés vers un GPS, et l'entonnoir qui montre où les
   nouveaux décrochent.
2. **RedView 2 · Nouveaux utilisateurs** — d'où viennent les nouveaux
   (Instagram, site vitrine, campagnes) et comment se passe leur première journée.
3. **RedView 3 · Fonctions utilisées** — quelles fonctions servent vraiment
   (tracé, couches, LiDAR, survol 3D, travail à plusieurs).
4. **RedView 4 · Qui et sur quoi** — pays, langues, appareils, navigateurs,
   heures d'utilisation.
5. **RedView 5 · Vitesse et pannes** — l'app est-elle rapide ? Quels calculs
   ratent, et pourquoi ?

## Les mots à connaître

| Mot | Ce que ça veut dire |
|---|---|
| **Visiteurs** | Personnes différentes. Une personne sur deux appareils (ou deux réseaux) compte deux fois : c'est une estimation. |
| **Visites** | Séances d'utilisation. Une nouvelle commence au bout de 30 minutes environ. |
| **Écrans vus** | Pages de l'app affichées (Connexion, Mes projets, Éditeur 3D, Viewer LiDAR…). |
| **Rebond** | Séance où une seule page a été vue avant de partir. |
| **Événement** (ou action) | Une chose faite dans l'app : « Projet créé », « Parcours exporté vers le GPS »… Cliquer sur son nom montre le détail (onglet **Propriétés**). |
| **Propriété** | Le détail d'une action : la couche allumée (Pentes, Météo…), le format d'export (GPX, FIT…), la cause d'un échec. |
| **Entonnoir** | Une suite d'étapes. Le pourcentage entre deux barres = la part qui passe à l'étape suivante. La plus grosse chute = le problème n°1. |
| **Objectif** | Une action importante suivie en continu, avec la part des visiteurs qui l'atteignent. |
| **Segment** | Un sous-groupe à comparer (navigateur en anglais, arrivés depuis Instagram, sur téléphone…). Il se choisit dans le filtre en haut de chaque page. |
| **Tag** | La version de l'app. Il sert à comparer avant/après une mise à jour. |
| **Formule** | Bêta gratuite, Fondateur, Mécène. |
| **Ancienneté du compte** | Jour de l'inscription, première semaine, premier mois, plus d'un mois. |

## Les 5 questions du lundi

1. **Combien de nouveaux comptes cette semaine ?** (tableau 1, objectif
   « Inscriptions ») Est-ce que ça suit nos publications ?
2. **Combien de parcours envoyés vers un GPS ?** (tableau 1) C'est le signe le
   plus sûr que RedView sert pour de vrai.
3. **Où les nouveaux décrochent-ils ?** (tableau 2, entonnoirs) La plus grosse
   chute dit quoi améliorer en priorité. En bêta, c'est entre « projet créé » et
   « premier itinéraire tracé ».
4. **Quelle fonction monte, laquelle reste à zéro ?** (tableau 3) Une fonction à
   zéro est soit cachée, soit inutile : à croiser avec les retours des
   utilisateurs.
5. **Quelque chose a-t-il cassé ?** (tableau 5) Pic de « Calcul d'itinéraire
   raté », de « Plantage de la carte graphique » ou d'échecs de connexion pour
   « Problème de réseau » juste après une mise à jour ? À signaler à l'équipe
   technique.

## Bien interpréter

- **Peu de monde, chiffres qui bougent beaucoup.** Avec quelques dizaines de
  personnes, 1 inscription de plus change un pourcentage de 10 points. Regardez
  un mois plutôt qu'une semaine, et les nombres plutôt que les pourcentages.
- **Les comptes de l'équipe ne sont pas comptés.** Les tests et nos propres
  comptes sont exclus (libellé `internal`).
- **Certains navigateurs bloquent la mesure** (option « Ne pas suivre »). Les
  chiffres sont donc un minimum.
- **Revenir après une semaine** ne se mesure bien que dans le rapport des
  comptes (base de données), pas dans Umami.

## Ce que nous ne mesurons pas (exprès)

Aucun nom, aucun e-mail, aucun nom de projet, aucune position GPS, aucun texte
tapé, aucun enregistrement de l'écran. Pas de cookie. La localisation s'arrête à
la ville. Les données sont effacées au bout de 25 mois. C'est ce qui permet de
mesurer sans demander de consentement (règles de la CNIL).

## Demander une nouvelle mesure

Dire à l'équipe technique **la question** à laquelle vous voulez répondre
(« Les gens utilisent-ils la météo avant de partir ? »). Elle ajoute l'action à
mesurer, son nom en français, et si besoin un entonnoir ou un tableau. Détail
technique : `docs/ANALYTICS.md`.
