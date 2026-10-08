# script-test-bench/

[← Dépôt](../README.md) · [Index de la documentation](../docs/README.md)

Bancs de performance, parcours de bout en bout et suites de régression trop
lourds, trop lents ou trop gourmands en données pour les tests unitaires. Les
tests unitaires sont des fichiers Vitest à côté du code (`foo.ts` →
`foo.test.ts`). Chaque suite se lance depuis la racine du dépôt par une commande
`npm run`, et `npm run typecheck:bench` les vérifie toutes au typage
(`tsconfig.bench.json`).

## Commencer ici

```bash
npm run check:full     # le contrôle lance aussi le parcours utilisateur sur le build de prod et quatre régressions hors ligne
npm run bench:quick    # toutes les suites de performance, avec moins d'itérations
npm run bench:<suite>  # une seule suite, p. ex. bench:pente, bench:flyover, bench:collab
```

## Organisation

| Dossier | Ce qu'il vérifie | Commandes |
|---|---|---|
| `run-all-benchmarks.ts`, [`core/`](core), [`suites/`](suites) | Suites de performance par domaine (météo, pentes, altitude, neige, profils BRouter, moteur d'allure, LiDAR, POI, exports, séries du graphique, serveur, survol 3D), avec seuils. Chaque exécution est comparée au rapport précédent et à l'état de la machine. | `npm run bench`, `npm run bench:quick`, `npm run bench:<suite>` |
| [`regression/`](regression) | Régressions de justesse hors ligne sur les vrais chemins de code : fichiers `.redview`, couches du projet, simulateur de co-édition, tri automatique des POI, altitude des routes | `bench:redview`, `bench:project-layers`, `bench:collab` (tous trois dans `check:full`), `bench:poi-autosort` |
| [`flyover/`](flyover), [`follow/`](follow) | Caméra du survol 3D de la route ; restitution du suivi en présence en direct, en pur et rejouée image par image dans un navigateur virtuel | `bench:flyover`, `bench:follow`, `bench:follow-frames` |
| [`avalanche/`](avalanche), [`lidar-lod/`](lidar-lod), [`snow-quality/`](snow-quality) | Analyses et niveau de détail du visualiseur LiDAR ; le moteur de hauteur de neige face aux contrôles physiques et au moteur v1 figé | `bench:avalanche`, `bench:lidar-lod`, `bench:snow` |
| [`pace-accuracy/`](pace-accuracy) | Moteur de temps en mouvement face à de vraies sorties FIT, à des scénarios physiques synthétiques et à des références publiques | `bench:pace`, `bench:pace:prep`, `bench:pace:realism` |
| [`routing-quality/`](routing-quality), [`route-continuity/`](route-continuity) | Environ 660 scénarios de routage contre le BRouter de production, et la règle selon laquelle un tracé enregistré ne contient jamais de ligne droite | `bench:routing`, `bench:routing:sweep`, `bench:routing:compare`, `bench:routing:report` |
| [`collab-load/`](collab-load), [`collab-e2e/`](collab-e2e) | Serveur temps réel sous charge et à travers les redémarrages ; parcours à deux utilisateurs dans un vrai navigateur, sur le serveur de dev ou avec les comptes de test de production | `bench:collab-load`, `bench:collab-e2e`, `bench:collab-prod` |
| [`user-journey/`](user-journey), [`dashboard-perf/`](dashboard-perf), [`screen-audit/`](screen-audit) | Build de production dans un navigateur sans interface face à un Appwrite en mémoire : le parcours utilisateur principal ; chargement, fluidité et fuites sur réseaux bridés ; mise en page sur 15 tailles d'écran | `e2e:journey`, `bench:dashboard`, `bench:screens` |
| [`lidar-viewer-engines/`](lidar-viewer-engines), [`lidar-viewer-perf/`](lidar-viewer-perf), [`lidar-viewer-shots/`](lidar-viewer-shots) | Visualiseur LiDAR en WebGPU et WebGL 2 dans Chromium, Firefox et WebKit ; fréquence d'images ; captures à vue fixe | `bench:lidar-engines`, `bench:lidar-fps`, `bench:lidar-shots` |
| [`audit/`](audit) | Scripts de reproduction des audits datés. Chacun sort en erreur tant que son bogue se reproduit. Voir [`docs/audits/`](../docs/audits). | `npx tsx script-test-bench/audit/<fichier>` |
| [`poi-external/`](poi-external) | Étude de données pour compléter la base de POI à partir de sources externes (Overture, ATP, SIRENE) | Voir [l'étude](../docs/audits/2026-09-23-poi-external-sources.md) |

[`CLAUDE.md`](../CLAUDE.md) décrit ce que mesure chaque suite, ses seuils et ses
derniers chiffres de référence.

## Données hors du dépôt

Les suites ne lisent jamais de données réelles dans le dépôt, ni depuis un chemin
personnel écrit dans le code.

| Variable | Sert à | Par défaut |
|---|---|---|
| `REDVIEW_BENCH_DATA` | Un seul dossier pour toutes les entrées non versionnées : routes GPX de référence, sorties FIT, exports ([`core/data-paths.ts`](core/data-paths.ts)) | votre dossier `Téléchargements` |
| `PACE_FIT_DIR`, `AUDIT_GPX_DIR`, `PACE_GT20`, `PACE_VICTOR_DIR` | Remplacer une entrée d'une suite donnée. Elles priment sur `REDVIEW_BENCH_DATA`. | — |
| `POI_STUDY_DIR` | Fichiers intermédiaires de l'étude POI ([`poi-external/paths.py`](poi-external/paths.py)) | un dossier du répertoire temporaire du système |

Les suites qui ont besoin d'identifiants de production (comptes de test, tunnel
SSH vers le VPS) le disent dans leur en-tête et les lisent hors du dépôt.

## Rapports

Les exécutions écrivent leurs rapports dans `script-test-bench/reports/`, ignoré
par git. Les résultats de référence à conserver sont archivés dans
[`docs/operations/server-perf/`](../docs/operations/server-perf) et
[`docs/audits/data/`](../docs/audits/data).

## Conventions

- Une suite sort avec un code non nul sur une régression. Avant qu'un seuil soit
  compté comme franchi, il est remesuré une fois.
- Chaque suite de `suites/` exporte une fonction `run…Benchmark()`.
  `run-all-benchmarks.ts` l'appelle, et elle peut aussi tourner seule
  (`npm run bench:<suite>`).
- Les temps pris sur un portable sur batterie sont du bruit. Comparer des
  exécutions A/B entrelacées.
