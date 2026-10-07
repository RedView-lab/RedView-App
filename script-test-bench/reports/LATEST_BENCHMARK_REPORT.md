# Rapport de Test-Bench RedView — Performance & Non-Régression

> **Date d'exécution** : 2026-10-06T22:16:50.273Z  
> **Environnement** : AMD Ryzen AI 7 350 w/ Radeon 860M (16 threads, 31 Gio) · SUR BATTERIE · Node v24.19.0 · win32 x64 · 0015c31f02 + modifications locales

## Vue d'Ensemble & Scorecard

| Indicateur | Valeur |
| :--- | :--- |
| **Suites Fonctionnelles Exécutées** | **12** |
| **Total Opérations Évaluées** | **80** |
| **Statut Conforme (PASS)** | **79** (98.8%) |
| **Avertissements (WARN - Jitter/Peak)** | **0** |
| **Régressions / Dépassements Seuil** | **1** |

## Domaine : Météo (Weather & Radar)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Météo trace : réponse Open-Meteo 26 stations × 16 j** | 5 | 10.79 ms | 15.03 ms | 94.0 | +12.23 MB | ✅ PASS |
| **Météo trace : interpolation 24k pts (getRouteWeatherAtDistanceAndTime)** | 5 | 12.57 ms | 20.95 ms | 69.2 | +15.79 MB | ✅ PASS |
| **Calcul Grille de Vent GPU (Zoom 9)** | 10 | 0.31 ms | 0.41 ms | 3542.5 | +4.15 MB | ✅ PASS |
| **Recoloration Tuile Radar PNG (512x512)** | 5 | 3.44 ms | 5.74 ms | 243.5 | +14.12 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Recoloration binaire synchrone sur le thread Node.js : décompression zlib 512x512 saturant sous charge concurrente.**
- **Taille mémoire des grilles de vent : fuite potentielle si les textures GPU ne sont pas libérées lors du pan.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Mettre en cache LRU en mémoire les tuiles radar recolorées (clé: tile_z_x_y + hash_palette) pour un coût CPU nul sur requêtes répétées.
- Déporter la recoloration RainViewer vers un Web Worker ou shader WebGL côté client pour décharger à 100% le serveur Node.

---

## Domaine : Pente (Slope & Horn 3x3)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **SW : Horn 3x3 tuile 256 + marges (computeSlopeField)** | 10 | 1.87 ms | 3.42 ms | 471.9 | +6.96 MB | ✅ PASS |
| **SW : Catmull-Rom 2x 256 → 512** | 20 | 0.84 ms | 1.19 ms | 1121.5 | +0.01 MB | ✅ PASS |
| **SW : PNG gris 512 (Paeth + zlibDeflateRle)** | 10 | 7.47 ms | 8.34 ms | 133.7 | +1.65 MB | ✅ PASS |
| **SW : PNG gris 512 — ancien (CompressionStream niv. 6)** | 3 | 34.95 ms | 38.87 ms | 27.7 | +0.26 MB | ✅ PASS |
| **SW : tuile pente complète 512 (4 voisines)** | 5 | 12.71 ms | 13.89 ms | 81.5 | +1.37 MB | ✅ PASS |
| **SW : tuile pente zone 256 (gris + alpha)** | 5 | 14.60 ms | 19.55 ms | 64.3 | +4.47 MB | ✅ PASS |
| **Compilation Mapbox Expression (Gradient)** | 25 | 0.04 ms | 0.22 ms | 12412.5 | +0.62 MB | ✅ PASS |
| **Compilation Mapbox Expression (Step + Masque)** | 25 | 0.00 ms | 0.01 ms | 227894.3 | +0.04 MB | ✅ PASS |
| **Serveur /slope-tiles à froid (z12)** | 4 | 9.85 ms | 12.66 ms | 95.5 | +7.73 MB | ✅ PASS |
| **Serveur /slope-tiles à froid suréchantillonnée (z16)** | 4 | 14.68 ms | 25.27 ms | 60.4 | +2.57 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Encodage PNG : 90 % du temps d'une tuile pente 512 avec CompressionStream (niveau 6 imposé) — garder zlibDeflateRle pour la tuile grise.**
- **Le pool de workers pente et le chemin SW doivent rester octet pour octet identiques (même slope-math.js / terrain-rgb.js).**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Les tuiles gris + alpha (zone, NoData) restent en niveau 6 : le RLE y est 12-18 % plus gros (alpha entrelacé).

---

## Domaine : Altitude (Elevation & D+/D-)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Overlay altitude : encodeDem tuile 512** | 20 | 3.38 ms | 4.11 ms | 282.9 | +0.01 MB | ✅ PASS |
| **Overlay altitude : encodeDem ancêtre recadré (dz=2)** | 20 | 8.13 ms | 10.60 ms | 119.4 | +0.02 MB | 🛑 REGRESSION |
| **SW altitude zone 256 (RGBA + masque + PNG)** | 5 | 8.23 ms | 12.65 ms | 107.8 | +1.35 MB | ✅ PASS |
| **D+/D- trace 50k pts (computeRouteElevationMetrics)** | 5 | 29.37 ms | 29.91 ms | 34.8 | +10.94 MB | ✅ PASS |
| **Profil de pente trace 50k pts (extractRouteProfileFromPoints)** | 5 | 31.37 ms | 41.41 ms | 30.5 | +76.01 MB | ✅ PASS |
| **Génération Échelle Altitudes (6 couleurs)** | 50 | 0.01 ms | 0.02 ms | 88417.3 | +0.24 MB | ✅ PASS |
| **Serveur /altitude-tiles à froid (z12)** | 4 | 9.67 ms | 13.68 ms | 96.3 | +0.62 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Overlay altitude hors zone : il ne doit jamais retélécharger la tuile DEM (réencodage en mémoire de tile.dem).**
- **D+ : le seuil (2 m) et le lissage (5 points) de computeRouteElevationMetrics changent le dénivelé affiché de toutes les traces.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Le D+ d'une trace de 50 000 points coûte ~15-30 ms (haversine) une fois par routage ou import : pas un chemin chaud.

---

## Domaine : Neige (moteur v2)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Profil altitudinal AROME (60×40 mailles)** | 3 | 84.36 ms | 87.51 ms | 11.7 | +3.96 MB | ✅ PASS |
| **Indice d’abri Winstral Sx (256×256, 100 m)** | 3 | 3.28 ms | 6.13 ms | 233.0 | +3.70 MB | ✅ PASS |
| **Motif de transport éolien (256×256, 4 secteurs)** | 2 | 221.67 ms | 243.43 ms | 4.5 | +20.46 MB | ✅ PASS |
| **Transport gravitaire SnowSlide + ligne d’énergie (256×256)** | 3 | 174.04 ms | 187.48 ms | 6.0 | +61.95 MB | ✅ PASS |
| **Horizons 24 secteurs + rayonnement journalier (128×128)** | 2 | 158.42 ms | 171.78 ms | 6.3 | +31.15 MB | ✅ PASS |
| **Pipeline complet v2 (256×256, sans historique météo)** | 2 | 1141.56 ms | 1173.65 ms | 0.9 | +12.04 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Indice Sx et horizons : O(N × distances × secteurs). La grille de travail est plafonnée (maxResolution 640) et les horizons sont calculés à demi-résolution au-delà de 400 nœuds.**
- **SnowSlide trie tous les nœuds par surface de neige à chaque passe (2 passes) : O(N log N).**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Le moteur tourne dans un Web Worker (lib/engineWorker.ts) ; les données (AROME, stations, BRA, météo, MNT lointain) sont chargées en parallèle avant.

---

## Domaine : BRouter (Routing Engine & BRF)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Compilation Profil BRF Dynamique (Gravel)** | 25 | 0.03 ms | 0.50 ms | 7800.8 | +0.55 MB | ✅ PASS |
| **Compilation Profil BRF Dynamique (Route)** | 25 | 0.02 ms | 0.05 ms | 38238.0 | +0.29 MB | ✅ PASS |
| **Trace 1 200 km : longueurs cumulées (100k pts)** | 5 | 4.37 ms | 5.66 ms | 213.3 | +5.70 MB | ✅ PASS |
| **Trace 1 200 km : projection d’un point (survol)** | 50 | 0.10 ms | 0.62 ms | 5960.3 | +22.96 MB | ✅ PASS |
| **Trace 1 200 km : finesse GPX par défaut (export)** | 3 | 68.05 ms | 78.23 ms | 15.5 | +80.41 MB | ✅ PASS |
| **Trace 1 200 km : nettoyage GPX importé (cleanGpxGlitches)** | 3 | 82.36 ms | 86.30 ms | 12.3 | +97.22 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Désactivation du mode one-pass (pass2coefficient >= 0) : complexité quadratique provoquant des timeouts (>30-60s) sur les traversées régionales et alpines.**
- **Complexité des No-Go Areas : les polygones avec plus de 50 sommets ralentissent drastiquement l’algorithme A* de BRouter.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Mettre en cache le hash SHA-256 du profil BRF généré pour éviter les requêtes de re-téléchargement vers le VPS.
- Simplifier les polygones de zones interdites avec l’algorithme Ramer-Douglas-Peucker avant encodage dans l’URL BRouter.

---

## Domaine : FIT Predictor (Simulation Physique & Effort)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Moteur WASM : col 14 km à 8 %** | 6 | 1.64 ms | 3.18 ms | 520.0 | +0.50 MB | ✅ PASS |
| **Moteur WASM : 100 km vallonnés** | 3 | 7.66 ms | 11.07 ms | 115.1 | +1.75 MB | ✅ PASS |
| **Moteur WASM : étape ultra 700 km** | 3 | 109.75 ms | 112.11 ms | 9.1 | +5.56 MB | ✅ PASS |
| **Calibration FIT réelles (6 sorties, LOO)** | 1 | 2740.52 ms | 2740.52 ms | 0.4 | +0.04 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Le moteur ne rend que le temps de déplacement : les pauses relèvent du planning (pauseAwareSchedule).**
- **Changer les résultats du moteur impose de monter ENGINE_VERSION (Rust) et CYCLING_ENGINE_VERSION (TS) ensemble.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Justesse : `npm run bench:pace` (FIT réels + scénarios physiques), échec sur un critère dur.

---

## Domaine : LiDAR — préparation d’une tuile (CPU)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Reprojection Lambert-93 → WGS84 (10k pts)** | 3 | 6.92 ms | 10.54 ms | 124.8 | +20.28 MB | ✅ PASS |
| **Colorisation ortho bilinéaire (0.5 M pts)** | 3 | 60.72 ms | 67.63 ms | 16.6 | +3.07 MB | ✅ PASS |
| **Octree LOD + couleurs filtrées (0.5 M pts, LAS sans COPC)** | 2 | 110.01 ms | 129.48 ms | 9.1 | +0.06 MB | ✅ PASS |
| **Mapping Tuiles Web-Mercator Zoom 16 (10k pts)** | 15 | 0.38 ms | 1.10 ms | 2112.9 | +5.29 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Première ouverture d’une tuile IGN (23 M pts, 2026-10-06) : décodage laz-perf ~17 s CPU (8 workers → ~3,5 s), colorisation ~2 s et octree ~1,8 s sur un seul worker chacune : tout ralentissement de ces boucles se voit tel quel à l’écran.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Suivre l’ouverture à froid réelle avec `npm run bench:lidar-fps -- --cold` (chronologie des étapes) : 14,2 s → 11,2 s le 2026-10-06 sur Radeon 860M, sur batterie.

---

## Domaine : POI (Points d’Intérêt & Corridor Overpass)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Projection Métrique Trace (projectRoutePoints 10k pts)** | 20 | 0.43 ms | 0.55 ms | 2398.6 | -25.05 MB | ✅ PASS |
| **Feuille de route : 2 500 POI (poiFeaturesToTimelineItems)** | 5 | 9.35 ms | 12.37 ms | 108.7 | +20.84 MB | ✅ PASS |
| **Projection Orthogonale POIs (projectPoiOntoRoute)** | 20 | 2.30 ms | 3.23 ms | 409.2 | +6.10 MB | ✅ PASS |
| **Clustering Spatial (buildPoiClusters 500 POIs)** | 25 | 0.28 ms | 0.41 ms | 3817.9 | +9.76 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Complexité O(N_pois × N_segments) si la projection n’est pas précédée d’un pré-filtrage spatial : bloque le thread React sur les longs parcours.**
- **Overpass API timeout : les requêtes de corridor de plus de 200km dépassent souvent le délai de 25s imposé par les serveurs publics OSM.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Mettre en place un R-Tree (Flatbush ou RBush) sur les segments de la trace pour réduire la recherche du segment le plus proche de O(N) à O(log N).
- Découper les requêtes Overpass en tranches de 80km ou requêter le VPS Overpass interne RedView avec cache Redis.

---

## Domaine : Exporter (GPX, GeoJSON & Parsers)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Sérialisation GPX (1k pts)** | 20 | 0.52 ms | 1.16 ms | 1679.9 | +19.89 MB | ✅ PASS |
| **Sérialisation GPX (10k pts)** | 5 | 5.49 ms | 6.23 ms | 185.1 | +38.80 MB | ✅ PASS |
| **Sérialisation GPX Échelle Ultra (50k pts)** | 3 | 28.46 ms | 28.46 ms | 37.6 | +39.81 MB | ✅ PASS |
| **Parsing GPX XML Regex (10k pts)** | 5 | 7.99 ms | 16.31 ms | 99.9 | +61.82 MB | ✅ PASS |
| **Parsing GPX XML Regex (50k pts)** | 2 | 47.47 ms | 49.62 ms | 21.1 | +46.51 MB | ✅ PASS |
| **Sérialisation GeoJSON (50k pts)** | 3 | 17.47 ms | 18.09 ms | 57.6 | +22.37 MB | ✅ PASS |
| **Export FIT Course Garmin (50k pts)** | 3 | 64.89 ms | 81.30 ms | 14.5 | +73.59 MB | ✅ PASS |
| **Export KML (50k pts)** | 3 | 27.00 ms | 28.47 ms | 36.6 | +20.52 MB | ✅ PASS |
| **Échappement XML (1 000 chaînes)** | 25 | 0.76 ms | 1.27 ms | 1131.4 | +33.39 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Génération de fichiers GPX > 50k points par concaténation de chaînes : pic mémoire V8 pouvant dépasser 120 Mo temporaires.**
- **Expression régulière `/<trkpt/gi` sur un fichier XML de 15 Mo : risque de blocage du thread pendant le parsing sur appareil modeste.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Remplacer le parsing Regex par un parseur XML streaming (SAX/expat Wasm) ou déporter le chargement GPX dans un Web Worker (gpxParseWorker.ts).
- Pour l’export FIT binaire (Garmin), utiliser le SDK officiel @garmin/fitsdk via un buffer mémoire pré-dimensionné sans conversion string.

---

## Domaine : Center Panel (Graphiques Multi-Axes & Timeline)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Série Altitude (heure, 24k pts) — froid** | 5 | 11.44 ms | 20.39 ms | 82.2 | +74.58 MB | ✅ PASS |
| **Série Altitude (heure, 24k pts) — chaud (cache)** | 25 | 0.00 ms | 0.01 ms | 266524.5 | +0.02 MB | ✅ PASS |
| **Série Inclinaison (temps, 24k pts) — froid** | 5 | 11.10 ms | 13.07 ms | 94.1 | +67.23 MB | ✅ PASS |
| **Série Vitesse (distance, 24k pts) — froid** | 5 | 0.89 ms | 5.11 ms | 420.7 | +23.23 MB | ✅ PASS |
| **Série Vitesse moyenne (temps, ultra 1 200 km) — froid** | 3 | 20.38 ms | 22.74 ms | 49.6 | +82.71 MB | ✅ PASS |
| **LTTB fitChartPointBudget (24k → 2 000 pts)** | 20 | 0.12 ms | 0.14 ms | 7872.8 | +1.34 MB | ✅ PASS |
| **Domaine Y (computeDomain, 2 séries)** | 25 | 0.08 ms | 0.22 ms | 10613.9 | +6.21 MB | ✅ PASS |
| **Curseur de survol (distance, 1k requêtes)** | 25 | 0.36 ms | 0.43 ms | 2829.5 | +7.02 MB | ✅ PASS |
| **Curseur de survol (heure, 1k requêtes)** | 50 | 0.41 ms | 0.46 ms | 2406.6 | +9.82 MB | ✅ PASS |
| **Série Météo Température (distance, 24k pts)** | 5 | 0.00 ms | 0.03 ms | 91407.7 | +0.00 MB | ✅ PASS |
| **Série Météo Pluie (heure, 24k pts)** | 5 | 0.00 ms | 0.03 ms | 107758.6 | +0.00 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Séries « moyennes sur 500 m » : un balayage de toute la prédiction par intervalle coûtait 0,2-1 s sur un ultra (corrigé le 2026-10-06, bissection).**
- **Le cache des séries est indexé par objet (trace, prédiction) : une copie à chaque rendu le rend inutile.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Le graphique recalcule axe 1, axe 2 et altitude de chaque itinéraire visible à chaque zoom (detailZoom).

---

## Domaine : Serveur de prod (server.mjs) & primitives de sécurité

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Chaîne sécurité requête API (10k)** | 5 | 55.69 ms | 58.78 ms | 18.8 | +8.64 MB | ✅ PASS |
| **Rate limit, 100k IP distinctes (borne 50k)** | 3 | 44.88 ms | 48.44 ms | 21.9 | +79.22 MB | ✅ PASS |
| **Cache LRU octets tuiles (10k ops, 64 Mo)** | 5 | 3.40 ms | 7.00 ms | 234.6 | +7.92 MB | ✅ PASS |
| **Tuiles : coordonnées + route normalisée (10k)** | 5 | 2.80 ms | 4.92 ms | 298.6 | +25.81 MB | ✅ PASS |
| **Allowlist upstream LiDAR (2k URL)** | 5 | 2.27 ms | 4.45 ms | 375.8 | +7.48 MB | ✅ PASS |

---

## Domaine : Flyover 3D (rail caméra, transport, cadrage)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Rail ligne-droite (20 km)** | 2 | 18.02 ms | 20.93 ms | 55.5 | +36.43 MB | ✅ PASS |
| **Rail courbes (79.9 km)** | 2 | 39.80 ms | 43.34 ms | 25.1 | +38.39 MB | ✅ PASS |
| **Rail lacets (13.1 km)** | 2 | 13.37 ms | 16.42 ms | 74.8 | +22.73 MB | ✅ PASS |
| **Rail alpe-dhuez (15.3 km)** | 2 | 12.32 ms | 15.45 ms | 81.1 | +28.53 MB | ✅ PASS |
| **Rail galibier (18.2 km)** | 2 | 13.19 ms | 15.41 ms | 75.8 | +33.47 MB | ✅ PASS |
| **Rail aller-retour (30 km)** | 2 | 26.60 ms | 27.42 ms | 37.6 | +51.38 MB | ✅ PASS |
| **Rail piste (30.1 km)** | 2 | 23.43 ms | 23.71 ms | 42.7 | +50.24 MB | ✅ PASS |
| **Rail mini (0.6 km)** | 2 | 1.34 ms | 1.40 ms | 747.4 | +1.73 MB | ✅ PASS |
| **Rail long (1198.7 km)** | 2 | 54.91 ms | 55.02 ms | 18.2 | +32.53 MB | ✅ PASS |
| **Rail bruite (15.5 km)** | 2 | 16.81 ms | 21.05 ms | 59.5 | +26.99 MB | ✅ PASS |

---

