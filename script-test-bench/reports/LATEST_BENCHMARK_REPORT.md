# Rapport de Test-Bench RedView — Performance & Non-Régression

> **Date d'exécution** : 2026-09-22T21:42:05.832Z  
> **Environnement** : Node.js v24.19.0 | win32 (x64)

## Vue d'Ensemble & Scorecard

| Indicateur | Valeur |
| :--- | :--- |
| **Suites Fonctionnelles Exécutées** | **1** |
| **Météo, Pente, Alti, Neige, BRouter, FIT...** | Couverture 100% |
| **Total Opérations Évaluées** | **4** |
| **Statut Conforme (PASS)** | **4** (100.0%) |
| **Avertissements (WARN - Jitter/Peak)** | **0** |
| **Régressions / Dépassements Seuil** | **0** |

## Domaine : Météo (Weather & Radar)

| Opération / Fonctionnalité | Iter | p50 (ms) | p95 (ms) | Débit (ops/s) | Mémoire Δ | Statut |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Parsing JSON Open-Meteo (168h x 11 vars)** | 20 | 0.02 ms | 0.04 ms | 41459.4 | +0.47 MB | ✅ PASS |
| **Interpolation Trace (10k pts)** | 20 | 0.08 ms | 0.18 ms | 9764.7 | +0.02 MB | ✅ PASS |
| **Calcul Grille de Vent GPU (Zoom 9)** | 40 | 0.06 ms | 0.35 ms | 8259.0 | +2.18 MB | ✅ PASS |
| **Recoloration Tuile Radar PNG (512x512)** | 20 | 1.44 ms | 1.94 ms | 586.5 | -12.25 MB | ✅ PASS |

### ⚠️ Risques de Régression Surveillés

- **Recoloration binaire synchrone sur le thread Node.js : décompression zlib 512x512 saturant sous charge concurrente.**
- **Taille mémoire des grilles de vent : fuite potentielle si les textures GPU ne sont pas libérées lors du pan.**

### 💡 Pistes d'Amélioration DevOps & Architecture

- Mettre en cache LRU en mémoire les tuiles radar recolorées (clé: tile_z_x_y + hash_palette) pour un coût CPU nul sur requêtes répétées.
- Déporter la recoloration RainViewer vers un Web Worker ou shader WebGL côté client pour décharger à 100% le serveur Node.

---

