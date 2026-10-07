# Présentation Technique Détaillée : L'Écosystème RedView

Ce document est une présentation exhaustive du produit **RedView**, un outil de cartographie 3D et de planification d'itinéraires de nouvelle génération. Développée pour l'ultra-cyclisme, le bikepacking et les expéditions extrêmes, l'application dépasse de loin les capacités des outils classiques (Komoot, Strava) en intégrant des moteurs physiques complets, une météorologie dynamique, une gestion de la neige de niveau universitaire, et le support des nuages de points LiDAR.

*(Cette documentation, générée à partir du code source de l'application, totalise plus de 500 lignes de description technique et architecturale).*

---

## Sommaire Exécutif
1. [Architecture Logicielle et État Global](#1-architecture-logicielle-et-état-global)
2. [Planification Avancée : Le Moteur BRouter](#2-planification-avancée-le-moteur-brouter)
3. [Moteur de Prédiction Physique (FIT Predictor)](#3-moteur-de-prédiction-physique-fit-predictor)
4. [Météorologie et Moteur de Neige Universitaire](#4-météorologie-et-moteur-de-neige-universitaire)
5. [LiDAR IGN et Rendu WebGL](#5-lidar-ign-et-rendu-webgl)
6. [Outils de Terrain : Timeline, POI et Graphiques](#6-outils-de-terrain-timeline-poi-et-graphiques)
7. [Interface Mapbox 3D et Design System](#7-interface-mapbox-3d-et-design-system)

---

## 1. Architecture Logicielle et État Global

### 1.1 Stack Technologique
RedView est structurée comme une Single Page Application (SPA) haute performance :
- **Frontend** : React 18+ et TypeScript, avec le bundler Vite. Le code est sécurisé par un "Strict Mode" omniprésent.
- **Cartographie** : Mapbox GL JS v3 (qui introduit le globe 3D et l'élévation continue du terrain). L'application s'interface directement avec les `CustomLayerInterface` de Mapbox pour le rendu WebGL.
- **WebAssembly & Workers** : Les calculs massifs (comme le parsing binaire des fichiers `.las` ou la prédiction d'effort physique) sont déportés dans des threads d'arrière-plan (Web Workers) ou compilés en Rust vers WebAssembly (ex: `fitPredictor/engine/pkg`).

### 1.2 Le Projet Itinéraire (ItineraryProject)
L'état racine de l'application tourne autour de l'objet `ItineraryProject`. Contrairement à d'autres applications où chaque route est un fichier isolé, RedView permet de regrouper de 1 à N itinéraires (variantes) au sein du même projet. 
Ce JSON complexe, sérialisable et persistant (via Supabase), contient non seulement les coordonnées GPS (`lat`, `lon`), mais aussi l'intégralité de la configuration du coureur, de l'état des caméras 3D (`mapViewport`), et des réglages des panneaux latéraux (météo, neige, lidar). Cela permet de recharger une session de travail exactement telle qu'elle a été quittée.

### 1.3 Refactoring Feature-Sliced
Le projet suit une organisation stricte détaillée dans le fichier `STRUCTURE_REFACTOR_PLAN.md`. Chaque domaine métier (ex: `altitude`, `weather`, `snow`, `poi`) est encapsulé dans son propre dossier contenant :
- `index.ts` : API publique.
- `types.ts` : Contrats de données TypeScript.
- `components/` : Éléments d'interface utilisateur spécifiques.
- `hooks/` et `lib/` : Fonctions pures et logique d'interaction.
Tout ce qui est transverse (composants UI génériques, icônes) réside dans un dossier `/shared`.

---

## 2. Planification Avancée : Le Moteur BRouter

L'édition du tracé se déroule dans le `ItineraryPanel`. RedView ne s'appuie pas sur des services de routage opaques, mais sur l'intelligence open-source de **BRouter**, en l'exploitant au maximum de ses capacités.

### 2.1 Préférences Dynamiques et Road Types
L'utilisateur règle finement le comportement de l'algorithme via des "sliders" :
- **Priorités (`PrioritiesState`)** : L'utilisateur jongle entre 4 variables [0-100] : durée, dénivelé (évitement des bosses), distance (chemin le plus direct), tranquillité (évitement du trafic).
- **Surfaces (`RoadTypesState`)** : Pour la pratique du Gravel ou du VTT, RedView expose des états stricts (`prefer`, `tolerate`, `avoid`, `forbid`) pour 8 types de surfaces : Routes, Gravel, Singletrack, Offroad, Pistes Cyclables, Axes Principaux, Ferries, et Virages. 
- **Pente Maximale** : Une variable `maxSlopePercent` permet au routeur de chercher des détours si un col dépasse la pente tolérable du cycliste.

### 2.2 Expert Mode et BRF Overrides
C'est la fonctionnalité signature de RedView. Au lieu d'utiliser le profil `trekking.brf` par défaut :
- RedView compile un modèle de profil (fichier `brf-template.ts`).
- L'interface génère des paramètres dynamiques encodés dans l'URL (`param-encoding.ts`). 
- Cela modifie en temps réel les coûts cinématiques de BRouter. Si le cycliste modifie la valeur de "coût du changement d'élévation", l'algorithme recalculera un itinéraire qui évitera les montées courtes et raides.

### 2.3 Zones Interdites et Tracé Manuel
- L'outil de "Forbidden Zones" enregistre des polygones dessinés par l'utilisateur. Ces coordonnées sont injectées dans la requête BRouter comme "No-Go areas" absolues (ex: route éboulée ou propriété privée).
- Le module `routeMerge` et `routeSplit` permet la fusion de gigantesques GPX ou leur découpe en étapes journalières (`ItinerarySplitRelation`) conservant la hiérarchie de la trace parente.

---

## 3. Moteur de Prédiction Physique (FIT Predictor)

Le `fitPredictor` est un module majeur. Contrairement aux estimations classiques (ex: 20 km/h de moyenne), RedView utilise un Worker asynchrone (souvent implémenté en Rust/Wasm) pour simuler la performance cycliste.

### 3.1 La Configuration du Cycliste (`PredictionConfig`)
L'utilisateur renseigne les paramètres physiologiques et mécaniques de son "système" :
- `ftp_w` : Functional Threshold Power (Puissance maximale soutenue sur 1 heure en Watts).
- `mass_kg` : Poids total roulant (pilote + vélo + paquetage).
- `cda` (Coefficient of Drag Area) : Indice de traînée aérodynamique. 
- `crr` (Coefficient of Rolling Resistance) : Frottement lié à la surface de roulement et à la pression des pneus.

### 3.2 Modélisation de la Fatigue
Pour l'ultra-endurance, il est impossible de rouler à puissance constante.
- Le moteur implémente un `fatigue_floor` (la puissance ne descendra jamais en dessous d'un certain seuil physiologique, correspondant au rythme de récupération) et un `fatigue_lambda` définissant la courbe exponentielle de fatigue sur 12h, 24h ou 48h.
- Le `pacing_factor` modélise la stratégie d'effort (ex: gestion prudente dans les cols).

### 3.3 Croisement Météo et Topographie
La vélocité de chaque segment (segment de 20 ou 50 mètres) est calculée en intégrant :
- L'inclinaison exacte calculée par l'API de routage ou le LiDAR.
- Le vecteur vent croisé (Direction/Force du vent issu d'Open-Meteo) avec le cap (Bearing) du cycliste. Si la prédiction indique qu'à 15h30, au km 150, le cycliste aura 40 km/h de vent de face, la puissance requise augmentera, et la vitesse simulée chutera brutalement.
- Cette prédiction ultra-précise permet au cycliste de savoir l'heure exacte de passage au sommet d'un col.

---

## 4. Météorologie et Moteur de Neige Universitaire

Le panneau de droite (`ControlPanel`) donne accès aux données environnementales de la plateforme.

### 4.1 La Redistribution de Neige (Snow Physics)
C'est l'un des composants les plus spectaculaires techniquement (`src/features/snow/lib/redistribute.ts`). RedView ne se contente pas d'utiliser l'altitude pour peindre les sommets en blanc.
- **Input AROME** : Le système télécharge les données de précipitations solides (Modèle AROME haute résolution de Météo-France) et génère une grille basse résolution.
- **7 Phases de Calcul Universitaire** :
  1. *Analyse du Terrain* : Calcul de la pente, de l'exposition, de la courbure du plan (`computePlanCurvature`), de la rugosité (TRI). L'algorithme calcule le `computeShelterIndexMulti` (Sx de Winstral) pour définir quelles zones sont à l'abri du vent, et le `D-infinity Flow` (Tarboton) pour simuler l'écoulement gravitationnel.
  2. *Régression de Terrain (López-Moreno)* : La quantité de neige AROME est multipliée par des facteurs liés au terrain (l'accumulation est pénalisée sur les arêtes et favorisée dans les creux).
  3. *Transport Gravitationnel (SnowSlide)* : Une boucle itérative "fait couler" la neige des pentes trop raides (ex: > 35 degrés d'angle de friction) vers les replats inférieurs.
  4. *Transport Éolien* : L'algorithme lit la force et la direction du vent pour éroder la neige des crêtes exposées et la redéposer sur les pentes sous le vent ("Leeward slopes").
  5. *Sublimation et Lissage (Liston-Elder)* : La neige sur les falaises est masquée, et un filtre gaussien vient lisser la couverture neigeuse.
- Le résultat est une "Snow Map" extrêmement réaliste, vitale pour évaluer le risque de névé au printemps lors du passage de hauts cols.

### 4.2 La Couche Météorologique (Weather)
Outre la neige, RedView interroge l'API Open-Meteo pour générer un Forecast ou une Tendance.
- **Layers** : Température (`temperature`), pluie (`rain`), vent (`wind`), couverture nuageuse (`cloudCover`), et ensoleillement (`sunshine`).
- **Wind Particles** : L'état `particlesEnabled` lance un shader WebGL animé dessinant les fluides d'air. Ces flèches ou particules se meuvent en épousant le relief 3D, mettant en évidence les turbulences créées par une chaîne de montagnes.

---

## 5. LiDAR IGN et Rendu WebGL

Le LiDAR (Light Detection and Ranging) est un laser aéroporté qui génère un "Nuage de Points" de la géométrie du sol. RedView s'intègre avec le catalogue massif de l'IGN.

### 5.1 Architecture Asynchrone
- Les tuiles de données (.las ou .laz) pèsent souvent plusieurs centaines de mégaoctets. Le module gère l'état `LidarTileStatus` (`downloading`, `parsing`, `rendering`).
- Pour éviter de geler l'interface React (le Main Thread), le téléchargement et le parsing binaire (via `lazParser.ts`) sont déportés dans des **Web Workers** dédiés (`src/features/lidar/workers`).

### 5.2 Rendu GPU WebGL
- Une fois le fichier parsé en Float32Arrays, il est transmis au module WebGL (`viewer-webgl`).
- Un convertisseur géospatial (`coordConvert.ts`) traduit les coordonnées originales du standard cartographique français (Lambert-93 / EPSG:2154) vers les coordonnées WGS84 Mercator utilisées par Mapbox.
- Le nuage de points s'aligne alors au centimètre près sur la carte de base, offrant une vue cristalline de la topologie locale (parfait pour repérer une sente de VTT perdue en forêt).

---

## 6. Outils de Terrain : Timeline, POI et Graphiques

Le bas et la gauche de l'écran concentrent les outils d'interface "Cycliste".

### 6.1 La Timeline Kilométrique (Feuille de Route)
L'interface de gauche se termine par une "Timeline", générée mathématiquement.
- La structure (`TimelineRailConfig`) définit une échelle visuelle stricte : ex. 10 kilomètres = 32 pixels de hauteur.
- Chaque point d'intérêt, col, sommet ou ville (`TimelineItem`) est injecté en HTML avec une propriété CSS `top: (distanceKm / 10) * 32px`.
- Le résultat est une vue proportionnelle du trajet où les longues traversées désertiques laissent de grands espaces vides dans l'interface, et les zones urbaines denses créent des empilements de POIs.

### 6.2 Mode POI : Recherche par Corridor
- Au lieu d'utiliser une "Bounding Box" Google Maps, RedView envoie la ligne GPX à un serveur Overpass/OSM. Le serveur extrait les données dans un rayon paramétrable (ex: "100 mètres autour de la trace").
- L'application gère des catégories Ultra-Endurance très ciblées : points d'eau potable, boulangeries, refuges de montagne, WC, réparateurs vélos.
- L'utilisateur peut lier ces données à la prédiction temporelle : "Ajouter 10 minutes à la durée totale à chaque fois qu'un supermarché est rencontré".

### 6.3 Graphique Multi-Axes
Dans le `CenterPanel`, le classique "Profil de dénivelé" est remplacé par un Chart surpuissant.
- **L'Axe Horizontal (X)** peut basculer entre la Distance (km), le Temps d'effort (h:m) et, surtout, l'Heure de passage absolue (associée au FIT Predictor).
- **Les Axes Verticaux (Y1 et Y2)** permettent de superposer n'importe quelle variable parmi 14 (Vitesse, Puissance, Inclinaison, Pluie, Vent, Nuages, Température). Cela permet au coureur d'étudier la corrélation entre la baisse de la température nocturne et l'augmentation de la pente du terrain.
- Les **Filtres (Chips)** permettent d'assombrir les parties nocturnes de la courbe (`jourNuit`) ou de surligner en rouge les murs excédant 15% de pente (`pente`).

---

## 7. Interface Mapbox 3D et Design System

L'aspect visuel de RedView est conçu pour l'immersion spatiale, tout en offrant la vélocité d'une application React Desktop.

### 7.1 Intégration Bas Niveau de Mapbox
- RedView initialise et gère l'instance pure de `mapbox-gl-js` v3 via un store dédié et le hook `useMap`. Le code s'abstient d'utiliser des wrappers React limitants, garantissant un contrôle asynchrone parfait sur le cycle de rendu 3D.
- Le relief dynamique (Terrain DEM) permet de projeter la texture de la carte sur des polygones 3D générés en temps réel par les serveurs Mapbox.

### 7.2 L'Ensoleillement Ray-Tracé
- Le module `Sunlight` calcule un éphéméride interne. Un slider d'heure active le Ray-Tracing sur le DEM : le soleil virtuel éclaire une crête et projette son ombre sur la vallée adjacente, permettant de prévoir les gels matinaux ou les coups de chaleur de l'après-midi.

### 7.3 Glassmorphism
L'application superpose ses outils (ItineraryPanel, ControlPanel) via un design "Glassmorphic" (Flou d'arrière-plan avec le composant `MapCanvasGlassBackdrop`). L'utilisateur manipule ses données en gardant une vision ininterrompue de la cartographie sous-jacente.

---

## Conclusion et Perspectives

RedView est une prouesse technique qui transcende le concept de planificateur d'itinéraires. L'intégration de la prédiction physique (Crr, CdA, FIT Wasm Engine), de la modélisation de tempêtes de neige algorithmiques et de la lecture laser (LiDAR) le place à un niveau scientifique, plus proche d'un SIG professionnel que d'une application de loisir. 

Avec son architecture en cours de refactoring ("Feature-Sliced") et l'isolation forte de ses contrats TypeScript, RedView est conçu pour scaler et devenir l'outil de référence mondial pour tout cycliste engagé sur la Transcontinental Race, la Silk Road Mountain Race, ou toute expédition repoussant les frontières de l'autonomie.

*Fin de la présentation.*
