# Audit pré-lancement RedView : parcours utilisateur connecté

> Audit du 2026-10-01, réalisé sans navigateur avec des scripts tsx/node et de vraies données (GPX GT20, UTMB, Tour de France ; FIT Chamonix–Paris). Les appels en lecture visaient la prod (`app.redview.tech`, Appwrite). Le compte de test n'a écrit que des documents `AUDIT-*`, tous supprimés depuis.
> Base : `806fd25`. Correctifs : 56 commits sur `main`, **non poussés et non déployés**.

## 1. Synthèse

L'audit a relevé **6 P0**, c'est-à-dire des pertes de données silencieuses ou des fonctions inutilisables, une trentaine de P1 et environ 40 P2. **Tous les P0 et la quasi-totalité des P1 sont corrigés.** Chaque correctif est vérifié par un script de reproduction qui échouait avant le correctif et passe après.

| Indicateur | Avant | Après |
|---|---|---|
| JS téléchargé au boot connecté | 21,6 Mio brut / 2,24 Mio gzip, **servi non compressé** | 4,28 Mio brut / **0,98 Mio brotli** |
| Plus gros projet sauvegardable dans le cloud | ~750 km de trace seule (au-delà : refus **masqué**) | 16 Mio de JSON (≈ 5 M car. compressés, plafond 12 M) |
| Autosave d'un gros projet (CPU, thread principal) | 469–1157 ms, déclenché à chaque déplacement de carte | 175 ms, plus aucun envoi cloud sur un déplacement de carte |
| Liste des projets (38 projets) | 6,0 Mo / 1,25 s | ≈ 8 Ko / 0,1 s (`Query.select`) |
| Mémoire de l'historique d'annulation (3 variantes GT20, 100 étapes) | +1,2 Go | +9 Mo |
| Rappel corridor POI, GT20 à r = 20 m / route de 2 700 km | 93 % / 51 % | 100 % / 100 %, avec le nouveau poi-server |
| Simulation de persistance (scénarios de perte) | 9/9 reproduits | 0/19 |
| Contrôles HTTP du serveur de prod / contrôles tuiles | 3 FAIL / 3 bugs | 57/57 / 98/98 |
| Erreurs ESLint (code applicatif) | 232 | 225 |
| `tsc -b`, `npm run build`, `bench:quick` | vert | vert, aucune régression (62 PASS) |

## 2. À faire avant de déployer (propriétaire)

1. **Coolify** : activer « Include Source Commit in Build », car le Dockerfile déclare maintenant `ARG SOURCE_COMMIT`. Sans cela, l'identifiant de build reste `0.0.0` : les caches client ne sont pas purgés à chaque déploiement et la release Sentry ne change jamais.
2. **Coolify** : définir `OPENMETEO_UPSTREAM`. Aujourd'hui, `/api/openmeteo` passe en prod par l'API publique `api.open-meteo.com`, dont la licence est **non commerciale** et le quota partagé sur l'IP du serveur.
3. **VPS** : redéployer `server/poi-server/` (`server.js` + nouveau `corridor-geometry.js`) dans `/opt/poi-server`, puis redémarrer le service. Il reste compatible avec les anciens clients. Sans ce redéploiement, le rappel corridor reste partiel sur les très longues routes à petit rayon (84 % au lieu de 100 %).
4. **Passer la checklist navigateur** du §7, impossible à automatiser ici.
5. Déployer (`npm run deploy`).

**Déjà appliqué en prod, avec accord :** l'attribut Appwrite `projects.data` est passé de 1 000 000 à **16 000 000** caractères. La chaîne nginx → Appwrite accepte 12 M caractères et renvoie 502 vers 16 M, d'où le plafond client à 12 M. Le bénéfice est immédiat, même avant le déploiement : les gros projets dont l'app perdait la sauvegarde en silence sont désormais acceptés.

## 3. Corrigé : P0 (pertes de données silencieuses)

| # | Problème | Correctif |
|---|---|---|
| A1 | Appwrite refusait tout `data` au-delà de 1 M car. (un ultra réaliste en fait 1,5 à 4,5 M) et le client ne contrôlait que le JSON brut (16 Mio) | Attribut relevé à 16 M ; contrôle client de la taille compressée (12 M) avec erreur visible — `2de984c` |
| A2 | Toutes les erreurs d'écriture cloud (création, sauvegarde, renommage, déplacement, suppression, dossiers) étaient avalées, avec « Enregistré » affiché | `ProjectCloudError` typée ; réessais avec délai croissant ; état « Synchronisation en attente » ou erreur visible — `53ce2cc`, `1efc93a` |
| A3 | La déconnexion vidait IndexedDB, y compris les modifications non synchronisées | Dernière tentative de synchronisation, puis confirmation explicite avant la purge — `10625b6` |
| A4 | `getProject` servait la copie IndexedDB sans consulter le cloud : un appareil périmé écrasait le travail fait ailleurs | Comparaison de fraîcheur, contrôle de conflit avant écrasement, copie de secours en cas de conflit — `59ebf6c` |
| A5 | Toute erreur réseau effaçait la session et réattribuait les sauvegardes à `dev-user-001` | Session effacée seulement sur un vrai 401 ; identifiant utilisateur en cache ; événement `redview:session-expired` — `8395ffa`, `1be0c25` |
| B1 | Export FIT : positions écrites en degrés au lieu de semicercles, d'où un parcours à 0°N 0°E sur Garmin | Conversion en semicercles — `b278b7a` |

## 4. Corrigé : P1

**Démarrage et compte**
- `ffe2cf6` : « Continue with Demo account » était présent en prod. Il est maintenant réservé au mode dev.
- `026ca8e` : `account.get()` n'avait pas de délai d'expiration, d'où un « Loading… » infini. Délai de 8 s et écran « Réessayer ».
- `ce2384a` : la vérification d'abonnement bloquait le rendu et répondait toujours `demo`. Elle est retirée.
- `8fb815e` : sous 960 px, le Dashboard était démonté. Il est remplacé par un overlay « Continuer quand même » qui ne démonte rien. Le blocage reste sur les vrais mobiles.

**Persistance**
- `1efc93a` : les sauvegardes sont séquencées.
- `59ebf6c` : copie locale écrite d'abord avec un drapeau `dirty` ; la sauvegarde à la fermeture d'onglet n'est plus perdue.
- `53ce2cc` : plus de projets `local-*` invisibles.
- `dfe912b` : la suppression d'un dossier ne détachait que 25 projets et faisait des orphelins. Les listes sont paginées, avec `Query.select`.
- `59ebf6c` : le renommage ne réécrit plus un `data` périmé.
- `e98dc9d` : une seule sérialisation par autosave ; plus d'envoi cloud sur un déplacement de carte.

**Tracé et routage**
- `a3e194f` : les clics ou drags rapides laissaient des segments droits non routés.
- `cc5310d` : l'affinage altimétrique IGN ne s'appliquait jamais, à cause de trois causes cumulées.
- `ad4cfc6` : au-delà de 14 points, les vias étaient supprimés en silence. Le calcul se fait maintenant par tronçons.
- `a3618a2` : les lots Open-Meteo de 2000 points étaient refusés en 400. Ils passent à 100.
- `6713037` : l'analyse de revêtements générait une rafale de requêtes sous 429 (jusqu'à 5 278). Elle est plafonnée à 4 et s'arrête au premier 429.
- `9493c07` : message dédié sur 429, sans repli sur le profil standard.
- `4d3439b` : l'historique d'annulation dépassait 1,2 Go en mémoire.

**Import et export**
- `91623a9` : les `<wpt>` GPX étaient ignorés, et la réimport d'un export RedView perdait 626 POI.
- `98839d5` : des caractères de contrôle rendaient le XML invalide.

**POI**
- `6e4f06a` : un échec du serveur (413, 5xx ou timeout) arrivait comme « 0 POI » et **effaçait les POI déjà trouvés**. L'erreur est maintenant propagée, avec un bouton « Réessayer » et les données conservées.
- `1c6d136` : le corridor perdait des POI au milieu des tronçons. Distance au segment côté serveur, échantillonnage par simplification côté client.

**FIT et prédiction**
- `f95ecc0` : un échec d'initialisation WASM bloquait le moteur jusqu'au rechargement.
- `21e6d0f` : une annulation affichait une fausse erreur et cassait les autres itinéraires.
- `9bf3a18` : un upload FIT échoué faisait disparaître le fichier.
- `fe89417` : un seul `.fit` invalide bloquait toute la prédiction.

**Carte, overlays et serveur**
- `01c29d5` : les index LiDAR Nouvelle-Zélande et Japon (≈ 18 Mo) étaient dans le boot. Ils sont chargés à la demande.
- `2c28484` : le serveur n'appliquait aucune compression. Brotli ou gzip est maintenant négocié.
- `ba0703d` : un asset manquant renvoyait index.html avec 200, ce qui cassait le lazy-load après un déploiement. Il renvoie 404, avec un rechargement unique sur `vite:preloadError`.
- `17b7ae7` : un PNG 1×1 corrompu était mis en cache « immutable » pendant 7 jours. Remplacé par un 204 `no-store` ; pentes en z15–16 suréchantillonnées.
- `2e9a364` : la couche météo devenait vide à cause d'URLs blob révoquées encore en cache.
- `70f6a16` : le graphique affichait une **météo inventée** (sinusoïde) en cas d'erreur. Remplacée par « Prévisions indisponibles », avec une plage de dates calée sur la durée de la sortie et `timezone=auto`.
- `6686d92` : le curseur « +2j » dépassait l'horizon de prévision disponible.
- `4e04e52` : masquer les étiquettes POI cachait aussi sentiers, rails et clôtures, ainsi que les points de survol.
- `1785f07` : l'annulation LiDAR ne marchait plus après un réessai, et un flux figé bloquait la tuile.
- `9b0835f` : Vent et Ensoleillement, masqués dans l'interface, tournaient encore (environ 96 appels Open-Meteo par déplacement de carte).

**P2 corrigés au passage**
- `f19b8a4` : en-têtes de cache des wasm et json, 405 hors GET et HEAD.
- `8357d5f` : bucket de rate limit dédié à la météo.
- `8c90723` : PNG valide côté service worker et coordonnées de tuile validées.
- `4ec2fdf` : build id par commit.
- `ab2c283` : projection POI calculée par segment.
- Lot FIT :
  - `3dbcde7` : regroupement des prédictions en attente ;
  - `d5af932` : uploads incrémentaux et suppression des fichiers retirés (RGPD) ;
  - `42365e7` : limite de 30 Mo ;
  - `79c6b16` : la FTP saisie n'est plus remise à zéro.
- `616b0e7` : la requête amont BRouter est annulée si le client part, et le cache est borné en octets.

**Moteur de prédiction (Rust/WASM)**
- `47717b0` : sans capteur de puissance, la FTP virtuelle tombait à 0 (4,4 km/h prédits au lieu de 21 km/h) ou était fixée par la pire montée (450 W). Agrégation par percentile, repli « portions plates », refus des FIT de type `course` (parcours planifiés). Six sorties réelles combinées : FTP 168 W, 30,2 h sur GT20.

## 5. Non corrigé : à planifier

| Priorité | Sujet | Détail et recommandation |
|---|---|---|
| P2 | Cohérence du D+ | Étape du Tour : 2308 m (GPX), 1860 m (BRouter), 2045 m (app). Sur 1129 km, l'app affiche +26 % par rapport à BRouter. À revoir maintenant que l'affinage IGN s'applique réellement. |
| P2 | Open-Meteo appelé en direct | Jusqu'à 200 appels pour une route longue (plafond de 20 000 points). Sous-échantillonner à environ 2000 points puis interpoler. |
| P2 | FIT orphelins | La suppression d'un itinéraire ou d'un projet laisse ses fichiers FIT dans le bucket (TODO dans `fitFiles.ts`). Les anciens fichiers déjà orphelins sont à nettoyer par un script serveur. |
| P2 | Permissions Appwrite | Le client peut écrire n'importe quel `user_id`, sans lecture croisée possible. Il peut aussi créer un document `read("any")` sans permission de suppression, que lui-même ne peut plus supprimer. Envisager une fonction serveur pour créer les documents. |
| P2 | Conflits multi-appareils | Le contrôle se fait par lecture puis écriture, donc n'est pas atomique : une écriture concurrente peut passer dans la fenêtre entre les deux. Un renommage depuis un autre appareil compte comme un conflit. Les projets non ouverts ne se resynchronisent qu'à l'ouverture ou à la déconnexion. |
| P2 | Documents non compressés en prod | 41 documents sont stockés en JSON brut, dont un à 945 k caractères. Prévoir une migration serveur. |
| P2 | LiDAR | Pic mémoire de 2× la taille du fichier (334 Mo pour 167 Mo). Une tuile en cache est relue entièrement pour rien. Les tuiles à la frontière suisse sont retéléchargées. La suppression d'un fichier verrouillé est silencieuse. Pas de `navigator.storage.persist()`. Affichage « 0 Mo » en repli CacheStorage. Liste de zones IGN de secours obsolète. |
| P2 | Fond de carte et terrain | Passer la qualité 3D à « 1 m » charge d'abord les mauvaises tuiles (D27, repro `d-basemap-quality.ts`). Un changement de profil peut être perdu par le throttle (D28). `slot:'top'` est sans effet sur les styles v12 : après un changement de fond, la météo passe sous les pentes (D29). Le style est chargé deux fois sur un réseau lent. Un échec de thème est silencieux. |
| P2 | Service worker | Caches mémoire bornés en nombre d'entrées et non en octets (≈ 550 Mo dans le pire cas). CacheStorage sans éviction. Fetch radar sans délai d'expiration. |
| P2 | Handlers météo | 502 au lieu de 404/400. `radar.json` sans délai d'expiration ni cache. Proxy Open-Meteo non validé (relais ouvert). Tuiles `immutable` sans identifiant de run. Pas de rafraîchissement automatique du radar. Recoloration radar qui ignore les filtres PNG (latent). |
| P2 | Sécurité | La CSP autorise encore `'unsafe-eval'`. `scripts/test-security-fixes.mjs` est obsolète : il importe `generate4DigitCode`, qui n'existe plus. |
| P2 | Qualité | 225 erreurs ESLint existaient avant l'audit, surtout des règles du compilateur React. Le chunk Dashboard reste à 3,4 Mo brut (0,77 Mo en brotli). |
| Info | Analyse de revêtements | Sur 429, l'arrêt de l'analyse n'est signalé que dans la console : il n'y a pas de système de toast dans le panneau itinéraire. |
| Info | Annulation d'un retrait de FIT | Annuler le retrait d'un fichier FIT ne restaure pas le fichier, déjà supprimé du bucket : il est ignoré proprement. |

## 6. Rejouer l'audit

Tous les scripts sont dans `script-test-bench/audit/`. Chacun **sort en code non nul tant que son bug se reproduit**. Ils se lancent depuis la racine du dépôt :

```bash
npx tsx script-test-bench/audit/a-persistence-sim.ts      # persistance (Appwrite + IDB simulés)
npx tsx script-test-bench/audit/b-trace-edits.ts          # idem : b-export, b-gpx-import, b-via-limit
node --expose-gc --import tsx script-test-bench/audit/b-history-memory.ts
npx tsx script-test-bench/audit/c-poi-corridor.ts         # idem : c-poi-lateral, c-fit-worker-init, c-fit-runtime-race
npx tsx script-test-bench/audit/d-weather-horizon.ts      # idem : d-weather-blob-revoke, d-basemap-theme
node script-test-bench/audit/a-boot-bundle.mjs            # après npm run build
# Avec le serveur local (npm run build && npx tsx server.mjs) :
node script-test-bench/audit/a-server-http.mjs
npx tsx script-test-bench/audit/d-server-tiles.mjs --no-ratelimit
node script-test-bench/audit/c-poi-upstream-failure.mjs
# En conditions réelles, sur le compte de test (écrit puis supprime des documents AUDIT-*) :
npx tsx --env-file=.env script-test-bench/audit/a-appwrite-live.ts
```

Trois scripts échouent encore, et c'est attendu, car ils ciblent des points P2 non corrigés : `d-basemap-quality.ts` (D27), `d-lidar-downloader.ts` (cas C et G, mémoire et verrou) et `d-lidar-bundle.mjs` (contrôle esbuild sans code splitting, qui ne peut pas passer).

## 7. Checklist manuelle (navigateur, avant ouverture)

Ces points ne peuvent pas être validés sans navigateur. Les correctifs concernés n'ont été testés que par simulation.

- [ ] **Connexion** : connexion par e-mail ; pas de bouton « Demo » ; couper le réseau au chargement fait apparaître l'écran « Réessayer ».
- [ ] **Conflit entre appareils** :
  1. ouvrir le même projet sur deux navigateurs ;
  2. le modifier sur A ;
  3. le modifier sur B, puis Ctrl+S : un message de conflit apparaît et rien n'est écrasé.
- [ ] **Hors ligne** : couper le réseau, modifier, constater « Synchronisation en attente » ; rétablir le réseau et vérifier la synchronisation automatique.
- [ ] **Déconnexion** : se déconnecter avec des modifications non synchronisées ; une confirmation doit apparaître.
- [ ] **Gros projet** : un projet de plus de 600 km avec POI et prédiction doit se sauvegarder, se rouvrir sur un autre appareil et rester identique.
- [ ] **Tracé** : cliquer vite (plus de 10 clics) pendant le routage, puis faire deux drags rapides. Aucun segment droit ne doit apparaître. Un tracé de plus de 25 points doit garder tous ses points après un changement de profil.
- [ ] **Import GPX** : importer `GT20_POI.gpx`, les POI doivent être présents. Exporter en FIT, puis vérifier dans Garmin Connect ou sur un GPS que le parcours est au bon endroit.
- [ ] **POI** : une recherche qui fonctionne. Une recherche sur une boucle France à 10 km de rayon doit afficher « Corridor trop large » sans effacer les POI existants.
- [ ] **FIT** : ajouter quatre fichiers .fit, dont un `.gpx` renommé en `.fit`. Le fichier invalide doit être nommé et exclu, et la prédiction doit aboutir.
- [ ] **Overlays** : basculer les quatre fonds de carte avec Pentes, Altitude, Météo et Itinéraires actifs ; tout reste affiché.
  - Étiquettes POI désactivées : les sentiers restent visibles.
  - Météo : basculer Prévision → Tendances → Prévision ; la couche ne devient pas vide.
- [ ] **Fenêtre étroite** : réduire la fenêtre sous 960 px. L'overlay apparaît, « Continuer » fonctionne, et l'historique d'annulation est conservé.
- [ ] **Après le déploiement** : garder un onglet ouvert pendant un second déploiement, puis ouvrir un projet. La page se recharge proprement, sans écran blanc.
- [ ] **DevTools** : les JS sont servis en `content-encoding: br` ; aucun chunk `stacClient` n'est chargé au démarrage.
