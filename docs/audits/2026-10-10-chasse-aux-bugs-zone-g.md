# Chasse aux bugs — 2026-10-10 — zone G (vie privée côté client, exports restants, édition de la feuille de route)

Suite de `2026-10-10-chasse-aux-bugs.md` (zones A à F), même méthode. Rien n'est corrigé ici (consigne de l'utilisateur : audit seulement). Flyover et export vidéo hors périmètre.

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

Preuves : tests Vitest et scripts jetables gardés hors du dépôt (scratchpad de la session) ; « lu » = établi à la lecture seulement.

## Zones

| # | Zone | État |
|---|------|------|
| G1 | Vie privée côté client : GlitchTip et journaux de console envoyés (Umami, consentement santé et export « Vos données » : déjà couverts par la zone A, A10-A11) | fait : 1 constat (P3) |
| G2 | Exports restants (`.redview`, KML, feuille de route) | fait : 1 constat (P2) |
| G3 | Édition de la feuille de route | fait : 1 constat (P2) |

## Synthèse par sévérité

| Sévérité | Constat | Preuve |
|---|---|---|
| P2 | G2-1 Export `.redview` d'un projet partagé : .fit et identité des autres membres | lu |
| P2 | G3-1 Point tiré sur le retour d'un aller-retour inséré à l'aller | test |
| P3 | G1-1 Journaux de console envoyés à GlitchTip avec des noms de fichiers | lu |

## Constats

### G1 — GlitchTip et journaux de console

#### G1-1 · P3 · Les journaux de console envoyés à GlitchTip portent des noms de fichiers de l'utilisateur (.fit, .redview) et des extraits de document

- **Où** : `src/main.tsx:24-55` : le SDK garde son intégration de fils d'Ariane par défaut, qui enregistre chaque `console.warn` / `console.error` (niveau `warn` en production, `shared/lib/logger.ts:18-19`) avec ses arguments ; `beforeBreadcrumb` → `scrubBreadcrumb` (`shared/lib/errorReportScrub.ts:35-46`) ne réduit que les champs `url` / `from` / `to`, jamais le `message` ni `data.arguments` d'un fil d'Ariane de console. Ces journaux contiennent des noms choisis par l'utilisateur : `fitFiles.ts:58, 215, 260` (noms des .fit — souvent la date et le titre de la sortie, données de santé selon la politique du projet), `projectBrowser/lib/projects/importProjects.ts:35-38` (nom du fichier `.redview`, souvent celui du projet), `usePredictionRun.ts:276`. Une erreur « projet illisible » envoie aussi l'erreur de `JSON.parse` d'origine (`useDashboardProjectState.ts:188`), dont le message V8 cite un extrait du document.
- **Scénario** (lu) : un import de `.redview` raté (« Sortie Ventoux avec Julie.redview ») puis, plus tard dans la session, n'importe quelle erreur envoyée à GlitchTip : le fil d'Ariane de console de cette erreur contient le nom du fichier. Les URL, en-têtes, cookies et corps sont bien retirés ; les noms, non.
- **Correctif proposé** : dans `beforeBreadcrumb`, pour `category === 'console'`, ne garder que le premier argument s'il est un littéral de préfixe (`[fitFiles] …`) et retirer `data.arguments` ; ou ne jamais passer de nom de fichier / de projet aux journaux (identifiants courts à la place) ; pour l'erreur « illisible », envoyer seulement le type d'erreur et la position.

### G2 — Exports restants

#### G2-1 · P2 · L'export `.redview` d'un projet partagé emporte les .fit des autres membres et leur identité

- **Où** : `src/features/redviewFile/lib/exportProject.ts:56-100` (`collectFitFiles` télécharge **tous** les `fitUploads` de chaque itinéraire, quel qu'en soit l'auteur — la lecture d'équipe le permet) ; `project.json` garde les fils de commentaires avec `authorId`, `authorName` et les `mentions` (identifiants Appwrite des autres éditeurs) ; seul `commentsView` (état de lecture) est retiré à l'import, pas à l'export. Rien ne distingue un projet partagé d'un projet personnel.
- **Scénario** (lu) : Alice partage un projet avec Bob ; Bob y a ajouté ses sorties .fit (traces GPS de ses entraînements, fréquence cardiaque : données de santé, art. 9). Alice exporte « Projet complet » et envoie le fichier à un tiers : les .fit de Bob et son nom, avec son identifiant de compte, partent avec. Bob avait consenti à l'usage de ses .fit dans RedView et au partage avec l'équipe, pas à leur export par quelqu'un d'autre.
- **Correctif proposé** : pour un projet partagé, n'exporter que les .fit dont l'utilisateur est l'auteur (propriété du fichier dans le bucket) et signaler ceux laissés de côté ; remplacer dans les commentaires l'identifiant et le nom des autres éditeurs par un libellé neutre (« Éditeur 2 »), ou proposer l'export sans les commentaires. À reporter dans la politique de confidentialité si le comportement actuel est gardé.

### G3 — Édition de la feuille de route

#### G3-1 · P2 · Tirer le tracé sur le retour d'un aller-retour insère le point de passage à l'aller

- **Où** : `src/features/itineraryPanel/components/ItineraryPanelContainer/timelineMutations.ts:35-90` (`insertWaypointAtRoutePosition`) : la position du point saisi (`anchor`) et celle de chaque ligne existante sont obtenues par `projectPointAlongRoute` sur **tout** le tracé, sans kilométrage connu ; sur un aller-retour, le premier passage gagne. Appelée par l'outil de déplacement du tracé (`centerPanel/tools/routeDragWaypoint/RouteDragWaypointContext.tsx:142`) et par les gestes du visualiseur LiDAR (`lidarViewerRouteEdit.ts:104`), alors que le point saisi sur la carte connaît son segment. Même famille que D1-1.
- **Scénario** : montée en aller-retour au sommet, l'utilisateur tire la **descente** vers un autre chemin : le nouveau point est rangé avant le sommet, le routage passe par lui à la montée, et la descente reste inchangée (ou le tracé fait un détour imprévu).
- **Preuve** : `g3-insert.test.ts` (scratchpad) : point saisi au km 7,2 de la descente → distance retenue **2 802 m**, ordre `start, nouveau point, summit, end` (attendu : après `summit`).
- **Correctif proposé** : passer la distance le long du tracé du point saisi (segment touché par le pointeur, déjà connu de `routeEditPointer`) et la préférer à la projection ; pour les lignes existantes, utiliser leur `distanceKm` quand il est connu (comme `findPromotableEndpointIndex`).

## Zones vérifiées sans constat

- **G1** : URL de page, de requête et de navigation réduites au chemin (`stripUrlSecrets`), y compris le lien de réinitialisation gardé en fil d'Ariane ; `request` réduit à l'URL (ni en-têtes, ni cookies, ni query) ; aucun corps de requête capturé (pas d'intégration de rejeu, pas de `sendDefaultPii`) ; envoi coupé depuis `localhost` ; erreurs réseau et d'annulation ignorées ; aucun message d'erreur de l'app ne construit d'URL de requête (coordonnées BRouter / météo / POI) ; seules deux captures explicites (`GlobalErrorBoundary`, projet illisible avec son id).
- **G2** : KML : noms et descriptions échappés (`escapeXml`), couleurs et styles tirés d'une table fixe (aucune valeur du projet dans un attribut) ; `.redview` : travail local de l'appareil retiré (`stripLocalWork`), chemins de bucket de l'expéditeur absents du fichier relu, .fit supprimé du stockage signalé et écarté, échec réseau → export refusé plutôt qu'incomplet, URL de téléchargement révoquée après une minute. Pas d'autre format d'export de la feuille de route (CSV / PDF) dans l'app.
- **G3** (lu) : supprimer le départ / l'arrivée promeut le point de passage le plus proche du début / de la fin selon son kilométrage (jamais un POI ni une pause), et rend `null` s'il n'y en a pas ; une nouvelle ligne s'insère toujours avant l'arrivée ; une pause déplacée est réinsérée à son kilométrage.
