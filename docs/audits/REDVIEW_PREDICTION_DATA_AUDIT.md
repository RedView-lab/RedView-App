# Audit & Recherche — Exploitation des données utilisateur dans le calculateur de pace

> **Date** : 22 septembre 2026
> **Périmètre** : `vendor/redviewalgo` (moteur Rust/WASM), `src/features/fitPredictor`, `src/features/itineraryPanel`
> **Méthode** : lecture exhaustive du pipeline + **expérience contrôlée exécutant le vrai moteur WASM**
> (harnais : `script-test-bench/audit-predictor-nopower.mjs`, sortie brute : `audit-predictor-nopower-output.txt`)

---

## 1. Résumé exécutif

Trois constats, dont deux contre-intuitifs.

### 1.1 Sans puissance, la prédiction est **excellente** — à une condition

| Cible | Historique | Écart temps (sans W) | Écart temps (avec W) |
| :--- | :--- | ---: | ---: |
| 104 km | 4 sorties, max 120 km | **+1,5 %** | +11,5 % |
| 268 km | 4 sorties, max 72 km | **+54,3 %** | +30,9 % |

Sans capteur de puissance, la prédiction est **meilleure qu'avec** tant que la sortie cible reste dans l'enveloppe de ce que le coureur a déjà roulé. Elle se dégrade beaucoup plus vite dès qu'on en sort.

**Le facteur déterminant n'est ni le volume total, ni le nombre de fichiers, mais la longueur de la plus longue sortie de l'historique :**

| Plus longue sortie de l'historique | Volume cumulé | Écart sur une cible de 268 km |
| ---: | ---: | ---: |
| 60 km | 165 km | +73,7 % |
| 100 km | 205 km | +40,9 % |
| 140 km | 245 km | +30,0 % |
| 180 km | 285 km | +14,7 % |
| 220 km | 325 km | +10,6 % |
| 260 km | 365 km | **+9,4 %** |

Empiler 8 FIT courts (520 km cumulés, max 95 km) ne donne **que +47,9 %** : le volume ne compense pas l'absence d'une sortie longue. C'est le levier n°1 à communiquer à l'utilisateur.

### 1.2 Six réglages que l'utilisateur saisit et qui **ne servent à rien**

Sur les 10 champs du panneau Rythme, **6 n'atteignent jamais le moteur de prédiction** (voir §3). Dont trois sont pourtant câblés côté moteur et attendent seulement d'être branchés.

### 1.3 La FC **dégrade** le modèle aujourd'hui

Mesuré : en invalidant la FC dans les FIT d'entraînement, l'erreur passe de **+54,3 % → +40,6 %** sur la cible longue. La FC est un descripteur du *passé* utilisé comme dimension de distance KNN, mais elle est **figée à 0,7 au moment de la prédiction** (`knn/mod.rs:196`). Elle n'apporte donc aucune information au moment du calcul — elle n'introduit qu'un biais.

---

## 2. Ce que le moteur fait réellement sans puissance

Le parseur FIT ne requiert **pas** de puissance (`fit_parser.rs:237`, `power_w` retombe à `0.0`). Le moteur a 4 chemins, évalués dans cet ordre par point de route (`prediction/speed.rs:483-606`) :

| # | Condition | Modèle | W requis |
| :-: | :--- | :--- | :-: |
| 1 | `use_knn && has_physics` | Ensemble KNN + physique | oui |
| 2 | `use_knn` | KNN seul | **non** |
| 3 | `has_physics` | Physique seul | oui |
| 4 | sinon | Bins empiriques pente→vitesse | **non** |

avec `has_physics = profile.has_power && profile.ftp_w > 50` (`speed.rs:198`) et « KNN utilisable » = ≥ 50 échantillons (`knn/mod.rs:10`).

**Aucune feature KNN n'utilise la puissance** (`knn/features.rs:249-258`) : pente, temps écoulé, D+ cumulé, pente moyenne récente, altitude, distance, zone FC, température. Les bins de pente (`gradient_bins.rs`) sont construits sur vitesse + gradient uniquement.

### Prérequis réels du parseur (à connaître)

- **GPS (lat/lon) + timestamp** obligatoires par record, sinon le point est ignoré (`fit_parser.rs:215-217`) ; aucun point survivant → `"No valid record points found in FIT file"`. Un FIT home-trainer sans GPS est rejeté, même avec puissance.
- **Champ `speed` (6 / 18) indispensable** : rien ne recalcule la vitesse depuis le GPS — `recompute_distance_if_needed` (`fit_parser.rs:600`) ne traite que la distance. Sans `speed`, bins et KNN se vident → vitesse constante de 5,56 m/s (20 km/h) partout (`speed.rs:26`, `speed.rs:592`).

---

## 3. Données utilisateur : saisie vs usage réel

Source de la saisie : `src/features/itineraryPanel/types.ts:155-195` (`RhythmState`), UI : `sections/RythmeSection.tsx`.
Seul traducteur vers le moteur : `lib/schedule/container-prediction.ts:12-48` (`buildPredictionConfigFromRhythm`).

| Champ saisi | Traduit en | Effet réel |
| :--- | :--- | :--- |
| `systemWeightKg` | `config.mass_kg` | ✅ utilisé (split 88/12, `profile/mod.rs:47-51`) |
| `gender` | `config.gender` | ✅ utilisé (×0,92 si femme, `types.rs:31-36`) |
| `ftp` | `config.ftp_w` | ⚠️ **inerte sans puissance** — voir §4.3 |
| `startTime` / `startDate` | `config.start_time_h` | ✅ circadien (routes > 12 h) |
| `pauseIntervals` / POI | — | ✅ mais **côté TS** (`pauseAwareSchedule.ts`), pas dans le moteur |
| `tiresMm` | — | ❌ **jamais transmis** — n'existe aucune table pneu→Crr |
| `useWeather` / `weatherWeight` | — | ❌ **jamais transmis** — `headwind_ms` / `ambient_temperature_c` restent `None` |
| `useSurfaces` / `surfacesWeight` | — | ❌ **jamais transmis** — `surface_types` reste `None` |
| `usePastActivities` | — | ❌ **purement décoratif** (seul l'export Excel le lit) |
| — (non exposé) | `config.cda` | ❌ **aucun champ UI** pour le CdA |

### Conséquences concrètes

1. **Toutes les routes sont traitées en surface « Unknown »** → pénalité permanente ~4 % et Crr ×1,2 (`prediction/surface.rs:50-57`), alors que l'utilisateur a un toggle Surfaces.
2. **`headwind_ms` est accepté, documenté, et totalement ignoré** : `force_aero_wind` est définie (`math/physics.rs:255`) et **jamais appelée**. Le solveur cubique n'a aucun terme de vent (`physics.rs:47`). Or l'app **possède déjà** la direction du vent (`weather/lib/open-meteo.ts:96,135`) et la température par point (`RouteWeatherDataset`).
3. **La température n'affecte pas la densité de l'air** : `air_density(altitude_m)` (`physics.rs:20`) ignore la température. `ambient_temperature_c` n'alimente que le `thermal_factor` (pénalité physiologique, `prediction/mod.rs:140`).
4. **`config.cda` n'est pas exposé** : le CdA reste figé à 0,35 par défaut (`profile/mod.rs:8`) — c'est le paramètre le plus sensible pour les portions roulantes.

---

## 4. Résultats mesurés (moteur WASM réel)

Protocole : coureur simulé physiquement cohérent (P(t) = FTP × décroissance de fatigue, vitesse = résolution du bilan de puissance, FC corrélée à l'intensité), FIT d'entraînement + FIT de validation hors entraînement, puis exécution du moteur sur le **même** jeu de données.

### 4.1 Scénario 1 — cible dans l'enveloppe (104 km, historique max 120 km)

| Variante | FTP auto | Écart temps |
| :--- | ---: | ---: |
| A. avec puissance | 234 W | +11,5 % |
| B. **sans puissance** | 0 W | **+1,5 %** |
| B2. sans puissance + poids 78 kg | 0 W | +1,8 % |
| B3. sans puissance + FTP 260 W | 260 W | +1,8 % |
| C. sans puissance, KNN inutilisable (bins) | 0 W | +11,6 % |
| D. sans puissance **et sans FC** | 0 W | **+1,0 %** |

### 4.2 Scénario 2 — extrapolation (268 km, historique max 72 km)

| Variante | Écart temps |
| :--- | ---: |
| A. avec puissance | +30,9 % |
| B. sans puissance | +54,3 % |
| B2 / B3. sans puissance + poids / + FTP | +54,6 % |
| C. sans puissance, KNN inutilisable (bins) | **+30,2 %** |
| D. sans puissance **et sans FC** | **+40,6 %** |

### 4.3 Ce que ces chiffres démontrent

1. **Le FTP saisi est totalement inerte sans puissance.** B2 et B3 donnent des temps identiques au dixième près. Cause : `has_power` est dérivé **uniquement des FIT** (`profile/mod.rs:25`), alors que `ftp_w` accepte l'override utilisateur. `has_physics` reste donc faux, et le modèle physique n'est jamais activé. Le FTP s'affiche et le W/kg est calculé — mais il ne pilote rien.
2. **Le poids joue à la marge** (~0,3 pt) car il ne rentre que dans le chemin physique, désactivé.
3. **La FC nuit** : la retirer gagne 14 points sur la cible longue.
4. **Les bins empiriques battent le KNN en extrapolation** (+30,2 % vs +54,3 %) : avec moins de données, le moteur est plus juste, parce que le KNN applique une extrapolation ultra agressive.
5. **La bande d'incertitude n'est pas calibrée** : le moteur annonce ±14 % quand l'erreur réelle atteint +54 %. `uncertainty = 0.05 + 0.10 × (1 − confiance)` (`prediction/mod.rs:166`) avec une confiance KNN mesurée à 0,015–0,19 sur ces cas — la bande ne reflète pas l'extrapolation.

### 4.4 Diagnostic — où part l'erreur (cible 268 km)

Dérive du temps cumulé, variante B (sans puissance) :

| Distance | Réel | Prédit | Ratio | fatigue | distEff | knnConf |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 13 km | 0h26 | 0h28 | 1,07 | 0,994 | 1,000 | 0,188 |
| 67 km | 2h13 | 2h24 | 1,08 | 0,963 | 1,000 | 0,088 |
| 134 km | 4h46 | 5h23 | 1,13 | 0,919 | 1,000 | 0,033 |
| 200 km | 7h19 | 9h16 | 1,27 | 0,867 | 0,993 | 0,028 |
| 267 km | 9h55 | 15h20 | **1,55** | 0,794 | 0,990 | 0,015 |

La dérive s'emballe dans le dernier tiers. Le mécanisme principal est dans la branche « KNN seul » (`speed.rs:552-566`) :

```rust
let ultra_fatigue = if elapsed_h > max_training_h && max_training_h > 0.5 {
    let fatigue_ratio = fatigue_at_now / fatigue_at_max;
    let conf_decay = (-((elapsed_h - max_training_h) / 12.0)).exp();
    (fatigue_ratio * conf_decay).clamp(0.3, 1.0)
```

Au-delà de la durée d'entraînement maximale, la vitesse est **multipliée** par une décroissance exponentielle `exp(−Δt/12)` **en plus** du modèle de fatigue. Double pénalité. Sur 10 h de sortie avec 2 h d'historique : `exp(−8/12) = 0,51` → la vitesse est divisée par deux avant même la fatigue.

À quoi s'ajoute l'empilement des micro-facteurs (`speed.rs:623-636`) : charge de grimpe court et long terme, distance-efficiency, logistique, surface, thermique, glycogène, interaction altitude×pente, D+ cumulé. Le plancher anti-empilement (`speed.rs:73-83`) plafonne à 0,78 sur une route de 268 km — soit **+28 % de temps** à lui seul.

---

## 5. Problèmes identifiés, priorisés

### P0 — corrige la justesse

| # | Problème | Emplacement | Correctif proposé |
| :-: | :--- | :--- | :--- |
| 1 | `has_power` dérivé des FIT seulement → le FTP saisi ne débloque pas le modèle physique | `profile/mod.rs:25`, `speed.rs:198` | `has_power = any(FIT) \|\| config.ftp_w.is_some()` ; découpler « a un capteur » de « a une FTP exploitable » |
| 2 | FC constante à 0,7 à l'inférence, informative à l'entraînement → biais | `knn/mod.rs:196`, `features.rs:279-331` | Option A : retirer la FC de la distance (poids 0) — gain mesuré +14 pts. Option B : la rendre utile en la **prévoyant** (voir P1-8) |
| 3 | Extrapolation ultra : double pénalité `fatigue × exp(−Δt/12)` | `speed.rs:552-566` | Ne conserver que le `fatigue_ratio`, remplacer `conf_decay` par une décroissance bornée vers le plancher de fatigue (`ultra_floor`) |
| 4 | `headwind_ms` accepté et ignoré ; `force_aero_wind` jamais appelée | `types.rs:458`, `physics.rs:255` | Propager le vent dans le solveur (`solve_speed_from_power_with_efficiency` → paramètre `headwind_ms`) |

### P1 — exploite les données déjà disponibles

| # | Chantier | Données déjà présentes |
| :-: | :--- | :--- |
| 5 | **Câbler la météo** : `ambient_temperature_c` par point + vent → `headwind_ms` signé (vent − cap de la trace) | `weather/lib/routeWeather.ts` (température), `open-meteo.ts:96,135` (direction du vent) |
| 6 | **Câbler les surfaces** : construire `surface_types: Vec<u8>` depuis l'OSM/BRouter pour supprimer la pénalité « Unknown » permanente | toggle Surfaces existant |
| 7 | **Pneu → Crr** : table largeur/pression → Crr, alimente `config.crr` | `rhythm.tiresMm` |
| 8 | **Prédire la FC** au lieu de la figer : dériver une FC cible par intensité (`P/FTP` ou VAM) pour rendre la feature KNN discriminante et servir au drift cardiaque | FC présente dans les FIT, jamais exploitée |
| 9 | **Exposer le CdA** (et éventuellement la position) dans l'UI | `config.cda` déjà supporté |

### P2 — robustesse et confiance

| # | Problème | Emplacement |
| :-: | :--- | :--- |
| 10 | Recalculer `speed_ms` depuis distance/temps quand le champ FIT est absent | `fit_parser.rs:600` |
| 11 | Bande d'incertitude non calibrée (annonce ±14 %, erreur réelle +54 %) | `prediction/mod.rs:160-175` |
| 12 | `has_hr` calculé et jamais consommé | `types.rs:145`, `fit_parser.rs:655` |
| 13 | `usePastActivities` décoratif | `RythmeSection.tsx:190` |
| 14 | Mode comparaison `predict_vs_actual` implémenté mais **jamais monté** (`FitPredictionPanel` n'est exporté nulle part) | `lib.rs:172`, `features/fitPredictor/index.ts:1` |

---

## 6. Plan d'action recommandé

**Étape 1 — débloquer la justesse (faible risque, gain immédiat)**
1. P0-1 : découpler `has_power` du FTP utilisateur.
2. P0-2 : neutraliser la feature FC (poids 0) en attendant une vraie prédiction de FC.
3. P0-3 : corriger la double pénalité d'extrapolation.
4. P2-11 : élargir la bande d'incertitude quand `elapsed_h > max_training_h`.

**Étape 2 — exploiter les données déjà saisies**
5. P1-5 (météo) et P1-6 (surfaces) : deux câblages, données déjà présentes côté client.
6. P1-9 (CdA) et P1-7 (pneu→Crr) : deux champs UI à brancher.

**Étape 3 — rendre le résultat explicable**
7. P2-14 : monter un écran de validation s'appuyant sur `predict_vs_actual` pour mesurer la précision sur les vrais FIT de l'utilisateur.
8. Afficher un **avertissement d'extrapolation** : « votre plus longue sortie enregistrée est de 72 km ; la prédiction au-delà est indicative » — c'est le levier le plus efficace pour la confiance utilisateur, et il ne demande aucun changement de modèle.

---

## 7. Protocole de validation à mettre en place

Le moteur expose déjà tout le nécessaire (`predict_vs_actual`, `lib.rs:172`). Recommandation :

1. **Backtest automatique** : à chaque calcul, retenir 1 FIT de l'historique comme validation et entraîner sur les autres, puis comparer temps prédit / temps réel. Afficher le MAPE glissant.
2. **Segmentation par enveloppe** : mesurer l'erreur séparément pour (a) cible ≤ plus longue sortie, (b) cible > 1,5×. Ce sont deux régimes différents (mesuré : +1,5 % vs +54 %).
3. **Jeu de référence** : constituer un jeu de FIT réels anonymisés (avec et sans capteur de puissance, avec et sans FC) et figer les résultats dans `script-test-bench/reports/`.
4. **Non-régression** : brancher `script-test-bench/audit-predictor-nopower.mjs` sur `npm run bench` comme garde-fou.

---

## 8. Limites de cette étude

- Les écarts **absolus** proviennent d'un coureur **simulé** : ils ne constituent pas une mesure de précision en conditions réelles. Le modèle de fatigue du simulateur (FTP → 70 % en 6 h) est une hypothèse.
- En revanche, les **comparaisons entre variantes** (A/B/C/D, balayages) portent sur des jeux de données **strictement identiques** et le **moteur réel** : ces deltas-là sont valides et exploitables.
- Les FIT de test sont synthétiques et l'entraînement et la validation partagent la même distribution de terrain — le KNN y est donc avantagé. Sur des terrains réellement inédits, l'avantage du chemin « sans puissance » sera moindre que mesuré ici.
- La puissance maximale de 5 000 W et les valeurs FIT extrêmes ne sont pas couvertes.

---

## 9. Reproductibilité

```bash
# depuis redview-app/
node script-test-bench/audit-predictor-nopower.mjs
```

Le harnais encode lui-même les FIT (CRC-16 FIT), construit le GPX, simule le coureur et exécute le WASM de production (`src/features/fitPredictor/engine/pkg`). Sortie brute conservée dans `script-test-bench/audit-predictor-nopower-output.txt`.
