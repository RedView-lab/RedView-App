# Rapport de Test-Bench RedView — Performance & Non-Régression

> **Date d'exécution** : 2026-09-13T14:10:15.651Z  
> **Environnement** : Node.js v24.19.0 | win32 (x64)

## Vue d'Ensemble & Scorecard

| Indicateur | Valeur |
| :--- | :--- |
| **Suites Fonctionnelles Exécutées** | **11** |
| **Météo, Pente, Alti, Neige, BRouter, FIT...** | Couverture 100% |
| **Total Opérations Évaluées** | **65** |
| **Statut Conforme (PASS)** | **65** (100.0%) |
| **Avertissements (WARN - Jitter/Peak)** | **0** |
| **Régressions / Dépassements Seuil** | **0** |

## Domaine : Météo (Weather & Radar)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Parsing JSON Open-Meteo (168h x 11 vars)** | 5 | 0.04 ms | 0.07 ms | 19319.9 | +0.13 MB | ✅ PASS |
| **Interpolation Trace (10k pts)** | 5 | 0.14 ms | 1.29 ms | 1780.1 | +3.81 MB | ✅ PASS |
| **Calcul Grille de Vent GPU (Zoom 9)** | 10 | 0.18 ms | 0.29 ms | 5805.9 | +4.14 MB | ✅ PASS |
| **Recoloration Tuile Radar PNG (512x512)** | 5 | 3.58 ms | 4.34 ms | 270.3 | +14.42 MB | ✅ PASS |

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
| **Noyau Horn 3x3 (128x128 MNT)** | 10 | 0.39 ms | 0.91 ms | 2058.0 | +8.84 MB | ✅ PASS |
| **Noyau Horn 3x3 (256x256 MNT standard)** | 5 | 1.78 ms | 2.28 ms | 562.5 | +14.40 MB | ✅ PASS |
| **Noyau Horn 3x3 (512x512 MNT HD)** | 3 | 5.80 ms | 7.52 ms | 155.9 | +7.24 MB | ✅ PASS |
| **Compilation Mapbox Expression (Gradient)** | 25 | 0.00 ms | 0.03 ms | 165892.5 | +0.04 MB | ✅ PASS |
| **Compilation Mapbox Expression (Step + Masque)** | 25 | 0.00 ms | 0.01 ms | 338295.0 | +0.04 MB | ✅ PASS |
| **Lissage Gradient Trace (10k pts, 200m)** | 5 | 0.19 ms | 1.89 ms | 1325.4 | +5.16 MB | ✅ PASS |
| **Génération Tuile Serveur (/slope-tiles)** | 3 | 0.00 ms | 0.02 ms | 109090.9 | +0.00 MB | ✅ PASS |

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
| **Échantillonnage MNT Bilinéaire (1k pts)** | 10 | 0.05 ms | 0.36 ms | 8208.2 | +0.90 MB | ✅ PASS |
| **Échantillonnage MNT Bilinéaire (10k pts)** | 5 | 0.16 ms | 1.55 ms | 1947.1 | +4.43 MB | ✅ PASS |
| **Échantillonnage MNT Bilinéaire (50k pts)** | 3 | 0.97 ms | 1.34 ms | 944.9 | +0.00 MB | ✅ PASS |
| **Calcul D+/D- Seuil 5m (50k pts)** | 10 | 0.20 ms | 1.24 ms | 2600.9 | +1.00 MB | ✅ PASS |
| **Génération Échelle Altitudes (6 couleurs)** | 50 | 0.01 ms | 0.05 ms | 44682.8 | +0.23 MB | ✅ PASS |
| **Génération Tuile Serveur (/altitude-tiles)** | 3 | 0.00 ms | 0.02 ms | 132743.4 | +0.00 MB | ✅ PASS |

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
| **Upsampling Bilinéaire (32x32 → 256x256)** | 12 | 0.56 ms | 3.70 ms | 728.4 | +7.60 MB | ✅ PASS |
| **Lissage Gaussien Séparable (256x256, σ=2.0)** | 6 | 2.40 ms | 9.17 ms | 269.8 | +7.62 MB | ✅ PASS |
| **Indice d'Abri Winstral Sx (128x128, 5 dirs)** | 3 | 8.24 ms | 12.45 ms | 102.2 | +5.00 MB | ✅ PASS |
| **Routage de flux D-infinity & Accumulation (128x128)** | 3 | 13.55 ms | 17.77 ms | 76.5 | +6.99 MB | ✅ PASS |
| **Pipeline 7 Phases Universitaire (SnowSlide + Eolien)** | 2 | 101.16 ms | 112.76 ms | 9.9 | +27.17 MB | ✅ PASS |

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
| **Compilation Profil BRF Dynamique (Gravel)** | 25 | 0.06 ms | 0.66 ms | 6647.2 | +0.44 MB | ✅ PASS |
| **Compilation Profil BRF Dynamique (Route)** | 25 | 0.02 ms | 0.09 ms | 25301.1 | +0.29 MB | ✅ PASS |
| **Encodage & Validation No-Go Areas (BRouter URL)** | 50 | 0.00 ms | 0.00 ms | 239923.2 | -0.08 MB | ✅ PASS |
| **Découpage Géométrique Trace (Split 50k pts à 25k)** | 5 | 0.68 ms | 1.09 ms | 1334.6 | +22.53 MB | ✅ PASS |
| **Fusion Géométrique Traces (Merge 2x 25k pts)** | 5 | 1.33 ms | 1.84 ms | 705.9 | +21.94 MB | ✅ PASS |
| **Calcul Métriques & Tortuosité (10k pts)** | 5 | 0.22 ms | 0.34 ms | 4066.7 | +3.06 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Full Route)** | 1 | 424.27 ms | 424.27 ms | 2.4 | +0.77 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Full VTT/Sentiers)** | 1 | 570.67 ms | 570.67 ms | 1.8 | +0.72 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Plat / D+ = 0)** | 1 | 186.41 ms | 186.41 ms | 5.4 | +0.60 MB | ✅ PASS |
| **Live One-Pass: Gien→Orléans (Grimpeur / D+=100)** | 1 | 687.32 ms | 687.32 ms | 1.5 | +0.84 MB | ✅ PASS |
| **Live One-Pass: St-Étienne→Chamonix 300km** | 1 | 14545.58 ms | 14545.58 ms | 0.1 | +2.50 MB | ✅ PASS |

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
| **Calcul Densité d'Air Dynamique ρ(h, T)** | 50 | 0.13 ms | 0.19 ms | 7391.5 | +0.02 MB | ✅ PASS |
| **Bilan de Puissance Stationnaire (10k itérations)** | 25 | 0.15 ms | 0.34 ms | 4915.5 | +1.53 MB | ✅ PASS |
| **Courbe de Fatigue Exponentielle (24h simulation)** | 50 | 0.03 ms | 0.06 ms | 28477.0 | +3.42 MB | ✅ PASS |
| **Convergence Vitesse Newton-Raphson (10k segments)** | 5 | 3.31 ms | 4.17 ms | 348.3 | +2.26 MB | ✅ PASS |
| **Simulation Étape Ultra (50k segments, vent/relief)** | 3 | 4.77 ms | 4.78 ms | 209.8 | +0.00 MB | ✅ PASS |

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
| **Reprojection Géodésique Lambert-93 → WGS84 (10k pts)** | 3 | 5.50 ms | 6.93 ms | 166.6 | +0.27 MB | ✅ PASS |
| **Empaquetage Tampon WebGL (100k pts x,y,z,rgba,norm)** | 6 | 1.03 ms | 2.31 ms | 754.1 | +1.57 MB | ✅ PASS |
| **Simulation Soleil : Éclairage Lambertien (100k pts)** | 3 | 0.35 ms | 1.23 ms | 1506.3 | +3.90 MB | ✅ PASS |
| **Simulation Soleil : Ombres Portées Ray-Casting (100k pts)** | 2 | 1.82 ms | 2.49 ms | 549.9 | +2.46 MB | ✅ PASS |
| **Mapping Tuiles Web-Mercator Zoom 16 (10k pts)** | 15 | 0.31 ms | 0.64 ms | 2867.1 | +0.84 MB | ✅ PASS |

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
| **Projection Métrique Trace (projectRoutePoints 10k pts)** | 10 | 0.09 ms | 1.15 ms | 2996.4 | +4.05 MB | ✅ PASS |
| **Filtrage Corridor Bounding Box (2 500 POIs)** | 5 | 0.34 ms | 0.60 ms | 2543.0 | +4.55 MB | ✅ PASS |
| **Projection Orthogonale POIs (projectPoiOntoRoute)** | 10 | 0.52 ms | 0.79 ms | 1662.1 | +1.87 MB | ✅ PASS |
| **Clustering Spatial (buildPoiClusters 500 POIs)** | 25 | 0.10 ms | 0.19 ms | 8634.1 | +1.84 MB | ✅ PASS |

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
| **Sérialisation GPX (1k pts)** | 20 | 0.53 ms | 0.70 ms | 1937.8 | +3.75 MB | ✅ PASS |
| **Sérialisation GPX (10k pts)** | 5 | 4.25 ms | 4.79 ms | 239.1 | +7.36 MB | ✅ PASS |
| **Sérialisation GPX Échelle Ultra (50k pts)** | 3 | 30.32 ms | 30.40 ms | 34.7 | +94.06 MB | ✅ PASS |
| **Parsing GPX XML Regex (10k pts)** | 5 | 3.36 ms | 4.63 ms | 271.0 | +48.37 MB | ✅ PASS |
| **Parsing GPX XML Regex (50k pts)** | 2 | 16.13 ms | 16.25 ms | 62.0 | +26.16 MB | ✅ PASS |
| **Sérialisation GeoJSON (50k pts)** | 3 | 11.28 ms | 12.52 ms | 86.0 | +22.63 MB | ✅ PASS |
| **Échappement XML (100k chaînes)** | 25 | 0.54 ms | 0.69 ms | 1694.9 | +32.06 MB | ✅ PASS |

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
| **Génération Série Altitude (Mode Heure, 24k pts)** | 5 | 0.00 ms | 0.09 ms | 38819.9 | +0.00 MB | ✅ PASS |
| **Génération Série Inclinaison (Mode Temps, 24k pts)** | 5 | 0.00 ms | 0.05 ms | 65530.8 | +0.00 MB | ✅ PASS |
| **Génération Série Vitesse (Mode Distance, 24k pts)** | 5 | 0.00 ms | 0.02 ms | 181159.4 | +0.00 MB | ✅ PASS |
| **Downsampling LTTB 60 FPS (24k pts → 1 200 pts)** | 20 | 0.00 ms | 0.01 ms | 1176470.6 | +0.00 MB | ✅ PASS |
| **Calcul Domaine Y (computeDomain sur 24k pts)** | 25 | 0.00 ms | 0.01 ms | 644329.9 | +0.01 MB | ✅ PASS |
| **Recherche Curseur Hover (1k requêtes dichotomiques)** | 25 | 0.02 ms | 0.04 ms | 50658.6 | +0.77 MB | ✅ PASS |

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
| **Vérification Rate Limiting IP (10k requêtes)** | 5 | 1.61 ms | 2.17 ms | 584.4 | +5.05 MB | ✅ PASS |
| **Cache LRU Éviction & Insertion (10k ops, cap 1024)** | 5 | 2.97 ms | 3.32 ms | 326.5 | +9.94 MB | ✅ PASS |
| **Résolution IP Forwarded Headers (10k requêtes)** | 10 | 0.31 ms | 0.58 ms | 2983.0 | +4.24 MB | ✅ PASS |
| **Vérification Anti Path-Traversal (10k requêtes URL)** | 10 | 2.04 ms | 3.35 ms | 437.8 | +36.03 MB | ✅ PASS |
| **Formatage JSON Health Endpoint (/health)** | 50 | 0.28 ms | 0.41 ms | 3283.0 | +8.14 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Fuite mémoire de rateLimitMap sous attaque DDoS avec des millions d’IPs distinctes : la boucle de purge à 5 min ne libère pas assez vite la mémoire.**
- **Cache LRU en mémoire mono-instance : lors du scale horizontal Docker dans Coolify, les caches ne sont pas partagés entre conteneurs.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Déporter le rate-limiting et le cache de tuiles dans un cluster Redis partagé si le déploiement passe en multi-replicas Docker.
- Ajouter une limite maximale de taille (ex: max 10 000 entrées) sur la table rateLimitMap pour borner la consommation mémoire à 5 Mo maximum.

---

