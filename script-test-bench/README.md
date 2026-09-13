# Suite de Test-Bench & Détection de Régression RedView

Bienvenue dans la suite d'ingénierie **DevOps & Performance Test-Bench** de RedView App.
Ce dossier regroupe un ensemble complet de benchmarks, d'assertions de non-régression et d'analyses de scalabilité couvrant 100% des domaines fonctionnels de l'écosystème RedView.

---

## 🚀 Démarrage Rapide

Depuis le dossier `redview-app` :

```bash
# 1. Lancer l'intégralité des test-benches (Génère le rapport Markdown & JSON)
npm run bench

# 2. Mode rapide (CI/CD ou pré-commit, moins d'itérations)
npm run bench:quick

# 3. Lancer un test-bench spécifique par fonctionnalité
npm run bench:meteo     # Météorologie & Radar Doppler
npm run bench:pente     # Pente & Filtre Horn 3x3
npm run bench:alti      # Altitude, MNT & D+/D-
npm run bench:neige     # Nivologie Universitaire 7 phases
npm run bench:brouter   # BRouter, Profils BRF & No-Go
npm run bench:fit       # FIT Predictor & Simulation Physique
npm run bench:lidar     # LiDAR IGN, Reprojection & Soleil/Ombres 3D
npm run bench:poi       # Points d'Intérêt & Corridor Overpass
npm run bench:exporter  # Exporter GPX, GeoJSON & Parsers
npm run bench:chart     # Graphiques Multi-Axes & Timeline
npm run bench:server    # Serveur Node.js, Rate Limiting & Cache LRU
```

Depuis la racine du projet (`REDVIEWproduction`) :

```bash
node script-test-bench/run.mjs --quick
```

---

## 📊 Fonctionnalités Testées & Couverture

| Fichier | Domaine Fonctionnel | Opérations & Algorithmes Évalués |
| :--- | :--- | :--- |
| **`bench-meteo.ts`** | Météo & Radar | Parsing JSON Open-Meteo (168h), interpolation trace spatio-temporelle, grille de vent régularisée GPU, recoloration binaire PNG RainViewer Doppler (`recolorRadarPng`). |
| **`bench-pente.ts`** | Pente & MNT | Noyau différentiel Horn 3x3 (128x128 à 512x512), encodage sqrt-gamma, tuiles raster serveur (`generateSlopeTile`), lissage gradient trace. |
| **`bench-alti.ts`** | Altitude & Relief | Conversion Terrarium vers Terrain-RGB, échantillonnage bilinéaire (1k, 10k, 50k pts), calcul D+/D- avec seuillage anti-bruit (5m). |
| **`bench-neige.ts`** | Nivologie Universitaire | Modélisation physique 7 phases : López-Moreno, SnowSlide gravitationnel, indice d'abri au vent Winstral ($S_x$), écoulement Tarboton D-infinity, conservation de masse. |
| **`bench-brouter.ts`** | BRouter & Routage | Compilation dynamique du profil BRF (`buildBrfProfile`), validation polygones No-Go Areas, découpage (`routeSplit`) et fusion (`routeMerge`) sur 50k points. |
| **`bench-fit-predictor.ts`** | Simulation Physique | Bilan de puissance (gravité, roulement, aéro $C_d A$, chaîne), densité d'air dynamique $\rho(h, T)$, fatigue exponentielle $\lambda$, convergence vitesse Newton-Raphson. |
| **`bench-lidar.ts`** | LiDAR IGN & Soleil | Reprojection Lambert-93/WGS84 via `proj4`, empaquetage GPU Float32Array, **simulation soleil dans le nuage de points** (éphéméride, éclairage direct $N \cdot L$, ombres portées ray-casting). |
| **`bench-poi.ts`** | POI & Overpass | Filtrage spatial de corridor (2 500 POIs), projection orthogonale sur trace, clustering spatial (`buildPoiClusters`). |
| **`bench-exporter.ts`** | Export / Import | Sérialisation GPX complète (1k, 10k, 50k pts), parsing GPX XML Regex, FeatureCollection GeoJSON, micro-benchmark d'échappement XML. |
| **`bench-center-panel.ts`** | Graphiques & Roadbook | Cache des séries (`buildSeriesFromPrediction`) sur 14 variables, downsampling LTTB 60 FPS (24k pts → 1 200 pts), recherche dichotomique curseur hover. |
| **`bench-server-api.ts`** | Serveur & Infra | Débit rate-limiter IP sous burst, cache LRU 10k opérations, résolution IP (Traefik/Cloudflare), protection anti-traversal, endpoint `/health`. |

---

## 📈 Rapports & Métriques Produites

À chaque exécution de `run-all-benchmarks.ts`, deux livrables sont automatiquement générés dans `reports/` :

1. **`reports/LATEST_BENCHMARK_REPORT.md`** :
   - Tableau synthétique de toutes les opérations avec percentiles p50, p95, ops/sec et différentiel mémoire heap.
   - Bilan des régressions détectées (dépassements de seuils).
   - Recommandations d'optimisation d'architecture pour chaque composant.
2. **`reports/benchmarks-<timestamp>.json`** :
   - Fichier JSON brut avec les métadonnées complètes pour ingestion dans un tableau de bord Datadog, Prometheus ou GitHub Actions.

---

## ⚙️ Paramètres CLI Disponibles

- `--quick` : Réduit le nombre d'itérations pour une exécution ultra-rapide (<3 secondes).
- `--feature=<id>` : Exécute uniquement le module ciblé (`meteo`, `pente`, `alti`, `neige`, `brouter`, `fit`, `lidar`, `poi`, `exporter`, `chart`, `server`).
- `--no-report` : N'écrit pas de fichiers sur le disque (affichage console uniquement).

---

## 🛠️ Architecture du Moteur (`core/`)

- **`core/harness.ts`** : Moteur de calcul statistique de haute précision (`performance.now()`), calcul de percentiles (p50, p95, p99), détection de jitter et régression.
- **`core/reporter.ts`** : Formateur console ANSI avec codes couleur et badges de statut (`PASS`, `WARN`, `REGRESSION`), générateur Markdown & JSON.
- **`core/synthetic-data.ts`** : Générateur déterministe de traces alpines (Cols mythiques), de grilles MNT avec relief fractal, de données AROME et de jeux de POIs.
