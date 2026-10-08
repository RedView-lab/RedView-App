# scripts/

[← Dépôt](../README.md) · [Index de la documentation](../docs/README.md)

Outils qui tournent sur un poste de développement ou pendant le build.
L'application ne les importe jamais. Lancer chaque script depuis la racine du
dépôt ; la plupart sont reliés à une commande `npm run` dans
[`package.json`](../package.json). Les scripts qui parlent à la production lisent
leurs identifiants dans `.env`, jamais commité (partir de
[`.env.example`](../.env.example)).

> Les bancs de performance, parcours de bout en bout et suites de régression sont
> dans [`script-test-bench/`](../script-test-bench/README.md), pas ici.

## Les commandes les plus utilisées

```bash
npm run dev          # données i18n de l'API, puis Vite + services locaux + tunnel SSH vers le VPS
npm run check        # porte qualité : types, lint, tests unitaires, knip, cycles d'import, traductions
npm run check:full   # + build de production, serveurs bundlés, régressions hors ligne (lancé par la CI et deploy)
npm run build        # build de production (les erreurs de type le font échouer)
```

`npm run deploy` et `npm run rollback` agissent sur la production. Ils ne se
lancent que délibérément, jamais au sein d'un changement (voir
[Mise en production](#mise-en-production)).

## Dossiers

| Dossier | Contenu | Commandes principales |
|---|---|---|
| [`build/`](build) | Étapes de build : données i18n de l'API, serveurs bundlés (esbuild), précompression des statiques, envoi des sourcemaps à GlitchTip | `npm run build`, `npm run build:server` (les `Dockerfile` les lancent aussi) |
| [`quality/`](quality) | La porte qualité et ses contrôles : budget du bundle de chargement initial, serveurs bundlés réellement démarrés, couverture i18n | `npm run check`, `npm run check:full`, `npm run bundle:check`, `npm run server:check`, `npm run i18n:check` |
| [`release/`](release) | Mise en production (porte + vérification du schéma + push + Coolify) et retour à une image conservée | `npm run deploy`, `npm run rollback` |
| [`dev/`](dev) | Serveurs locaux BRouter, POI et temps réel, et tunnel SSH vers le VPS (`npm run dev` les démarre) | `npm run services`, `npm run services:stop` |
| [`appwrite/`](appwrite) | Opérations sur la base de production : schéma (vérifié par deploy), audits et migrations de permissions, audit de sécurité des projets partagés, suppressions de compte interrompues, comptes de test de co-édition | `node --env-file=.env scripts/appwrite/setup-appwrite-schema.mjs --check` |
| [`analytics/`](analytics) | Rapport d'activation tiré de la base, étiquettes des comptes internes, tableaux et entonnoirs Umami sous forme de code (`umami/`) | `npm run analytics:report`, `npm run analytics:sync` |
| [`billing/`](billing) | Produits Stripe. La facturation est gelée. | — |
| [`vps/`](vps) | Durcissement du VPS, instantanés de performance en lecture seule, vérification du DNS d'e-mail | `bash scripts/vps/perf-snapshot.sh <libellé>` |
| [`routing/`](routing) | Lanceur de scénarios BRouter et sondes de routage (profils piétons, gravel, GT20) | `npx tsx scripts/routing/run-scenarios.ts` |
| [`probes/`](probes) | Diagnostics ponctuels contre les services réels (Open-Meteo, POI, météo, swisstopo, WMS IGN), gardés pour leur méthode | `npm run test:openmeteo:vps` |
| [`lidar-index/`](lidar-index) | Régénère les index de fichiers LiDAR et les polygones de couverture (JP, NZ, NL, BE, FR, CH) | `npm run lidar:index` |
| [`design-workbench/`](design-workbench) | Copie HTML autonome du tableau de bord pour le designer, avec export des modifications | `npm run workbench`, `npm run workbench:verify` |

## Mise en production

`npm run deploy` ne déploie **que le travail commité**. Il s'arrête sur un arbre de
travail modifié. Il lance ensuite `check:full`, compare le schéma Appwrite de
production avec `appwrite/setup-appwrite-schema.mjs`, pousse sur `main` et
déclenche le déploiement Coolify. Si une étape échoue, rien n'est poussé.

`npm run rollback` liste les images que Coolify garde pour chaque commit.
`npm run rollback -- <sha>` relance l'une d'elles. Il ne ramène que le code,
jamais le schéma ni les données.

La procédure complète est dans [`CLAUDE.md`](../CLAUDE.md).

## Ajouter un script

- Le placer dans le dossier de son rôle et le nommer d'après ce qu'il fait (les
  scripts de `probes/` sont des diagnostics, pas des tests lancés par la porte).
- S'il est fait pour être relancé, le relier à une commande `npm run`.
- Lire les secrets dans `.env` ou dans un fichier hors du dépôt, jamais sur la
  ligne de commande ni dans le code.
