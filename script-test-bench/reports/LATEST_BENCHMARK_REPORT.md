# Rapport de Test-Bench RedView — Performance & Non-Régression

> **Date d'exécution** : 2026-09-13T14:46:22.908Z  
> **Environnement** : Node.js v24.19.0 | win32 (x64)

## Vue d'Ensemble & Scorecard

| Indicateur | Valeur |
| :--- | :--- |
| **Suites Fonctionnelles Exécutées** | **11** |
| **Météo, Pente, Alti, Neige, BRouter, FIT...** | Couverture 100% |
| **Total Opérations Évaluées** | **67** |
| **Statut Conforme (PASS)** | **67** (100.0%) |
| **Avertissements (WARN - Jitter/Peak)** | **0** |
| **Régressions / Dépassements Seuil** | **0** |

## Domaine : Météo (Weather & Radar)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Parsing JSON Open-Meteo (168h x 11 vars)** | 20 | 0.02 ms | 0.03 ms | 43262.0 | +0.48 MB | ✅ PASS |
| **Interpolation Trace (10k pts)** | 20 | 0.08 ms | 0.18 ms | 9074.0 | +0.02 MB | ✅ PASS |
| **Calcul Grille de Vent GPU (Zoom 9)** | 40 | 0.08 ms | 0.26 ms | 8674.0 | +1.95 MB | ✅ PASS |
| **Recoloration Tuile Radar PNG (512x512)** | 20 | 1.38 ms | 2.59 ms | 590.0 | -12.68 MB | ✅ PASS |

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
| **Noyau Horn 3x3 (128x128 MNT)** | 40 | 0.55 ms | 0.61 ms | 1878.1 | +28.63 MB | ✅ PASS |
| **Noyau Horn 3x3 (256x256 MNT standard)** | 20 | 1.33 ms | 1.70 ms | 722.4 | +9.58 MB | ✅ PASS |
| **Noyau Horn 3x3 (512x512 MNT HD)** | 10 | 5.24 ms | 5.58 ms | 190.0 | +4.08 MB | ✅ PASS |
| **Compilation Mapbox Expression (Gradient)** | 100 | 0.00 ms | 0.00 ms | 584453.5 | +0.17 MB | ✅ PASS |
| **Compilation Mapbox Expression (Step + Masque)** | 100 | 0.00 ms | 0.00 ms | 917431.2 | +0.16 MB | ✅ PASS |
| **Lissage Gradient Trace (10k pts, 200m)** | 20 | 0.13 ms | 0.18 ms | 7463.0 | +5.91 MB | ✅ PASS |
| **Génération Tuile Serveur (/slope-tiles)** | 8 | 0.00 ms | 0.00 ms | 1142857.1 | +0.01 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Bordures de tuiles MNT : discontinuités du filtre Horn sans padding 1px (halo artefact sur les joints de tuiles).**
- **Coût CPU Horn 512x512 sur mobile : 512x512 exige 262k opérations trigonométriques Math.atan/hypot.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Compiler le noyau Horn en WebAssembly ou déporter le calcul dans un CustomLayer WebGL (calcul direct sur le GPU fragment shader).
- Pré-calculer une LUT (Look-Up Table) pour remplacer Math.atan(hypot) * (180 / Math.PI) par un accès direct Uint8.

---

## Domaine : Altitude (Elevation & D+/D-)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Échantillonnage MNT Bilinéaire (1k pts)** | 40 | 0.04 ms | 0.04 ms | 24683.7 | +0.03 MB | ✅ PASS |
| **Échantillonnage MNT Bilinéaire (10k pts)** | 20 | 0.24 ms | 0.26 ms | 4183.0 | +0.02 MB | ✅ PASS |
| **Échantillonnage MNT Bilinéaire (50k pts)** | 10 | 0.72 ms | 0.77 ms | 1378.7 | +0.00 MB | ✅ PASS |
| **Calcul D+/D- Seuil 5m (50k pts)** | 40 | 0.12 ms | 0.15 ms | 7971.1 | +0.32 MB | ✅ PASS |
| **Génération Échelle Altitudes (6 couleurs)** | 200 | 0.00 ms | 0.00 ms | 293384.2 | +0.96 MB | ✅ PASS |
| **Génération Tuile Serveur (/altitude-tiles)** | 6 | 0.00 ms | 0.00 ms | 1935483.9 | +0.01 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Bruit GPS haute fréquence : un seuil de détection D+ inférieur à 3m entraîne une surévaluation de 15% à 40% du D+ total.**
- **Pics de mémoire sur traces > 50k points lors de l’échantillonnage DEM sans downsampling préalable.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Appliquer un filtre de Hystérésis ou Ramer-Douglas-Peucker 1D sur l’élévation brute avant le calcul du dénivelé.
- Utiliser des SharedArrayBuffers ou buffers Float32Array réutilisés pour les tuiles de terrain afin d’éliminer les allocations V8.

---

## Domaine : Neige (Snow Physics & Nivologie)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Upsampling Bilinéaire (32x32 → 256x256)** | 40 | 0.49 ms | 0.54 ms | 2006.6 | +0.04 MB | ✅ PASS |
| **Lissage Gaussien Séparable (256x256, σ=2.0)** | 20 | 1.24 ms | 1.94 ms | 700.4 | +0.27 MB | ✅ PASS |
| **Indice d'Abri Winstral Sx (128x128, 5 dirs)** | 10 | 7.51 ms | 7.67 ms | 133.1 | +0.03 MB | ✅ PASS |
| **Routage de flux D-infinity & Accumulation (128x128)** | 10 | 6.51 ms | 9.61 ms | 144.4 | +25.83 MB | ✅ PASS |
| **Pipeline 7 Phases Universitaire (SnowSlide + Eolien)** | 5 | 57.47 ms | 62.61 ms | 17.6 | +24.03 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Calcul de l'indice d'abri Winstral Sx : complexité O(W × H × N_steps × N_dirs). Au-delà de 256x256, goulot CPU sévère (>500ms).**
- **Instabilité gravitationnelle de SnowSlide si frictionAngleDeg < 30° : risque de transfert infini entre cellules en boucle fermée.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Exécuter obligatoirement computeSnowRedistribution dans un Web Worker d’arrière-plan (déjà supporté via redistributeWorker.ts).
- Sous-échantillonner la grille terrain à 128x128 pour le calcul physique puis sur-échantillonner le résultat (gain de 400% sur le temps de calcul).

---

## Domaine : BRouter (Routing Engine & BRF)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Compilation Profil BRF Dynamique (Gravel)** | 100 | 0.01 ms | 0.04 ms | 72160.5 | +1.34 MB | ✅ PASS |
| **Compilation Profil BRF Dynamique (Route)** | 100 | 0.01 ms | 0.01 ms | 123152.7 | +1.14 MB | ✅ PASS |
| **Encodage & Validation No-Go Areas (BRouter URL)** | 200 | 0.00 ms | 0.00 ms | 585137.5 | +0.44 MB | ✅ PASS |
| **Découpage Géométrique Trace (Split 50k pts à 25k)** | 20 | 0.51 ms | 2.05 ms | 1372.1 | +27.34 MB | ✅ PASS |
| **Fusion Géométrique Traces (Merge 2x 25k pts)** | 20 | 1.14 ms | 1.58 ms | 908.7 | +26.09 MB | ✅ PASS |
| **Calcul Métriques & Tortuosité (10k pts)** | 20 | 0.03 ms | 0.06 ms | 30362.8 | +0.03 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Full Route)** | 2 | 378.77 ms | 387.51 ms | 2.6 | +1.63 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Full VTT/Sentiers)** | 2 | 495.53 ms | 552.40 ms | 2.0 | +1.19 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Plat / D+ = 0)** | 2 | 162.60 ms | 171.97 ms | 6.1 | +1.03 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Grimpeur / D+=100)** | 2 | 673.95 ms | 695.50 ms | 1.5 | +1.67 MB | ✅ PASS |
| **Live One-Pass: St-Étienne→Chamonix 300km** | 1 | 14623.62 ms | 14623.62 ms | 0.1 | -17.54 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Désactivation du mode one-pass (pass2coefficient >= 0) : complexité quadratique provoquant des timeouts (>30-60s) sur les traversées régionales et alpines.**
- **Complexité des No-Go Areas : les polygones avec plus de 50 sommets ralentissent drastiquement l’algorithme A* de BRouter.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Curseur D+ : en mode One-Pass (pass2=-1), l’algorithme évite ou recherche activement le relief de façon ultra-rapide (<350ms sur 70km, ~12s sur 300km).
- Curseurs Route vs VTT : les pénalités de revêtement s’appliquent immédiatement sans ralentir l’heuristique linéaire A*.
- Mettre en cache le hash SHA-256 du profil BRF généré pour éviter les requêtes de re-téléchargement vers le VPS.
- Simplifier les polygones de zones interdites avec l’algorithme Ramer-Douglas-Peucker avant encodage dans l’URL BRouter.

---

## Domaine : FIT Predictor (Simulation Physique & Effort)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Calcul Densité d'Air Dynamique ρ(h, T)** | 200 | 0.11 ms | 0.14 ms | 8455.5 | +0.05 MB | ✅ PASS |
| **Bilan de Puissance Stationnaire (10k itérations)** | 100 | 0.13 ms | 0.14 ms | 7152.8 | +0.59 MB | ✅ PASS |
| **Courbe de Fatigue Exponentielle (24h simulation)** | 200 | 0.01 ms | 0.05 ms | 91558.3 | +1.34 MB | ✅ PASS |
| **Convergence Vitesse Newton-Raphson (10k segments)** | 20 | 0.86 ms | 0.96 ms | 1121.2 | +2.13 MB | ✅ PASS |
| **Simulation Étape Ultra (50k segments, vent/relief)** | 10 | 4.41 ms | 4.59 ms | 224.7 | -0.73 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Divergence de convergence Newton-Raphson sur les fortes descentes (>15%) avec vent arrière extrême.**
- **Pression GC V8 lors de la création de 50 000 objets PredictionPoint dans la boucle de simulation.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Déporter la boucle de simulation dans le moteur WebAssembly Rust (crates/fit-predictor) déjà préparé dans vendor/redviewalgo.
- Structurer les résultats en TypedArrays contigus (Float32Array pour temps, vitesse, watts) plutôt qu’un tableau d’objets JS.

---

## Domaine : LiDAR IGN & Nuages de Points 3D (avec Soleil & Ombres)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Reprojection Géodésique Lambert-93 → WGS84 (10k pts)** | 10 | 4.83 ms | 5.43 ms | 200.9 | -0.61 MB | ✅ PASS |
| **Empaquetage Tampon WebGL (100k pts x,y,z,rgba,norm)** | 20 | 0.66 ms | 1.31 ms | 980.3 | -10.20 MB | ✅ PASS |
| **Simulation Soleil : Éclairage Lambertien (100k pts)** | 10 | 0.31 ms | 0.32 ms | 3184.6 | +0.01 MB | ✅ PASS |
| **Simulation Soleil : Ombres Portées Ray-Casting (100k pts)** | 5 | 0.57 ms | 0.57 ms | 1772.1 | +0.01 MB | ✅ PASS |
| **Mapping Tuiles Web-Mercator Zoom 16 (10k pts)** | 50 | 0.21 ms | 0.26 ms | 4534.5 | -2.86 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Reprojection proj4.forward sur le Main Thread : proj4 est en JavaScript pur non-vectorisé (~1.2 µs/point, soit 1.2s pour 1M de points).**
- **Lancer de rayons d’ombres solaires sur nuage de points non-indexé : complexité O(N × steps) provoquant des drops de framerate.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Déporter impérativement la reprojection géodésique proj4 dans un Web Worker ou utiliser une approximation polynomiale rapide (polynômes de Tchebychev sur la grille locale).
- Calculer l’ombrage solaire (N · L et shadow map) directement dans le Vertex/Fragment Shader WebGL via une texture de profondeur (Shadow Mapping GPU).

---

## Domaine : POI (Points d’Intérêt & Corridor Overpass)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Projection Métrique Trace (projectRoutePoints 10k pts)** | 40 | 0.08 ms | 0.54 ms | 5498.4 | +2.97 MB | ✅ PASS |
| **Filtrage Corridor Bounding Box (2 500 POIs)** | 20 | 0.06 ms | 0.12 ms | 14191.4 | +3.50 MB | ✅ PASS |
| **Projection Orthogonale POIs (projectPoiOntoRoute)** | 40 | 0.52 ms | 0.57 ms | 1865.5 | +5.93 MB | ✅ PASS |
| **Clustering Spatial (buildPoiClusters 500 POIs)** | 100 | 0.06 ms | 0.16 ms | 11699.7 | +2.66 MB | ✅ PASS |

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
| **Sérialisation GPX (1k pts)** | 80 | 0.43 ms | 0.62 ms | 2154.9 | -5.42 MB | ✅ PASS |
| **Sérialisation GPX (10k pts)** | 20 | 3.33 ms | 6.35 ms | 253.0 | +0.64 MB | ✅ PASS |
| **Sérialisation GPX Échelle Ultra (50k pts)** | 10 | 24.63 ms | 30.15 ms | 40.3 | +106.99 MB | ✅ PASS |
| **Parsing GPX XML Regex (10k pts)** | 20 | 2.82 ms | 3.31 ms | 349.0 | -4.74 MB | ✅ PASS |
| **Parsing GPX XML Regex (50k pts)** | 10 | 16.79 ms | 22.01 ms | 58.2 | +51.22 MB | ✅ PASS |
| **Sérialisation GeoJSON (50k pts)** | 10 | 11.31 ms | 13.67 ms | 84.6 | +65.23 MB | ✅ PASS |
| **Échappement XML (100k chaînes)** | 100 | 0.53 ms | 0.68 ms | 1694.8 | -32.34 MB | ✅ PASS |

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
| **Génération Série Altitude (Mode Heure, 24k pts)** | 20 | 0.00 ms | 0.01 ms | 300751.9 | +0.22 MB | ✅ PASS |
| **Génération Série Inclinaison (Mode Temps, 24k pts)** | 20 | 0.00 ms | 0.00 ms | 947867.3 | +0.02 MB | ✅ PASS |
| **Génération Série Vitesse (Mode Distance, 24k pts)** | 20 | 0.00 ms | 0.00 ms | 826446.3 | +0.01 MB | ✅ PASS |
| **Downsampling LTTB 60 FPS (24k pts → 1 200 pts)** | 80 | 0.00 ms | 0.00 ms | 5839416.1 | +0.02 MB | ✅ PASS |
| **Calcul Domaine Y (computeDomain sur 24k pts)** | 100 | 0.00 ms | 0.00 ms | 2386634.8 | +0.20 MB | ✅ PASS |
| **Recherche Curseur Hover (1k requêtes dichotomiques)** | 100 | 0.00 ms | 0.02 ms | 142592.3 | +0.18 MB | ✅ PASS |
| **Génération Série Météo Température (Mode Distance, 24k pts)** | 20 | 0.00 ms | 0.00 ms | 711743.8 | +0.02 MB | ✅ PASS |
| **Génération Série Météo Pluie (Mode Heure, 24k pts)** | 20 | 0.00 ms | 0.00 ms | 704225.4 | +0.02 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Re-rendu SVG React sur 24k points sans downsampling : freeze complet du DOM (>300ms de scripting et garbage collection).**
- **Invalidation globale du cache graphique : changer une seule variable Y2 recalcule actuellement les deux axes inutilement.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Rendre le graphique via HTML5 Canvas 2D ou WebGL (uPlot ou Canvas natif) plutôt qu’un SVG React pour garantir 60 FPS constants lors du survol.
- Intégrer le downsampling LTTB (Largest Triangle Three Buckets) dès la sortie du buildSeriesFromPrediction pour limiter les tableaux à 1 200 éléments.

---

## Domaine : Serveur & Infrastructure API (Node.js & Coolify)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Vérification Rate Limiting IP (10k requêtes)** | 20 | 1.42 ms | 2.02 ms | 616.1 | -34.92 MB | ✅ PASS |
| **Cache LRU Éviction & Insertion (10k ops, cap 1024)** | 20 | 2.70 ms | 2.91 ms | 366.2 | +36.78 MB | ✅ PASS |
| **Résolution IP Forwarded Headers (10k requêtes)** | 40 | 0.16 ms | 0.25 ms | 3285.0 | -42.77 MB | ✅ PASS |
| **Vérification Anti Path-Traversal (10k requêtes URL)** | 40 | 1.80 ms | 2.29 ms | 530.5 | +13.25 MB | ✅ PASS |
| **Formatage JSON Health Endpoint (/health)** | 200 | 0.27 ms | 0.30 ms | 3567.7 | +32.09 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Fuite mémoire de rateLimitMap sous attaque DDoS avec des millions d’IPs distinctes : la boucle de purge à 5 min ne libère pas assez vite la mémoire.**
- **Cache LRU en mémoire mono-instance : lors du scale horizontal Docker dans Coolify, les caches ne sont pas partagés entre conteneurs.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Déporter le rate-limiting et le cache de tuiles dans un cluster Redis partagé si le déploiement passe en multi-replicas Docker.
- Ajouter une limite maximale de taille (ex: max 10 000 entrées) sur la table rateLimitMap pour borner la consommation mémoire à 5 Mo maximum.

---

