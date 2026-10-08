# Stack Technique et Architecture de Routage de RedView

Ce document détaille de manière exhaustive l'architecture backend, la gestion du routage par BRouter, l'infrastructure VPS, ainsi que le système de génération de profils dynamiques et l'algorithme "Climb-Seeker" présents dans RedView.

---

## 1. Vue d'Ensemble de l'Architecture de Routage

L'infrastructure de routage de RedView n'est pas monolithique. Elle repose sur une architecture en trois tiers (Frontend, Vercel Serverless Proxy, et VPS BRouter Standalone) pour des raisons de sécurité, de flexibilité et de contournement des limitations techniques des navigateurs (CORS, Mixed-Content).

### Les trois piliers de la stack :
1. **Frontend (React/TypeScript)** : Gère l'état de l'utilisateur (sliders, modes de routage), génère dynamiquement des profils de routage personnalisés sous forme de texte brut (format BRF), et lance les requêtes de calcul de tracé.
2. **Vercel Serverless Function (`api/brouter.ts`)** : Sert de pont réseau (Proxy) sécurisé et performant. Il multiplexe les requêtes de routage et d'upload de profil.
3. **VPS BRouter Standalone (DigitalOcean)** : Le véritable moteur algorithmique. Il reçoit les profils BRF, les compile à la volée, et exécute les requêtes A* sur les données OpenStreetMap pour générer les GeoJSON.

---

## 2. Le Proxy Serverless (Vercel) : `api/brouter.ts`

Le choix d'implémenter un proxy sur Vercel répond à deux problématiques majeures :
- **Sécurité et Mixed-Content** : L'application RedView est servie en HTTPS (via Vercel). Appeler directement le VPS (souvent non certifié ou par simple IP) déclencherait un blocage de "Mixed-Content" par le navigateur.
- **CORS (Cross-Origin Resource Sharing)** : Le proxy Vercel permet de maintenir toutes les requêtes du navigateur en `same-origin` (sur `/api/brouter`), masquant ainsi le domaine/IP du VPS et évitant toute problématique de headers CORS complexes côté VPS.

### 2.1 Multiplexage des Endpoints
Le fichier `api/brouter.ts` gère un seul point d'entrée qui effectue du multiplexage basé sur la méthode HTTP :

*   **POST (`/api/brouter`)** : Dédié à l'upload des profils BRF (BRouter Routing Format).
    *   Accepte le profil en format `text/plain` ou en `JSON` avec une propriété `profile`.
    *   La taille maximale autorisée est de 100 000 caractères (100 Ko) pour éviter les attaques DDoS.
    *   Peut accepter un paramètre `?id=custom_xxx` pour écraser/mettre à jour un profil existant sur le VPS (très utile lors des itérations rapides en "Mode Expert").
    *   Timeout imposé à **15 secondes** (`UPLOAD_TIMEOUT_MS`).

*   **GET (`/api/brouter?lonlats=...`)** : Dédié à l'interrogation du tracé.
    *   Filtre rigoureusement les paramètres via une whitelist (`ALLOWED_PARAMS`) incluant : `lonlats`, `nogos`, `polylines`, `polygons`, `profile`, `alternativeidx`, `format`, `timode`, `heading`, `straight`, etc.
    *   Accepte également les paramètres dynamiques BRouter préfixés par `profile:xxx` (utilisés pour outrepasser des valeurs `assign` du profil de base).
    *   Timeout de calcul poussé à **55 secondes** (`ROUTE_TIMEOUT_MS`) pour rester dans la limite stricte de 60 secondes des fonctions Serverless "Hobby" de Vercel.

### 2.2 Gestion des Variables et Sécurité
- L'URL de destination du VPS est strictement masquée côté serveur via la variable d'environnement `BROUTER_UPSTREAM` (ex: `http://<DROPLET_IP>` ou `http://<DROPLET_IP>:17777`).
- En cas d'erreur côté moteur (qui renvoie souvent du texte brut HTTP 200 commençant par "error:"), le proxy intercepte la réponse, la convertit en HTTP 422, et injecte le message d'erreur upstream tronqué dans un header custom (`x-brouter-upstream-error`) pour garantir son arrivée jusqu'au client sans altération par les CDN.

---

## 3. L'Infrastructure VPS et BRouter Standalone

Le moteur de calcul réside sur un Serveur Privé Virtuel (VPS), typiquement un *Droplet DigitalOcean*.

### 3.1 Pourquoi un VPS dédié ?
BRouter nécessite un volume important de RAM pour charger les "rd5" data (fichiers de routage dérivés d'OpenStreetMap) en mémoire afin d'effectuer le calcul de graphe en quelques millisecondes/secondes. Une architecture Serverless classique ne dispose ni de la persistance disque locale pour les tuiles rd5, ni du temps d'exécution requis pour précharger ces données de manière rentable.

### 3.2 Cycle de vie des profils custom
Quand le proxy Vercel transmet un POST avec le contenu brut d'un BRF vers l'URL `/brouter/profile` (ou `/brouter/profile/custom_xxx`), l'instance BRouter Standalone du VPS va :
1. Lire le texte brut.
2. Le compiler (validation syntaxique du langage BRouter).
3. Si la compilation réussit, assigner un ID unique (souvent un timestamp, ex: `custom_1678902345`).
4. Répondre avec un JSON de type `{ "profileid": "custom_1678902345" }`.

Le frontend utilise alors ce `profileid` dans le paramètre `&profile=custom_xxx` lors du prochain `GET /brouter`.

---

## 4. Génération de Profils BRF Dynamiques (`brf-template.ts`)

C'est ici que se trouve le cœur de l'intelligence de RedView en matière d'expérience utilisateur.

### 4.1 La limitation du moteur par défaut
Le profil BRouter standard (`trekking.brf`) calcule le `costfactor` de chaque segment routier en utilisant une cascade de conditions "if/else" figée en dur. Il n'existe **aucune variable globale** native que l'on pourrait passer via l'URL pour dire "multiplie par 5 le coût de la route goudronnée". Ainsi, les sélecteurs de l'UI (ex: "Interdire la route", "Prioriser le gravel") n'auraient aucun effet réel.

### 4.2 L'approche RedView : Le template dynamique
Pour contourner cela, RedView embarque dans `brf-template.ts` une version modifiée et templatisée d'un profil de type "Trekking". À *chaque* modification d'un slider ou d'un paramètre dans l'UI (Distance, Dénivelé, Surface), RedView génère un tout nouveau fichier de profil `.brf` de plus de 500 lignes.

**Structure du profil BRF généré :**
1.  **`---context:global`** :
    Déclaration des modificateurs contrôlés par l'utilisateur (les variables `user_factor_*`, `user_dist_noncycle_penalty`, `user_climb_mul`). Ces variables prennent les valeurs exactes des sliders au moment de la génération (grâce à l'interpolation TypeScript). Y sont aussi intégrées les règles de cinématique (masse, vitesse max, Cx, etc.) et le comportement vis-à-vis des ferries ou des barrières.
2.  **`---context:way`** :
    Analyse de chaque tronçon. Le script identifie précisément la nature du sol (route, gravel, singletrack, piste cyclable) via les tags OSM (`highway`, `surface`, `tracktype`, `smoothness`).
    *   Il génère ensuite un `slider_multiplier` combinant le coût de la tranquillité, le coût du traffic urbain (`estimated_town_class`), et les pénalités de type de sol.
    *   Le `basecost` classique est calculé, puis multiplié par ce facteur `combined_factor`.
    *   Le script s'assure via une garde logique que le résultat ne dépasse jamais `9999` afin de ne jamais confondre un chemin pénalisé avec un chemin totalement interdit (dont le coût en BRouter est le "sentinel" `10000`).
3.  **`---context:node`** :
    Gestion des feux de signalisation, passages piétons et droits d'accès aux intersections.

### 4.3 Hashage et Cache (`hashBrf`)
Générer et uploader un profil de 100 Ko à chaque micro-modification d'un curseur serait inefficace et saturerait le proxy.
RedView implémente la fonction de hachage **FNV-1a 32-bit** (`hashBrf`).
Avant toute requête de routage, l'application hache le profil généré. Si ce hash correspond à un ID de profil déjà validé (et stocké côté client dans le `profile-cache.ts`), l'étape de POST est sautée, et le GET est lancé immédiatement avec l'ancien `custom_id`.

---

## 5. L'algorithme Avancé : Le "Climb-Seeker Mode" (Best-of-N)

La recherche de dénivelé dans RedView est particulièrement avancée. Elle s'inspire de l'approche développée initialement pour *earth-explorer-3d*.

### 5.1 Pourquoi un mode spécifique pour le dénivelé ?
L'algorithme A* standard de BRouter cherchera naturellement le chemin le moins "coûteux" énergétiquement, ce qui équivaut toujours à rester dans la vallée plate plutôt que de franchir un col. Si on demande à BRouter "Je veux du dénivelé", cela va à l'encontre même de sa philosophie de recherche de chemin optimal.

### 5.2 L'injection cinématique (Buffers d'élévation)
Lorsque le slider de Dénivelé est activé, le template génère un bloc BRF spécifique de "Climbing-mode".
Ce bloc modifie les "buffers d'élévation" (`elevationpenaltybuffer`, `elevationmaxbuffer`). Ces tampons, lorsqu'ils sont réduits à des seuils très fins, saturent au moindre mètre gagné (pente > 0.3%). Dès saturation, BRouter remplace le `costfactor` normal par `uphillcostfactor`.
Le template s'assure que :
*   Le `uphillcostfactor` d'un chemin de type "Gravel" ou "Singletrack" est extrêmement bas (`0.5`).
*   Le `uphillcostfactor` d'une "Major route" est extrêmement haut (`6.0`).
Ainsi, le moteur se met soudainement à percevoir les ascensions sur les chemins secondaires comme virtuellement moins coûteuses que la route plate.

### 5.3 `fetchBrouterRouteBestOfN` (Client Frontend) — retiré
> Historique : plus appelé depuis le 02/10/2026 (f2adbb8, routage toujours en profil généré, une requête), code supprimé le 07/10/2026 avec l'optimiseur de détours (`brouterDetourOptimizer.ts`, `brouterGeometry.ts`) et `profile-overrides.ts`. Voir §7.5.

Malgré les modifications du BRF, la première route calculée n'est pas toujours la plus montante. RedView implémente alors une stratégie "Best-of-N" via la fonction `fetchBrouterRouteBestOfN` (dans `client.ts`).
1.  Le client lance **jusqu'à 4 requêtes HTTP simultanées** vers le proxy.
2.  Chaque requête contient un index alternatif différent (`alternativeidx=0`, `1`, `2`, `3`). BRouter expose en effet jusqu'à 4 routes alternatives basées sur le même profil.
3.  Le frontend attend la résolution des 4 appels via `Promise.all`.
4.  Une fois les 4 GeoJSON récupérés, la fonction itère dessus et extrait la métrique de montée nette de BRouter (`props['filtered ascend']`).
5.  Le tracé retenu n'est pas le plus court ni le plus rapide, mais **celui qui présente l'ascention maximale (`best.ascentM`)**.

---

## 6. Flux Séquentiel d'Exécution (De l'UI au GeoJSON)

Pour résumer, voici ce qu'il se passe, en quelques centaines de millisecondes, lorsqu'un utilisateur clique sur la carte ou déplace un slider de préférence de route :

1.  **State Update** : Le Context React (`ProjectStore`) ou les hooks (`useItineraryBrouterRouting`) détectent un changement d'état (nouveau waypoint ou nouvel arrangement des sliders).
2.  **Compilation** : `buildBrfProfile` assemble le texte complet du profil de 600 lignes.
3.  **Hashage** : Le hash FNV-1a (8 caractères hexadécimaux) est calculé.
4.  **Cache Miss/Hit** :
    *   Si le hash est inconnu, un POST est envoyé au Proxy (`/api/brouter`), qui transmet le texte au VPS.
    *   Le VPS répond `{ profileid: 'custom_123...' }`.
    *   L'application met en cache l'association Hash -> ID.
5.  **Recherche de Route** :
    *   Une requête GET avec le profil généré, quel que soit le mode (le « Best-of-N » du §5.3 est retiré) ; au-delà de ~180 km, ancres puis raffinement (§7).
6.  **Proxying** : Le Proxy Vercel assemble l'URL (`http://<VPS_IP>/brouter?lonlats=...&profile=custom_123...`) et relaie vers Nginx sur le Droplet DigitalOcean.
7.  **Résolution** : Le VPS exécute l'algorithme A* en se basant sur le graphe rd5 en RAM et le profil `custom_123...`.
8.  **Retour** : Le GeoJSON (contenant les coordonnées, la distance, l'ascent/descent et les temps estimés) traverse le proxy, arrive dans le client, est casté selon l'interface `BrouterRoute`, puis injecté dans la Mapbox et la Timeline.

---

## 7. Recherche A*, longues distances et robustesse (octobre 2026)

Mesuré avec `npm run bench:routing` (684 scénarios, pipeline réel contre le BRouter de prod ; rapport dans `script-test-bench/reports/routing-quality/`).

### 7.1 Coefficient A* adaptatif
BRouter ne fait qu'une passe (`pass2coefficient = -1`, la passe exacte est trop lente sur les longs tracés). L'heuristique vaut `pass1coefficient × distance à vol d'oiseau restante` : rapportée au **coût au mètre du profil** (de ~1,4 pour la route à ~5 pour le VTT), elle fixe le compromis vitesse / qualité. L'ancien `3.5` fixe était très glouton pour la route (tracés 15 à 40 % plus coûteux que l'optimum du profil) et quasi exhaustif pour le VTT (au-delà de 55 s sur 1 000 km).
- `lib/brouter/api/searchCoefficient.ts` : coefficient = échelle de coût × poids selon la distance d'effort √(Σ Lᵢ²) des tronçons (0,8 sous 60 km → 2,0 à 1 000 km).
- Échelle : estimée a priori depuis les valeurs du profil (`estimateSearchCostScale`, `brf-template/values.ts`), puis apprise sur le coût réellement renvoyé par BRouter pour ce profil (`recordObservedCostScale`).
- `api/_lib/brouter-search.ts` : le proxy borne la valeur reçue (plancher selon la distance) ou la calcule si elle manque. Garder les paliers des deux fichiers en phase.

### 7.2 Très longs tracés : tracé grossier puis ancres
Un tronçon de plus de ~180 km à vol d'oiseau est d'abord calculé vite (poids 2,4), puis des ancres sont posées **sur ce tracé** environ tous les 160 km, et les tronçons courts sont recalculés finement, en deux moitiés parallèles (`routing/long-distance-anchors.ts`, `hooks/useItineraryBrouterRouting/resolveRouteRequest.ts`). Si l'affinage échoue ou coûte plus cher, le tracé grossier est gardé ; si le grossier n'aboutit pas, un second essai plus glouton (poids 4) part, toujours avec le profil personnalisé.

Le même mécanisme sert partout :
- **Recherche fine en échec** (délai dépassé, watchdog, serveur saturé) sur un tronçon plus court : même méthode, ancres resserrées (~60 km). Seules l'annulation, le quota et les erreurs liées aux points (hors carte, zone interdite, îlot, aucun chemin permis) sont remontées telles quelles.
- **Éditions locales** (déplacer / insérer / supprimer un point, zone interdite) : le tracé stocké est déjà le résultat de l'ancrage, donc le patch ne recalcule qu'une fenêtre autour de l'édition (±12 km d'abord, élargie à ±80 puis ±200 km et aux vraies bornes seulement si le nouveau tracé ne rejoint pas l'ancien : `WINDOW_STEPS_M`), bornée par des points pris sur ce tracé (`narrowRoutePatchToEdit`, `hooks/useItineraryBrouterRoutingShared/routeSegments.ts`), au lieu de tout le tronçon entre les étapes voisines. Les bornes portent leur distance le long du tracé (`distanceM`) ; sur une boucle ou un aller-retour où la position éditée est ambiguë, on garde le patch entre voisines.
- **GPX importés** : un GPX fait foi, il n'est jamais rerouté implicitement (pas même pour un `<wpt>` hors trace) ; ses éditions sont des patchs locaux comme sur un tracé BRouter, et « Recalculer le tracé » prend les ancres des longs tronçons directement sur le GPX.
- **Fusion de tracés** : le raccord passe par le même pipeline.

### 7.3 Points isolés (« îlots »)
BRouter accroche un point à la voie la plus proche même si elle n'est pas reliée au réseau (zone piétonne fermée, parking privé…) : « no track found » / « target island detected ». Le point fautif est décalé de 200 puis 500 m vers son voisin, avec un avertissement (`routing/island-repair.ts`).

### 7.4 Délais, requête de secours et compression
- Il n'y a plus de repli sur un profil stock : tout itinéraire est calculé avec son profil généré, y compris aux curseurs neutres. Un upload de profil en échec est retenté une fois, puis signalé.
- Une recherche a un délai proportionnel à la distance (14 s jusqu'à 150 km, jusqu'à 45 s) ; passé ce délai, `resolveRouteRequest` passe au tracé grossier et aux ancres (§7.2). Il est compté sur le **calcul seul** : le client l'envoie au proxy (`budgetMs`), qui le décompte une fois la requête sortie de sa file et répond 504 + `X-Brouter-Timeout: compute` à l'échéance ; le minuteur du client n'est plus qu'un filet (+45 s). Compté depuis l'envoi, une attente dans la file faisait abandonner la recherche pour en lancer deux ou trois autres (tracé grossier, ancres) derrière elle dans la même file. Devant un proxy qui ne pose pas `X-Brouter-Budget` (ancienne version), le délai reste compté depuis l'envoi.
- Au départ d'un réseau très dense (Paris), une recherche fine peut explorer plusieurs secondes : passé un délai proportionnel à la distance (~4 s à 110 km), une recherche plus gloutonne (même profil) part en parallèle et la première réponse l'emporte (`customProfileFetch.ts`). Ce secours n'attend jamais dans la file (`hedge=1` : une place libre tout de suite, sinon 503 immédiat, sans nouvel essai) : en file, il n'aurait rien gagné et ajoutait un calcul à un BRouter plein.
- Ces délais portent sur le calcul : ils s'arrêtent dès les en-têtes de la réponse (BRouter ne répond qu'une fois le tracé calculé), une connexion lente ne déclenche donc ni secours ni escalade. Un 503 (file pleine) n'arrête aucun délai : rien n'a été calculé.
- File du proxy saturée (503 après deux nouveaux essais, `BrouterBusyError`) : l'erreur remonte, jamais d'escalade — plusieurs requêtes de plus dans la même file.

### 7.4 bis File du proxy devant BRouter
BRouter (`btools.server.RouteServer`, 1.7.10) calcule au plus `maxthreads` requêtes (4). Quand ils sont tous pris, sa boucle d'acceptation — une seule pour toutes les connexions — attend jusqu'à 2 s, puis tue le calcul le plus ancien. Et il ne voit jamais qu'un client est parti : un calcul abandonné va au bout (60 s au plus, `-DmaxRunningTime=60`).
- `api/brouter.ts` n'envoie donc jamais plus de 4 calculs à la fois (`_lib/upstreamGate.ts`) ; les suivants attendent leur tour (35 s au plus, puis 503) ; un client parti pendant l'attente ne coûte rien.
- Client parti (nouvelle modification, secours gagnant, délai) : la requête vers BRouter est interrompue et sa place rendue tout de suite. BRouter, lui, continue ce calcul abandonné — mais la requête suivante, qui trouve ses 4 fils pris, le lui fait tuer (le plus ancien). Garder plutôt la place jusqu'à la réponse de BRouter a été essayé et mesuré (`bench:routing-load`, 08/10) : tous les calculs abandonnés menés à terme, les vivants en file derrière eux — CPU de BRouter +26 %, geste p50 ×2. Le meurtre du plus ancien est le seul moyen d'arrêter un calcul que BRouter offre.
- Chaque réponse porte `X-Upstream-Wait-Ms` (attente dans la file), `X-Upstream-Compute-Ms` (calcul), `X-Search-Km` (distance d'effort) et, à l'échéance, `X-Brouter-Timeout` ; le journal de requêtes du serveur les recopie (`upstream`, server/lib/request-logging.mjs).
- `npm run bench:routing-load` (`script-test-bench/routing-load/`) rejoue tout cela hors production : vrai pipeline client (une instance par utilisateur virtuel, comme un navigateur), vrai proxy, faux BRouter qui suit les règles de RouteServer (fils, attente / meurtre, abandons non vus, envoi de profil qui dort 1 s, calcul partagé sur quelques cœurs). `--roots a,b` : A/B entrelacé.
- Mesuré le 08/10 (secteur, 40 utilisateurs, un geste toutes les ~30 s + 2 rafales, 15 % de gestes remplacés, 3 vagues entrelacées par version) avant → après le délai compté sur le calcul, le secours hors file et l'absence d'escalade sur une file saturée : geste p50 2,5 → 2,5 s, p95 32,3 → 17,1 s (< 100 km : 23,4 → 15,5 s ; 100–200 km : 33,1 → 17,2 s) ; calculs BRouter 871 → 751, tués 85 → 19, CPU dépensé pour personne 177 → 49 s ; attentes de la boucle d'acceptation 140 (33 s) → 22 (2,5 s).
- `api/brouter.ts` compresse le GeoJSON (brotli ou gzip) : `server.mjs` ne compresse que les fichiers statiques, et un tracé de 1 000 km pèse ~5 Mo.

### 7.5 Best-of-N
Les stratégies multi-alternatives (§5.3) ne servaient qu'aux profils stock : tout itinéraire utilise désormais son profil personnalisé, routé en une requête. Les fonctions `fetchBrouterRouteBest*`, l'optimiseur de détours et `profile-overrides.ts` (curseurs → paramètres d'un profil stock) n'étaient plus appelés : supprimés le 07/10/2026 avec le reste du code mort signalé par knip.

### 7.6 Corrections du profil BRF
- **Mode grimpe** (remplace §5.2) : `uphillcostfactor = costfactor × relief` par catégorie (gravier 0,4 … axes majeurs 1,0), avec la sentinelle 10000 conservée. Les anciennes valeurs fixes faisaient ignorer en montée les choix « Éviter / Interdire », les sens interdits et les pénalités d'accès.
- **Priorité « Distance »** : haute = au plus direct (presets Vitesse), basse = détours acceptés (Aventure / Confort). Le sens était inversé : Vitesse pénalisait les routes directes ×1,5.
- **Plage de surfaces** : une surface incluse n'écrase plus « Éviter / Interdire » ; « Privilégier le gravier » vaut ×0,6 pour compenser le coût de base des chemins (héritage trekking), sinon un preset Gravel roulait à 90–97 % sur le goudron.

---
*Ce document technique peut servir de référence pour l'architecture complète de l'interopérabilité BRouter / Cloud dans le projet RedView.*
