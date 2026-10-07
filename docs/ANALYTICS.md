# Mesure d'audience de RedView App

Guide de lecture pour toute l'équipe (sans jargon) : [GUIDE_STATISTIQUES.md](GUIDE_STATISTIQUES.md).
Ce document-ci est la référence technique.

Deux sources, deux rôles :

| Source | Ce qu'elle mesure | Où |
|---|---|---|
| **Umami** (auto-hébergé, `analytics.redview.tech`) | Comportement anonyme par session : écrans, parcours, adoption des fonctions, entonnoirs dans une séance, temps de chargement (Web Vitals + carte 3D), acquisition (UTM, referrer), appareils | `src/shared/lib/analytics/`, rapports versionnés dans `scripts/umami/spec.ts` |
| **Base Appwrite** | Ce que les comptes ont vraiment fait : cohortes d'inscription, activation, retour à J+7, payants, usage (projets, km planifiés, fonctions utilisées) | `api/_lib/activationReport.ts`, `npm run analytics:report` |

Umami ne suit personne : une session = hash(site, IP, navigateur, **sel mensuel**),
une visite = session + heure. Un entonnoir sur plusieurs jours est donc une borne
basse (changement de réseau, d'appareil, de mois) ; la rétention par compte se lit
dans la base.

## Vie privée (exemption de consentement CNIL)

- Pas de cookie, pas d'`identify`, pas d'id distinct, pas de replay de session
  (retiré le 2026-10-07), pas de carte de chaleur.
- Ne sortent jamais : e-mail, nom, id (Appwrite, UUID), nom de projet ou
  d'itinéraire, coordonnées, texte saisi, URL réelle, titre réel.
- L'URL envoyée est l'**écran** (`/editeur-3d`, `/projets/reglages`…) ; de la query,
  seuls `utm_*` et `ref` restent. Le referrer est réduit à son origine
  (et retiré quand il vient de l'app ou du rebond OAuth).
- Données d'événement : catégories, tranches (`countBucket`, `durationBucket`…)
  ou nombres arrondis (`roundTo`). Un garde à l'exécution remplace toute chaîne qui
  contient `@`, un id hexadécimal, un UUID, un jeton ou plus de 64 caractères
  (`privacy.ts`), et le before-send (`beforeSend.ts`) filtre **tout** ce que le
  tracker envoie, Web Vitals et clics automatiques compris.
- Contexte ajouté à chaque événement : `surface` (app/viewer), `plan` (formule :
  demo, founder, patron), `account_age` (d0, d1_7, d8_30, d30_plus), `lang`, `theme`.
- Comptes de l'équipe et de test : libellé Appwrite `internal`
  (`scripts/analytics-internal-accounts.ts`) → rien n'est envoyé, et ils sortent
  du rapport d'activation.
- Respect de « Ne pas suivre » (`data-do-not-track`).
- Géolocalisation à la ville au plus fin (Umami), IP jamais stockée.
- Conservation : 25 mois (`server/vps/umami/retention.sql`, minuteur mensuel).
- À mentionner dans la politique de confidentialité (mesure d'audience, contexte
  formule/ancienneté).

## Chaîne technique

1. `initAnalytics()` (`src/main.tsx`, `lidar/viewer/main.ts`) injecte au repos
   `/s/x.js` — **first-party** : le nginx de l'hôte sert le tracker et la
   collecte (`/s/api/send`) sur app.redview.tech (`server/vps/nginx-stats.conf`),
   deux chemins exacts ; le tableau de bord reste sur analytics.redview.tech.
   Jamais en dev ni hors du domaine de prod (`localStorage['rv:analytics-test']`
   le force pour les bancs).
2. Le tag Umami = release (12 caractères du commit) : Web Vitals, écrans et
   événements se comparent d'un déploiement à l'autre (« Compare », filtre tag).
3. Les événements émis avant le chargement attendent dans une file ; un même
   événement dans la seconde n'est envoyé qu'une fois ; les événements fréquents
   sont étranglés (`trackAnalyticsEventThrottled`) ou résumés au `pagehide`.
4. Chaque déploiement (`npm run deploy`) pose une annotation « Déploiement <sha> »
   sur les courbes.

## Écrans (pages vues virtuelles)

`/connexion`, `/inscription`, `/mot-de-passe-oublie`, `/serveur-injoignable`,
`/projets`, `/projets/compte`, `/projets/abonnement`, `/projets/reglages`,
`/editeur-3d`, `/viewer-lidar`, `/bloque/telephone`,
`/bloque/fenetre-trop-petite` — titres « Connexion », « Mes projets »,
« Éditeur 3D »… (`screens.ts`).

## En français courant dans Umami

Le code garde des noms typés (`route_exported`, `layer: 'slopes'`) ; le
before-send les traduit au départ avec `labels.ts` : Umami reçoit « Parcours
exporté vers le GPS » avec « format : GPX », « Couche de carte allumée ou
éteinte » avec « couche : Pentes, allumé : oui », les durées en secondes, les
booléens en oui/non. Les rapports (`scripts/umami/spec.ts`) citent les noms du
code et passent par les mêmes tables : impossible qu'un entonnoir cherche un nom
qu'Umami ne reçoit pas. **Changer un libellé crée un nouvel événement pour
Umami** (l'historique de l'ancien nom ne s'y rattache pas) : à éviter en prod.
Un test vérifie que chaque événement a un libellé unique de 50 caractères au
plus.

## Dictionnaire des événements

Source de vérité : `src/shared/lib/analytics/events.ts` (types) ; noms affichés
dans `labels.ts`. Résumé (noms du code) :

| Domaine | Événement | Propriétés |
|---|---|---|
| Compte | `signup_completed`, `login_completed` | `method` email/google (Google : décidé au retour OAuth sur la date d'inscription) |
| | `auth_failed` | `method`, `step` login/signup/verification/reset, `reason` credentials/exists/rate_limited/network/code/other |
| | `password_reset_requested`, `password_reset_completed`, `logout`, `account_data_exported` (`projects`), `account_deleted` | |
| | `theme_changed` (`mode`), `language_changed` (`language`), `feedback_opened` | |
| Monétisation | `checkout_started`, `checkout_completed` | `plan` |
| Projets | `project_created` (`source` blank/import), `project_opened` (`last_saved`, `shared`), `project_deleted`, `project_duplicated`, `folder_created`, `shared_project_left` | |
| | `project_file_exported` (`from` editor/browser), `project_file_imported` (`outcome`, `files`) | fichier `.redview` |
| Perf. perçue | `editor_ready` | `ms` (arrondi 100), `cold` (lien direct, depuis la navigation), `itineraries` — ouverture → première carte 3D prête |
| Itinéraires | `itinerary_added` | `method` blank/gpx/lidar/duplicate/map/poi |
| | `gpx_imported` | `format`, `points` (tranche) |
| | `route_calculated` | `kind` full/patch/extend, `distance_km` (10), `elevation_m` (100), `ms` (100), `profile` (préréglage ou `custom`) — 1/15 s par itinéraire et par sorte |
| | `route_failed` | `kind`, `reason` rate_limited/seam/restricted/not_mapped/no_route/timeout/out_of_zone/network/other |
| | `route_editing_summary` | `routes`, `patches` (tranches) — au `pagehide` |
| | `route_action` | `action` undo/redo/reverse/delete |
| | `route_exported` | `format` gpx/kml/fit, `scope` — **moment de valeur** |
| Carte | `map_tool_selected` | `tool` tracer/split/forbidden_zone/chart_placement/comment |
| | `layer_toggled` | `layer` labels/contours/slopes/altitude/weather/wind/snow/sunlight/routes, `enabled` |
| | `basemap_changed` (`basemap`), `map_filter_toggled` (`filter`), `place_selected`, `context_menu_action` (`action`) | |
| | `freecam_entered`, `google_earth_opened` (`from` map/lidar) | |
| Analyse | `roadbook_tab_opened` (`tab` sheet/agenda, clic `data-umami-event`), `poi_favorited` (`enabled`, `category`), `fit_uploaded` (`files`), `pace_prediction_run` (`sport`, `fit_files`) | |
| Flyover | `flyover_played` (`distance_km`), `flyover_finished` (`completed` <25…100), `flyover_video_exported` (`format`, `outcome`, `duration`) | |
| LiDAR | `lidar_tile_downloaded` (`territory`, `outcome`), `lidar_viewer_opened` (`engine` webgpu/webgl/terrain, `tiles`), `lidar_tool_used` (`tool`), `snow_mode_enabled` (`mode`), `gpu_context_lost` (`engine`) | |
| Co-édition | `share_dialog_opened`, `share_invite_sent`, `share_invite_failed`, `collab_session_joined` (`peers`), `comment_created` (`anchor`, `on` map/lidar), `comment_replied`, `comment_resolved`, `follow_started` (`via`), `spotlight_started` | |

Web Vitals (LCP, INP, CLS, FCP, TTFB) : collectés par le tracker
(`data-performance`), par écran et par release.

## Rapports

- **Versionnés** (`npm run analytics:sync`, idempotent par nom, valide la spec
  contre le plan de marquage avant d'envoyer) : 7 entonnoirs (activation
  inscription → export GPS ; première session des comptes du jour ;
  planification ; co-édition ; LiDAR ; flyover ; monétisation), 6 objectifs,
  5 segments (anglophones, Instagram, landing, campagnes UTM, mobile).
- **5 tableaux de bord** (`scripts/umami/boards.ts`, même synchro ; composants
  et mise en page lus dans le code d'Umami 3.4 : lignes de 1 à 4 colonnes, blocs
  texte, entonnoirs/objectifs cités par nom) : 1 · L'essentiel, 2 · Nouveaux
  utilisateurs, 3 · Fonctions utilisées, 4 · Qui et sur quoi, 5 · Vitesse et
  pannes. Chaque graphique a un titre en question simple et une phrase de
  lecture ; chaque tableau ouvre sur un bloc « Comment lire ce tableau ».
- **Base** : `npm run analytics:report` (« En bref » en phrases, cohortes, usage).
- **MCP** : Claude Code interroge Umami directement (outils `list_websites`,
  statistiques, entonnoirs, objectifs, rétention, performance), clé API en
  lecture seule hors du dépôt.

## Ajouter un événement

1. Son type dans `events.ts` (nom `objet_action`, propriétés en catégories,
   tranches ou valeurs arrondies).
2. L'appel `trackAnalyticsEvent` au point de passage le plus central (un
   réducteur, un store, un contrôleur) plutôt qu'à chaque bouton ; pour un simple
   clic, `analyticsAttrs()` sur l'élément.
3. S'il compte dans un entonnoir ou un objectif : `scripts/umami/spec.ts`, puis
   `npm run analytics:sync`.
4. `npm run e2e:journey` vérifie les écrans et événements du parcours principal
   et qu'aucune charge utile ne porte de donnée personnelle.

## Instance

`server/vps/umami/` : compose (Umami 3.4.0 épinglé par digest, secrets dans le
`.env` du VPS, MCP activé, IP lue dans `X-Real-IP` seulement), purge à 25 mois.
Mise à jour : changer tag + digest, `pg_dump`, `docker compose pull && up -d`.
Sauvegarde : dump `umami-db` chaque nuit (`server/vps/backup/`).
