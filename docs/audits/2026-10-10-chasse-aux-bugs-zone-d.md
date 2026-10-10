# Chasse aux bugs — 2026-10-10 — zone D (routage client, tampons, gestionnaire de projets)

Suite de `2026-10-10-chasse-aux-bugs.md` (zones A à C), même méthode. Rien n'est corrigé ici.

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

Preuves : tests Vitest et scripts jetables gardés hors du dépôt (scratchpad de la session) ; « lu » = établi à la lecture seulement.

## Zones

| # | Zone | État |
|---|------|------|
| D1 | Routage côté client (`itineraryPanel/lib/brouter`, `useItineraryBrouterRouting*`) | fait : 1 constat (P1) |
| D2 | Tampons des résultats (`routedInputsKey`, `predictionInputsKey`) | fait : 2 constats (1 P1) |
| D3 | Gestionnaire de projets (`projectBrowser`) | fait : 3 constats (P2 au plus) |

## Synthèse par sévérité

| Sévérité | Constat | Preuve |
|---|---|---|
| P1 | D1-1 Aller-retour : correctif rattaché au mauvais passage, la boucle (sommet, détour) disparaît | test |
| P1 | D2-1 Prédiction jamais recalculée après l'affinage IGN des altitudes ou l'ajout des revêtements | test |
| P2 | D2-2 Prédiction à estampille périmée gardée à l'ouverture (distance à 500 m près) | lu |
| P2 | D3-1 Cycle de dossiers par deux déplacements croisés : dossiers et projets invisibles | test |
| P2 | D3-2 Projet partagé : nom de la liste et nom de l'éditeur divergents | lu |
| P3 | D3-3 Nom > 255 caractères : sauvegarde suspendue avec un faux message « trop volumineux » | lu |

## Constats

### D1 — Routage côté client

#### D1-1 · P1 · Aller-retour : une borne de correctif posée sur le retour est rattachée à l'aller, le correctif supprime la boucle (sommet, détour ravitaillement) sans rien dire

- **Où** : `src/features/itineraryPanel/hooks/useItineraryBrouterRoutingShared/routeGeometry.ts:94-107, 114-140` : `routePatchBoundaryDistanceM` restreint la recherche à ±(5 km + 2 %) autour du kilométrage mémorisé de la borne, puis `projectOnRouteRange` garde le segment au **plus petit écart latéral**, à égalité le **premier** (`<` strict). Sur un aller-retour, les deux passages sont sur la même route (écart ~0 des deux côtés) : le passage de l'aller gagne même quand le kilométrage indique le retour. Utilisé par `planRouteSplice` / `replaceRouteSegment` (`routeSplice.ts:101-140`, `routeSegments.ts:55-91`) et `anchorRoutePatchBound`.
- **Scénario** : montée en aller-retour à un col ou un sommet, ou détour de 2 km vers un village pour se ravitailler puis retour par la même route (cas courant en ultra et en trail). L'utilisateur déplace un point de passage juste après : la fenêtre du correctif part d'une borne prise sur la descente (km 7,2), qui est rattachée à la montée (km 2,8) ; le tronçon recollé saute tout l'aller-retour. Le tracé reste continu (aucune ligne droite, donc `RouteSeamError` ne se déclenche pas), mais le sommet ou le village a disparu, et les distances, le dénivelé et la prédiction suivent. Rien n'avertit l'utilisateur.
- **Preuve** : `d1-out-and-back.test.ts` (scratchpad), vraies fonctions sur un aller-retour synthétique de 5 km + 5 km : borne attendue ≈ 7,2 km, obtenue **2,80** ; `replaceRouteSegment` → tracé **15,00 → 10,62 km**, « passe par le sommet : false ». (Le plus grand saut, 140 m, est l'espacement des points synthétiques, pas une jonction.)
- **Correctif proposé** : dans la fenêtre du kilométrage, choisir parmi les segments dont l'écart est à quelques mètres du meilleur celui dont la position est la plus proche du kilométrage mémorisé (départage par `|alongM − distanceM|`), dans `projectOnRouteRange` (paramètre `preferM`) et `findRouteSeam` ; en garde-fou, refuser un correctif qui retire plus de tracé que la fenêtre ne couvre (`endCutM − startCutM` très supérieur à l'écart entre les kilométrages des bornes). Test de non-régression : le cas ci-dessus.

### D2 — Tampons des résultats

#### D2-1 · P1 · La prédiction ignore les altitudes, les revêtements et le tracé lui-même : elle n'est pas recalculée après l'affinage IGN

- **Où** : `src/features/itineraryPanel/hooks/useItineraryFitRuntime/signatures.ts:8-18` : `buildRouteSignature` = nombre de points + premier point + dernier point + distance totale. Elle sert à la fois à l'estampille persistée (`buildPredictionStamp`, `:35-37`) et au déclencheur du recalcul automatique (`useItineraryFitRuntime/index.ts:51-83`, `useAutoPrediction.ts:46-60, 139-142`).
- **Scénario** : un correctif ou un recalcul de tracé est d'abord appliqué avec les altitudes natives de BRouter, puis l'affinage en arrière-plan (`refineRouteInBackground` → `applyPendingRoutePatch(…, profile)`) remplace les altitudes **sur la même géométrie** (même nombre de points, mêmes extrémités, même distance). La prédiction, lancée 300 ms après la première version, n'est jamais relancée : temps, vitesses et horaires restent calculés sur les altitudes grossières de BRouter alors que le profil affiché est celui de l'IGN. Même chose quand l'analyse des revêtements d'un GPX importé (`useItineraryGpxImport.ts:136-200`) ajoute du gravier : le moteur vélo lit la surface, la prédiction ne bouge pas. L'estampille stockée reste « à jour », donc la réouverture du projet ne corrige rien non plus.
- **Preuve** : `d2-stamps.test.ts` (scratchpad) — même estampille après **+800 m** de dénivelé ajoutés au milieu, après passage de tout le tracé en gravier, et après un tracé décalé avec les mêmes extrémités, le même nombre de points et la même longueur. L'enchaînement « prédiction avant l'affinage » est lu (délai de 300 ms contre un affinage de l'ordre de la seconde), pas mesuré dans l'app.
- **Correctif proposé** : une empreinte du contenu utile au moteur : hachage rapide (FNV-1a sur un échantillon fixe, ou sur tous les points) de lat/lon/altitude arrondies et du revêtement ; ou une révision du tracé incrémentée à chaque écriture de `gpxRoute.points`, mise dans l'estampille. Augmenter la version de l'estampille pour que les prédictions stockées soient recalculées une fois.

#### D2-2 · P2 · À l'ouverture, une prédiction dont l'estampille ne correspond plus est gardée si la distance est à 500 m près

- **Où** : `useAutoPrediction.ts:62-76` : quand l'estampille ne correspond pas, le premier passage (`!lastSig`) garde quand même la prédiction stockée si la distance diffère de moins de 500 m, que la discipline est la même et que le moteur est à jour, puis note la signature courante comme traitée.
- **Scénario** (lu) : l'utilisateur change son poids ou son niveau dans « Rythme » et ferme l'onglet avant les 300 ms du recalcul (ou un autre éditeur le fait pendant que personne ne détient le bail de calcul) : le document porte le nouveau rythme avec l'ancienne prédiction et l'ancienne estampille. À la réouverture, l'ancienne prédiction est affichée comme valable et le reste jusqu'à la prochaine modification.
- **Correctif proposé** : n'appliquer le repli « distance à 500 m près » qu'aux prédictions **sans** estampille (antérieures à `predictionInputsKey`) ; une estampille présente mais différente doit relancer le calcul.

### D3 — Gestionnaire de projets

#### D3-1 · P2 · Deux déplacements croisés de dossiers créent un cycle : les deux dossiers et leurs projets disparaissent de l'interface

- **Où** : `src/shared/services/projects/folders.ts:193-220` (`moveProjectFolder` ne refuse que `id === parentFolderId`, aucun contrôle de descendance, ni côté client ni côté Appwrite) ; `src/features/projectBrowser/lib/projects/dropAction.ts:26-28` (même contrôle) ; `lib/projects/visibility.ts:23-40` (un parent **inconnu** compte comme la racine, mais deux parents connus qui se référencent ne sont jamais à la racine). Dans un seul onglet l'interface l'évite (le menu « Déplacer » exclut les sous-dossiers, `ProjectsPanel.tsx:172-190` ; le glisser-déposer ne propose que des dossiers frères) ; entre deux onglets ou deux appareils, chacun sur sa liste pas encore rafraîchie, rien ne l'empêche.
- **Scénario** : onglet 1 lâche le dossier A sur B ; onglet 2 (liste périmée) lâche B sur A. Dans le cloud, A a pour parent B et B a pour parent A : à la racine, ni A ni B n'apparaissent, et leurs projets (« Ultra 2026 ») non plus — la recherche ne les trouve pas (elle ne porte que sur le dossier courant). Les projets ne sont pas supprimés, mais ne sont plus accessibles que par leur URL.
- **Preuve** : `d3-folders.test.ts` (scratchpad) : les deux déplacements sont acceptés par `resolveDropAction` ; avec l'état cloud résultant, racine = dossiers `["C"]`, projets `["Autre"]`, recherche « Ultra » → `[]`.
- **Correctif proposé** : (a) `moveProjectFolder` relit les dossiers et refuse un parent qui est un descendant (ou le dossier lui-même) ; (b) à l'affichage, rompre tout cycle : un dossier dont la chaîne de parents boucle est traité comme à la racine (même règle que l'orphelin) ; (c) recherche sur toute la bibliothèque, avec le chemin du dossier en légende.

#### D3-2 · P2 · Projet partagé : le nom de la liste et celui de l'éditeur divergent pour de bon

- **Où** : renommer dans l'en-tête de l'éditeur (`shell/PanelHeader.tsx:183-189` → `setProject({ name })`) ne change que le **document**, que le serveur temps réel écrit sans jamais toucher à `projects.name` (`server/multiplayer/appwriteStorage.ts:364-368` : `data`, `size_bytes`, `collab`) ; `saveProject` n'écrit pas le cloud pour un projet partagé. Inversement, « Renommer » dans le gestionnaire (`renameProject`, `projectRows.ts:663-676`) ne change que la **ligne**, et à l'ouverture `withNameSync` (`cloudDocuments.ts:83-86, 135`) met ce nom dans la copie provisoire, puis l'instantané de la salle remet l'ancien nom du document.
- **Scénario** (lu) : le propriétaire renomme « Brouillon » en « BikingMan 2026 » dans l'éditeur : tous les éditeurs voient le nouveau nom dans l'éditeur, mais la carte du projet (chez lui et dans « Partagés avec moi ») et le titre de l'onglet restent « Brouillon » pour toujours. S'il renomme depuis le gestionnaire, la carte change, mais l'éditeur rouvre avec l'ancien nom après la connexion.
- **Correctif proposé** : pour un projet partagé, le serveur temps réel reporte `name` du document dans la ligne au point de reprise (avec `data`), et « Renommer » dans le gestionnaire passe par la salle (opération sur la racine) plutôt que par la ligne.

#### D3-3 · P3 · Nom de projet de plus de 255 caractères : sauvegarde suspendue avec un message « projet trop volumineux (30 Mo) »

- **Où** : l'en-tête n'a pas de `maxLength` (`PanelHeader.tsx:183-189`) ; l'attribut `name` fait 255 caractères (`setup-appwrite-schema.mjs:116`) ; le refus d'Appwrite (« … no longer than 255 chars ») est classé `too-large` par `errors.ts:105-106` (`/no longer than|too large|size/`), d'où le message « Projet trop volumineux pour la sauvegarde cloud (limite 30 Mo compressés…) » et l'autosave suspendu (`useDashboardProjectSync.ts:152-159`).
- **Scénario** (lu) : un nom collé depuis une description (300 caractères) : plus aucune sauvegarde cloud, avec un message qui fait chercher du côté de la taille du projet.
- **Correctif proposé** : `maxLength={255}` sur les champs de nom (en-tête, renommer, création, import) et coupe à 255 dans `saveProject` / `createProject` ; classer le refus d'un attribut autre que `data` en `rejected` avec un message qui nomme le champ.

## Zones vérifiées sans constat

- **D1** : chaque jonction passe par une vérification d'écart avant d'être stockée : correctif local (`planRouteSplice` : rejonction ≤ 25 m cherchée sur 1,5 km de tronçon, jamais au-delà du premier point imposé, coupe de fin antérieure à celle de début refusée), prolongement (`appendRoutePoints`, `index.ts:402`), recalcul segment par segment (`useRecalculateTrace.ts:126`), fusion (`RouteMergeToolContext.tsx:87`) ; un échec lève `RouteSeamError`, qui élargit la fenêtre puis bascule sur un recalcul complet (`routePatchJob.ts:169-178`), jamais une ligne. Réponse périmée : un nouveau correctif annule le précédent (`abortPatchJob`), et `applyPendingRoutePatch` ignore un résultat dont la clé ne correspond plus au `pendingRoutePatch` courant (`projectMutations.ts:69-70`) ; un correctif dont la jonction ne tient plus sur le tracé courant n'est pas appliqué (`:86-89`). Changer d'itinéraire sélectionné n'annule pas le correctif d'un autre (tâche par itinéraire). Départ / arrivée posés sur le tracé : rognage exact sans routage, refusé si un point de passage hors tracé est dans la partie retirée ou si le reste fait moins de 50 m ; sans kilométrage (boucle, clic sur la carte près du départ), un rognage ambigu retombe sur un correctif routé, pas sur une coupe au mauvais endroit.
- **D2** : `routedInputsKey` couvre tout ce qui construit le profil BRouter (`routing-resolver.ts:86-99` : priorités, types de routes effectifs, mode expert, discipline) plus départ, arrivée, points hors tracé, profil et zones interdites ; un profil personnalisé modifié dans la bibliothèque du compte ne touche pas un itinéraire tant que ses curseurs ne changent pas (les valeurs sont copiées dans l'itinéraire), donc rien de périmé ; `applyToAllItineraries` exclu (choix d'interface) ; JSON canonique, et les anciennes estampilles restent acceptées (pas de recalcul à chaque ouverture). Prédiction : discipline, rythme (date de départ comprise) et fichiers .fit dans l'estampille, version du moteur vélo vérifiée à part (`isCyclingPredictionOutdated`).
- **D3** : slug d'URL (`shared/lib/projectLocation.ts`) réduit à `[a-z0-9-]`, 80 caractères, sans `/` ni `..`, id encodé (`encodeURIComponent`) et relu après le dernier `--` ; un nom tout en émojis donne `/project/<id>` ; le titre de l'onglet est du texte. Suppression d'un dossier : projets et sous-dossiers détachés par pages avant la suppression (jamais d'orphelins), et un parent inconnu s'affiche à la racine. Fil d'Ariane protégé contre les boucles (`seen`). Projet supprimé ailleurs pendant son ouverture : `not-found` suspend l'envoi au lieu de recréer quoi que ce soit.
