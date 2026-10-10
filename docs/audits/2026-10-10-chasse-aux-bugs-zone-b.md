# Chasse aux bugs — 2026-10-10 — zone B (client / formats / persistance)

Seconde moitié de l'audit `2026-10-10-chasse-aux-bugs.md` (zone A : serveur / API / sécurité), même méthode, fusion à la fin. Rien n'est corrigé ici.

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

Preuves : tests Vitest et scripts tsx jetables, gardés hors du dépôt (scratchpad de la session) ; chaque constat dit comment il a été reproduit.

## Zones

| # | Zone | État |
|---|------|------|
| B1 | Import : GPX, FIT, `.redview` | fait : 3 constats (1 P0) |
| B2 | Export : GPX / FIT, noms GPS, horaires OSM | fait : 3 constats (P2 au plus) |
| B3 | Persistance : `shared/services/projects/*`, IndexedDB, bucket | fait : 4 constats (1 P0, 1 P1) |
| B4 | Horaire / prédiction côté app : pauses, heure de passage, DST | fait : 3 constats (P2 au plus) |
| B5 | Service Worker `public/sw-dem/**` | fait : 2 constats (P2 au plus) |

## Synthèse par sévérité

| Sévérité | Constat | Preuve |
|---|---|---|
| P0 | B1-1 Résultat async d'un projet quitté enregistré dans le projet ouvert ensuite | test (2 cas) |
| P0 | B3-1 Gros projet enregistré par deux onglets / appareils : document pointant sur un fichier supprimé, plus de charge dans le cloud | test |
| P1 | B3-2 Contrôle de conflit non atomique : écrasement silencieux | test |
| P2 | B1-2 Points GPX dans un commentaire XML lus comme tracé | test |
| P2 | B2-1 Nom GPS « fermé » pour un lieu ouvert après minuit au passage | test |
| P2 | B2-3 Heures de passage / horaires dans le fuseau du navigateur | lu |
| P2 | B3-3 Déconnexion qui efface les copies non synchronisées d'un autre compte | lu |
| P2 | B4-1 Agenda : chevauchement au changement d'heure du 25/10 | test (`TZ=Europe/Paris`) |
| P2 | B5-1 Échec passager d'AWS Terrarium mis en cache 1 h comme absence confirmée | lu |
| P3 | B1-3 `creator` avec apostrophe ; repli DOMParser incomplet | test |
| P3 | B2-2 Nom saisi avec une plage numérique : horaires perdus | test |
| P3 | B3-4 Session expirée : modifications en attente non gardées | lu |
| P3 | B4-2 Sans prédiction, horloge de passage sans pauses | lu |
| P3 | B4-3 Date / heure de départ hors bornes acceptées | test |
| P3 | B5-2 Caches de tuiles sans limite, quota partagé avec les projets | lu |

## Constats

### B1 — Import

#### B1-1 · P0 · Un résultat async du projet qu'on vient de quitter écrase le projet ouvert ensuite

- **Où** : `src/features/itineraryPanel/context/ProjectStore/provider.tsx:117-126` (`commitProject` appelle `onProjectChangeRef.current` sans savoir si le provider est encore monté) → `src/pages/Dashboard/hooks/useDashboardProjectState.ts:286-300` (`handleProjectChange`, identité stable d'un projet à l'autre) → `src/pages/Dashboard/hooks/useDashboardProjectSync.ts:330-356` (`queueProjectSave` enregistre sous `activeProjectIdRef.current`, c.-à-d. le projet **courant**).
- **Mécanisme** : `ProjectProvider` est remonté par projet (`key={activeProjectId}`, `DashboardEditor.tsx:488`), mais l'ancien garde son `projectRef` et son `onProjectChangeRef`. Toute écriture qui arrive après le changement de projet (fin d'un import GPX : raccords BRouter jusqu'à 90 s + altimétrie IGN ; revêtements « plusieurs dizaines de secondes sur un ultra » ; toponymes ; tout `setProject`/`addItinerary` appelé depuis une promesse non annulée au démontage) passe par `commitProject` → `handleProjectChange` → `queueProjectSave(document de A)` avec l'id de B. Le document entier de A (itinéraires, nom, commentaires) est enregistré dans la ligne de B (cloud + copie locale), le nom de B dans l'URL devient celui de A, et la vue de A part dans `project_views` de B.
- **Scénario** : ouvrir A, importer un GPX de 600 km avec des discontinuités (ou lancer un import puis attendre l'analyse des revêtements), ouvrir B depuis le gestionnaire de projets avant la fin → à la fin de l'import, B contient le document de A + l'itinéraire importé. Le contenu de B est perdu (aucun historique de versions côté cloud).
- **Preuve** : test jetable `b1-late-write.test.ts` (scratchpad), deux cas verts : (1) un `ProjectProvider` démonté appelle encore `onProjectChange` sur `setProject` ; (2) avec le vrai `useDashboardProjectState` (mêmes simulations que `useDashboardProjectState.test.ts`), ouvrir A puis B, puis appeler le `handleProjectChange` qu'avait reçu le provider de A avec le document de A → `saveProject('B', { name: 'Projet A + import GPX' })`.
- **Si B est un projet partagé (session temps réel)** — vérifié à la lecture, non reproduit par test : le document de A n'atteint **pas** la salle de B. Le lien collab est une prop du provider de B ; celui de A a vidé son `boundLinkRef` au démontage (`provider.tsx:312-313`) et ne fait plus que noter ses écritures dans un `preSessionRef` jamais rebranché. Mais (1) `saveProject(B, docA)` réécrit la **copie IndexedDB de B** (`localOnly` car `isServerOwnedDocument`, `projectRows.ts:544`) avec un `updated_at` récent ; (2) à la réouverture suivante de B, `getProjectRow` préfère cette copie, plus récente que le point de reprise du serveur (`projectRows.ts:345-350`) : l'utilisateur voit le contenu de A sous le nom de B pendant la connexion, jusqu'au `welcome`. Les modifications faites dans cet intervalle sont rejouées en différences contre l'instantané du serveur (pas de document entier envoyé), donc la salle reste saine ; (3) dans tous les cas (partagé ou non), `activeProjectSnapshotRef` contient le document de A jusqu'à la prochaine modification de B : un export « Projet complet » (`.redview`, `getActiveProjectSnapshot`) ou un Ctrl+S fait juste après exporte / enregistre A sous B.
- **Correctif proposé** : (a) dans `ProjectProvider`, un `disposedRef` posé au démontage ; `commitProject` / `writeProject` ne font plus rien (journal d'avertissement) une fois démonté ; (b) défense en profondeur côté Dashboard : passer au provider un `onProjectChange` lié à l'id du projet pour lequel il a été créé, et ignorer l'appel si `activeProjectIdRef.current` diffère ; (c) annuler les tâches d'import (AbortController) au démontage. Test de non-régression : le cas (2) ci-dessus doit ne rien enregistrer sous B.

#### B1-2 · P2 · Les points GPX à l'intérieur d'un commentaire XML (ou d'un CDATA) sont lus comme des points du tracé

- **Où** : `src/features/poi/lib/gpx-parse.ts:155-185` (`forEachElement`, recherche par expression régulière sur le texte brut, sans retirer `<!-- … -->` ni `<![CDATA[…]]>` hors des éléments texte).
- **Scénario** : `<trkpt lat="45" lon="6"/><!-- <trkpt lat="48" lon="2"/> --><trkpt lat="45.01" lon="6"/>` → 3 points, 904,5 km au lieu de 1,1 km ; le point « commenté » (Paris) crée ensuite deux sauts que `bridgeImportedGpxGaps` va router par BRouter (aller-retour jusqu'à Paris dans le tracé importé). Des éditeurs de GPX et des exports à la main commentent des points pour les désactiver.
- **Preuve** : `b1-gpx-edges.test.ts` (« point commenté » → `[3, "904.5"]`). Le repli DOMParser, lui, ignore les commentaires : les deux analyseurs divergent.
- **Correctif proposé** : avant l'analyse, remplacer chaque `<!--[\s\S]*?-->` par des espaces de même longueur (les décalages de `extractTrackSegmentStarts` restent justes) ; idem pour une section CDATA hors d'un élément texte.

#### B1-3 · P3 · `creator` avec une apostrophe perdu ; analyseur de repli moins complet

- **Où** : `gpx-parse.ts:84` (`GPX_CREATOR_REGEX` : `[^"']*` s'arrête à la première apostrophe d'une valeur entre guillemets) ; `gpx-loader.ts:136-150` (le repli DOMParser ne lit ni `<cmt>` ni `<redview:category>`).
- **Scénario** : `<gpx creator="Bob's tool">` → `creator: null`. Un GPX exporté par RedView et relu par le repli perd la catégorie exacte de ses POI.
- **Preuve** : `b1-gpx-edges.test.ts` (« creator » → `null`) ; lecture du repli.
- **Correctif proposé** : `(["'])((?:(?!\1).)*)\1` ; aligner les champs du repli sur l'analyseur rapide (ou les tester ensemble sur les mêmes fichiers).

### B2 — Export

#### B2-1 · P2 · Nom GPS « fermé » pour un lieu ouvert après minuit au moment du passage

- **Où** : `src/features/poi/lib/autoSort/openingHours.ts:257-277` (`openingIntervalsOnDate` ne rend que les plages qui **commencent** le jour donné) utilisé par `src/features/exporter/lib/exportHelpers.ts:388-392` ; à comparer à `statusOnDate` (`:180-190`), qui ajoute la queue de la veille (`spill`).
- **Scénario** : bar `Fr-Sa 18:00-02:00`, passage prévu dimanche 01:00 → le tri automatique et la pastille disent « ouvert » (`evaluateOpeningHoursAt` = `open`), mais le nom exporté vers le Garmin est `BAR_D20_fermé_…`. Inversement, un passage samedi 01:00 affiche `18-2` (les horaires du samedi soir) alors que le coureur passe pendant la soirée du vendredi. C'est justement le cas d'usage de nuit des ultras.
- **Preuve** : `b2-names.test.ts` → `["Fr-Sa 18:00-02:00", "sam", "18-2", "dim01h", "fermé", "statut dim 01h", "open"]`.
- **Correctif proposé** : quand le passage tombe dans la queue d'une plage de la veille (`minute < spill.end`), écrire cette plage (`18-2`) plutôt que celles du jour ; au minimum ne jamais écrire « fermé » si `evaluateOpeningHoursAt` dit `open`. Test : les deux passages ci-dessus.

#### B2-2 · P3 · Un nom saisi contenant une adresse ou une plage numérique perd les horaires

- **Où** : `src/features/exporter/lib/gpsNames.ts:180` (`HANDWRITTEN_HOURS`).
- **Scénario** : colonne « Nom » = `Boulangerie 12-14 rue` → reconnu comme des horaires écrits à la main, l'export n'ajoute pas `7-19` : `BOU_G03_Boulangerie 12-14 rue`. Idem `Km 120-125`, `Route 7-9`.
- **Preuve** : `b2-names.test.ts` (« édité avec horaires manuscrits »).
- **Correctif proposé** : n'accepter comme horaires que des heures plausibles (0-24, le second ≥ le premier ou après minuit) et exiger un séparateur d'heure (`h`, `:` ou `.`) ou une position en tête du nom ; garder le comportement actuel pour `7-19`, `8h30-12h`.

#### B2-3 · P2 · Heures de passage et horaires des POI calculés dans le fuseau du navigateur, jamais dans celui du lieu

- **Où** : `src/features/itineraryPanel/sections/timeline/TimelineTimelineView/utilsParts/format.ts:45-59` (`parseDateTime` : `new Date(a, m, j, h, min)` = heure locale du **navigateur**) ; `openingHours.ts:205,235-245` (`getDay()`, `getHours()` du navigateur) ; `exportHelpers.ts:388-392`, `exportFit.ts:114-121`.
- **Scénario** (lu, non reproduit par test) : planifier depuis la France une course au Portugal, au Royaume-Uni (UTC+0/+1) ou dans l'Est de l'Europe (Transcontinental, jusqu'à UTC+3) : le départ « 08:00 » est 08:00 heure de Paris ; chaque passage est comparé aux horaires OSM (heure locale du lieu) avec 1 à 2 h d'écart : boulangerie « fermée » à l'export alors qu'elle ouvre, ou l'inverse. Les horodatages du FIT (instants absolus) sont décalés d'autant par rapport à ce que veut dire l'utilisateur. Même avec un seul fuseau, un navigateur réglé sur un autre fuseau que le lieu (déplacement, VPN d'entreprise) décale tout.
- **Correctif proposé** : stocker le fuseau du départ (IANA, déduit du premier point du tracé ou choisi) avec `startDate`/`startTime`, construire le départ dans ce fuseau, et évaluer les horaires d'un POI dans le fuseau de sa position (table pays → fuseau, ou celui du départ en première approche). À défaut, l'indiquer dans le panneau Exporter (« horaires évalués à l'heure de … »).

### B3 — Persistance

#### B3-1 · P0 · Gros projet (charge dans le bucket) enregistré par deux onglets / appareils à la fois : le document pointe sur un fichier supprimé, plus aucune copie dans le cloud

- **Où** : `src/shared/services/projects/projectRows.ts:560-610` (contrôle de version **avant** l'envoi du fichier, puis `updateDocument` sans condition) + `payloadFiles.ts:96-115` (`pruneProjectPayloadFiles` supprime **tous** les fichiers `<projectId>.json.gz` sauf celui que **cet onglet** vient d'écrire), appelé par `settlePayloadFiles` (`cloudDocuments.ts:225-230`). La file `cloudQueues` ne sérialise les envois que dans un onglet ; rien ne coordonne deux onglets (ni Web Lock, ni BroadcastChannel) ni deux appareils.
- **Scénario** : projet de plus de ~12 M de caractères (charge `file:`), ouvert dans deux onglets (ou sur le portable et le fixe), modifié des deux côtés à quelques secondes d'intervalle. X et Y passent tous deux le contrôle de version, envoient chacun leur fichier (fX, fY), X écrit le document (→ fX) puis **supprime fY** ; Y écrit ensuite le document (→ fY, déjà supprimé) puis **supprime fX**. Les deux sauvegardes réussissent ; le cloud n'a plus aucune charge : à l'ouverture sur un autre appareil, le projet est illisible (`offline` dans le test, en boucle). Seules les copies IndexedDB des deux onglets gardent le contenu, marquées propres (`markLocalSynced`), donc jamais renvoyées tant que le document ne change pas. La fenêtre de course est la durée de l'envoi du fichier (jusqu'à 30 Mo : plusieurs secondes à minutes sur une connexion lente).
- **Preuve** : `b3-payload.race.test.ts` (scratchpad, config `vitest.race.config.mjs` : vrai `projectRows` dans deux graphes de modules = deux onglets, un seul faux Appwrite partagé, encodage forcé sur le chemin fichier, latences 50 / 300 ms sur `updateDocument`) → `saves: [fulfilled, fulfilled]`, `pointeur file:doc0004`, `fichier présent: false`, `fichiers restants: 0`, réouverture sur un troisième appareil → erreur.
- **Correctif proposé** : (1) ne jamais supprimer un fichier plus récent que celui qu'on garde : `pruneProjectPayloadFiles` relit le document après l'écriture et ne supprime que les fichiers **antérieurs** au fichier pointé (date de création) et différents de lui ; (2) contrôle de version + écriture atomiques par une transaction Appwrite (déroulé dans B3-2), l'élagage seulement après un commit réussi ; (3) au chargement, si le fichier pointé manque, se rabattre sur le plus récent fichier du projet encore présent.

#### B3-2 · P1 · Contrôle de conflit non atomique : deux enregistrements concurrents s'écrasent sans conflit (perte silencieuse)

- **Où** : `projectRows.ts:570-597` : `getDocument($updatedAt)` puis, plus tard, `updateDocument` sans condition. Entre les deux : `writeCloudData` (envoi du fichier pour un gros projet) et un aller-retour réseau.
- **Scénario** : même projet ouvert dans deux onglets ou sur deux appareils ; X et Y enregistrent dans la même fenêtre → les deux réussissent, la modification de X disparaît du cloud sans message (l'invite « version d'un autre appareil » n'apparaît jamais). De plus, la copie IndexedDB est commune aux onglets (clé = id du projet) et `localRevisions` propre à chaque onglet : l'onglet X peut marquer « propre » (`markLocalSynced`) une copie locale que Y vient de réécrire.
- **Preuve** : `b3-payload.race.test.ts`, second cas (petit projet, charge dans le document) → `saves: [fulfilled, fulfilled]`, nom final `Petit — Y`, modification de X perdue.
- **Correctif proposé (piste retenue : transactions Appwrite, disponibles depuis 1.8, donc sur la prod 2.3.0)** : le SDK web épinglé (`appwrite` 28.1.0) expose `createTransaction`, `updateDocument(…, transactionId)` et `updateTransaction(id, commit, rollback)` (`node_modules/appwrite/types/services/databases.d.ts:34-91, 306`). D'après la documentation (https://appwrite.io/docs/products/databases/transactions), au commit Appwrite vérifie que les lignes touchées « n'ont pas changé depuis leur mise en attente » et sinon échoue avec une erreur de conflit. Déroulé : (1) envoyer le fichier de charge si besoin (hors transaction) ; (2) `createTransaction` ; (3) **mettre en attente d'abord** `updateDocument(…, transactionId)` (c'est ce moment qui sert de référence) ; (4) relire `$updatedAt` et le comparer à la version connue : différent → `rollback` + conflit ; (5) `commit` : un conflit au commit = conflit utilisateur ; (6) seulement après un commit réussi, élaguer les fichiers (règle de B3-1). Ordre important : un contrôle fait avant la mise en attente laisse la même fenêtre qu'aujourd'hui. Points à vérifier avant de livrer : que la vérification au commit porte bien sur une ligne seulement mise à jour (la doc dit « affected rows »), le comportement sur l'instance auto-hébergée 2.3.0, et l'ajout des transactions au faux SDK (`src/shared/test/mockAppwriteSdk.ts`) pour rejouer ce test. L'alternative (route `api/projects/save` sous `createKeyedLock`) ne protège que si le client perd le droit d'écrire la ligne directement (sinon un client plus ancien la contourne) et ne tient qu'avec une seule instance de l'API : moins sûre que la transaction. Entre onglets d'un même navigateur, un `navigator.locks.request('rv-project-save:' + id)` autour de l'envoi évite en plus les conflits inutiles.

#### B3-3 · P2 · La déconnexion d'un compte efface les modifications non synchronisées d'un autre compte du même appareil

- **Où** : `src/features/projectBrowser/account/lib/profile.ts:276-322` : `syncPendingProjectsBeforeSignOut` ne vérifie que les copies de l'utilisateur courant (`listDirtyProjects` filtre par `isOwnedBy`, `projectRows.ts:171-176`), puis `clearProjectStore()` supprime **toute** la base IndexedDB.
- **Scénario** (lu, non reproduit) : appareil partagé (club, famille). La session de A expire (`SESSION_EXPIRED_EVENT` → écran de connexion, sans rechargement ni purge) alors que A a des modifications hors ligne non envoyées (`dirty`). B se connecte sur le même onglet, puis se déconnecte : aucune alerte (les projets de A ne sont pas listés), la base est supprimée, le travail de A est perdu. Même chose pour `clearLocalAccountData` à la suppression du compte de B.
- **Correctif proposé** : à la déconnexion, ne supprimer que les lignes de l'utilisateur courant (et les miniatures / vues / caches correspondants), ou refuser la purge s'il reste des copies `dirty` d'un autre compte (et le dire sans nommer ses projets).

#### B3-4 · P3 · Session expirée : les dernières modifications en attente ne sont pas gardées localement

- **Où** : `App.tsx:197-205` vide la session **avant** de démonter le Dashboard ; au démontage, `flushPendingLocally` → `saveProjectLocally` → `getCurrentUserId()` lève `unauthorized` (`auth.ts:46-54`), l'erreur est seulement journalisée (`useDashboardProjectSync.ts:306-314`).
- **Scénario** (lu) : la session expire ; ce qui a été modifié depuis la dernière copie locale (fenêtre d'autosave) disparaît au retour à l'écran de connexion, même si la même personne se reconnecte aussitôt.
- **Correctif proposé** : mémoriser l'id de l'utilisateur de la session ouverte dans le Dashboard et le passer à la copie locale, ou faire la copie locale avant `clearStoredAppwriteSession()` (événement « session expirée » traité en deux temps).

### B4 — Horaire / prédiction côté app

#### B4-1 · P2 · Agenda : les blocs se chevauchent au changement d'heure d'automne (25/10/2026), un trou d'une heure au printemps

- **Où** : `src/features/itineraryPanel/sections/timeline/TimelineTimelineView/utilsParts/event-schedule.ts:181-205` (`buildDaySegments`) : le haut d'un bloc vient de l'heure murale (`getMinuteOfDay` = `getHours() * 60 + …`, `format.ts:193`), sa hauteur de la durée écoulée réelle. Le 25/10, de 02:00 à 03:00 l'heure murale se répète (journée de 25 h) ; le 28/03/2027 elle saute d'une heure.
- **Scénario** : départ samedi 24/10 au soir, nuit sur la selle. Un bloc commence à 01:30 (heure d'été) et dure 120 min de selle → il finit à 02:30 (heure d'hiver). Le bloc suivant commence à 02:30 → `A = [100, 220] px`, `B = [160, 220] px` : B est entièrement recouvert par A. Au printemps, deux blocs consécutifs d'une heure à partir de 01:30 → `A = [100, 160]`, `B = [220, 280]` : un trou d'une heure au milieu d'une sortie continue. Les étiquettes d'heure, elles, sont justes (instants absolus) : seule la géométrie est fausse. Toute épreuve de plusieurs jours qui roule la nuit du 24 au 25/10 est concernée.
- **Preuve** : `b4-dst.test.ts` lancé avec `TZ=Europe/Paris` (offset vérifié : −60 le 25/10 à midi) → valeurs ci-dessus.
- **Correctif proposé** : placer les blocs d'une journée par minutes **écoulées depuis le minuit local** (`(instant − dayStart) / 60 000`) sur une colonne dont la hauteur est la vraie durée du jour (`dayEnd − dayStart` : 1 380, 1 440 ou 1 500 min), et dessiner la grille horaire en conséquence (02:00 répété, 02:00 absent). L'astuce existante (`RELATIVE_DAY_EPOCH` en mai) ne couvre que les agendas sans date.

#### B4-2 · P3 · Sans prédiction, l'horloge de passage oublie toutes les pauses

- **Où** : `src/features/itineraryPanel/lib/schedule/passageClock.ts:105` (`stopAnchors = usable ? … : []`).
- **Scénario** (lu) : itinéraire sans prédiction (prédiction pas encore calculée, en échec, ou discipline sans moteur) avec une nuit de 6 h planifiée à mi-parcours : à vitesse de repli, les heures de passage de la seconde moitié (horaires du jour dans les noms GPS, horodatage du FIT, tri auto des POI) sont 6 h trop tôt — les pauses de la feuille de route sont pourtant connues.
- **Correctif proposé** : construire les ancres de pause sur le modèle de repli (même `buildScheduledTimelineState` avec une prédiction synthétique à vitesse constante), ou signaler dans le panneau Exporter que l'horaire n'inclut pas les pauses.

#### B4-3 · P3 · Date / heure de départ hors bornes acceptées en silence

- **Où** : `format.ts:45-59` (`parseDateTime` ne vérifie ni le jour du mois ni l'heure).
- **Scénario** : `startDate = "2026-02-31"`, `startTime = "25:99"` (document venu d'un `.redview` ou d'un autre éditeur ; l'interface ne permet pas de les saisir) → départ le **4 mars à 02:39**, `hasRealDate: true`. Un départ à 02:30 le 28/03/2027 (heure qui n'existe pas) devient 03:30 sans avertissement.
- **Preuve** : `b4-dst.test.ts` (« date invalide », « départ 02:30 le jour du changement »).
- **Correctif proposé** : rejeter une date dont `getDate()`/`getMonth()` ne correspondent pas à la saisie et une heure > 23:59 (retour au départ sans date) ; signaler l'heure inexistante du printemps.

### B5 — Service Worker

#### B5-1 · P2 · Hors France / Suisse / Norvège / Espagne, un échec passager d'AWS Terrarium devient un « trou » de relief d'une heure

- **Où** : `public/sw-dem/runtime/dem-handler/compute-request.js:583-605` : `isConfirmedEmpty = globalHighZoomParentMesh || (!tileIsInFrance && !inSwitzerland && !inNorway && !considerSpain)` ; la tuile est alors mise en cache négatif avec `NEGATIVE_TTL_CONFIRMED` (1 h, `core/config.js:360`). Or `fetchAWSTerrainTile` (`sources/aws-terrain.js:51-160`) rend `null` pour **toute** erreur : HTTP 5xx / 429, coupure réseau, délai de 6 s (`AbortSignal.timeout(6000)`, qui n'est pas l'annulation de la requête testée par `isAborted`), file de 32 créneaux saturée.
- **Scénario** (lu, non reproduit : le pipeline complet ne se charge pas dans le harnais `vm` de `test/service-worker/`) : en Italie, en Autriche, en Belgique… (tout ce qui n'a pas de LiDAR national), un déplacement rapide de la carte sur une liaison lente fait expirer quelques requêtes Terrarium → ces tuiles répondent 204 « confirmé » pendant une heure (le maillage parent s'affiche, relief grossier par plaques) ; seul un « recharger les surcouches » (`CLEAR_NEGATIVE_CACHE`, `useMap/controller/reload.ts:43`) les fait revenir. Hors zoom > `MAPBOX_DEM_MAXZOOM`, l'absence n'est jamais « confirmée » : Terrarium couvre le monde entier.
- **Correctif proposé** : distinguer dans `fetchAWSTerrainTile` une vraie absence (404) d'un échec passager (exception, délai, 5xx, 429) et n'utiliser `NEGATIVE_TTL_CONFIRMED` que pour la première (ou pour `globalHighZoomParentMesh`) ; un échec passager prend `NEGATIVE_TTL_PIPELINE` (2 s).

#### B5-2 · P3 · Caches de tuiles du SW sans limite de taille, dans le même quota que les projets

- **Où** : `public/sw-dem/runtime/lifecycle.js:15-48` : seuls les caches d'une **ancienne** époque sont purgés ; aucun plafond ni éviction LRU sur `dem-tiles-*`, `ortho-tiles-*`, `vhr-tiles-*`, `slope-tiles-*`, `altitude-tiles-*`, `contour-tiles-*` (les seules bornes, `*_HOT_CACHE_MAX` / `IGN_CACHE_MAX`, portent sur la mémoire). Une invalidation `INVALIDATE_DERIVED_TILE` relit en plus **toutes** les clés du cache de pente et d'altitude (`lifecycle.js:345-365`) : coût linéaire en nombre de tuiles déjà en cache, à chaque tuile DEM améliorée.
- **Scénario** (lu) : à force de parcourir la France à 0,40 m (tuiles DEM, ortho 20 cm, THR 5 cm), CacheStorage grossit sans fin. L'origine partage son quota avec IndexedDB (projets, copies `dirty`) et OPFS (LiDAR) : copies locales des projets qui échouent faute de place (`localCopy.ts`, « stockage de l'origine plein ») ; et une fois le stockage persistant accordé pour le LiDAR, le navigateur ne libère plus rien de lui-même.
- **Correctif proposé** : plafond par famille de caches (nombre d'entrées ou octets, horodatage `x-cached-at` déjà présent) avec éviction des plus anciennes au repos ; pour l'invalidation, supprimer directement les URL connues (`cache.delete(new Request(url))`, en tenant compte des paramètres de requête) au lieu de parcourir `keys()`.

## Zones vérifiées sans constat

- **B2** : échappement XML (`& < > " '`, caractères de contrôle C0, U+FFFE/FFFF retirés ; `<cmt>` / `<desc>` / extension échappés ; ordre des éléments du schéma GPX 1.1) ; nom GPS nettoyé des caractères de contrôle (`Café\u0000caché` → `Café caché`) ; émojis gardés entiers ; chaînes FIT coupées à 254 octets sans jamais couper un caractère (200 émojis → 252 octets, 126 unités UTF-16 décodables en strict) ; la colonne « Nom GPS » coupe à 15 points de code (`Array.from`) ; horaires OSM : `Mo-Fr 08:00-12:00,14:00-18:00; PH off` (samedi → « fermé »), `24/7`, `00:00-24:00` → `24h`, virgule entre règles, `08:00-12:00 ; 14:00-18:00` (la seconde règle remplace la première, conforme à la spec), `sunrise-sunset` / commentaires entre guillemets → inconnu (rien d'écrit plutôt qu'un faux « fermé ») ; horodatages FIT = instants absolus (justes à travers le changement d'heure).
- **B3** : `listDirtyProjects` / `syncDirtyProjects` filtrés par propriétaire ; `getProjectRow` ne sert jamais la copie d'un autre compte (`isOwnedBy`) et efface la copie d'une ligne lisible par tous mais pas à l'utilisateur ; la déconnexion recharge la page (état de session en mémoire remis à zéro) et vide localStorage `redview:*` ; une copie locale ratée est signalée (`failingLocalCopies`) ; un envoi de fichier raté supprime son fichier ; projets partagés jamais écrits par `saveProject` ; chemin du bucket pour un seul onglet couvert par la simulation de persistance (`script-test-bench/audit/a-persistence-sim.ts`, scénario C1e).
- **B5** : le tampon d'en-tête de `sw-dem.js` a été changé à chaque commit qui modifie la logique sous `public/sw-dem/` (15 derniers commits ; seul `800ff447`, commentaires uniquement, ne l'a pas changé) ; les caches d'une ancienne époque sont purgés à l'activation ; une requête annulée ne met rien en cache négatif ; les remplaçants provisoires (parent, AWS d'urgence) ont un cache court et une reconstruction en arrière-plan.
- **B4** : `pauseAwareSchedule` (pauses triées, durées non finies ou nulles écartées, mémo indexé sur la prédiction + `timeline` + `rhythm`) ; un POI exactement à l'emplacement d'une pause reçoit l'heure d'arrivée avant la pause ; départ 23:50 sans date → le lendemain à 23:50 ; heures de passage = départ + secondes écoulées (justes à travers le changement d'heure) ; agenda sans date sur un calendrier fictif de mai (pas de changement d'heure).

- **B1 GPX** : décodage (BOM UTF-16, UTF-16 sans BOM, `encoding` déclaré, latin-1 non déclaré → accents justes), 0 / 1 point / longueur nulle refusés avec un message, coordonnées hors bornes ou `1e400` écartées, `NaN`, virgule décimale, antiméridien (222 m et non 40 000 km), fichier tronqué (corps borné à l'ouverture suivante), parcours linéaire (pas de retour arrière quadratique), plafond 50 Mo, segments multiples → raccords routés jamais en ligne droite (`importedGpxGaps.ts`), route `<rtept>` clairsemée de 500 points (499 pas → une requête découpée récursivement par `resolveRouteRequest`), `MAX_BRIDGE_REQUESTS` et délai de 90 s, revêtements reportés seulement si la géométrie n'a pas changé, noms résolus seulement sur les lignes non modifiées.
- **B1 FIT** : `validateFitHeader` (taille d'en-tête, signature, taille des données, troncature, plafond 30 Mo, parcours « course » refusé dès la sélection) ; lecteur Rust `fit_parser/fast.rs` : chaque lecture est bornée (`parse_definition`, `read_scalar` avec `checked_add`, charges utiles contre `body_end`, segments chaînés vérifiés) et tout écart retombe sur la crate `fitparser` ; une erreur du moteur nomme le fichier fautif (`Error parsing FIT file #N`). Pas de fuzz du WASM lancé (pas de .fit d'activité dans le dépôt).
- **B1 `.redview`** : `npm run bench:redview` vert (bombes, CRC, troncature, chemins hors `fit/`, gros projet 27 Mo) ; relu : EOCD borné, ZIP64 / chiffrement / multi-volume refusés, entrées en double refusées, décompression arrêtée au-delà de la taille annoncée, CRC vérifié, `__proto__` retiré, `fitUploads` du fichier toujours effacés (aucune référence au bucket de l'expéditeur ne suit), `.fit` reconnus à leurs octets, rollback (projet + .fit envoyés) si l'enregistrement final échoue, consentement santé demandé avant les .fit ; `shapeProject` + `normalizeItineraryProject` typent ce que lit l'éditeur.
