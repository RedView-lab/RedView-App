# Contribuer à RedView

[← Dépôt](README.md) · [Index de la documentation](docs/README.md) · [Sécurité](SECURITY.md)

Cette page est le chemin court d'un clone neuf à un changement fusionné dans `main`.
[`CLAUDE.md`](CLAUDE.md) est la référence détaillée : l'architecture, les règles
sur lesquelles repose chaque sous-système, et toutes les commandes.

## 1. Installer

```bash
nvm use               # Node 22 (.nvmrc), la version de l'image de production
npm ci
cp .env.example .env  # valeurs Appwrite, Mapbox et des services amont
npm run dev
```

## 2. Trouver où va le code

| Chemin | Contenu |
|---|---|
| [`src/`](src) | Frontend (React + TypeScript) : un dossier par domaine dans `features/`, le code transverse dans `shared/`, la racine de composition dans `pages/Dashboard/`. Conventions : [`docs/architecture/structure.md`](docs/architecture/structure.md). |
| [`api/`](api) | Gestionnaires de routes HTTP (`api/<nom>.ts` → `/api/<nom>`) ; le code serveur partagé dans `api/_lib/`. |
| [`server/`](server/README.md) | Modules serveur partagés (`lib/`), serveur de co-édition en temps réel (`multiplayer/`), services du VPS et configuration de l'hôte. Point d'entrée de production : [`server.mjs`](server.mjs). |
| [`public/`](public) | Ressources statiques et Service Worker des tuiles (`sw-dem.js` + `sw-dem/`). |
| [`vendor/`](vendor) | Crates Rust compilées en WebAssembly ; leurs sorties sont commitées. |
| [`scripts/`](scripts/README.md) | Outils de build, porte qualité, mise en production et exploitation. |
| [`script-test-bench/`](script-test-bench/README.md) | Bancs de performance, parcours de bout en bout et suites de régression sur données réelles. |
| [`test/`](test) | Tests du code qui ne peut pas héberger les siens (le Service Worker de `public/`). |
| [`docs/`](docs/README.md) | Notes d'architecture, procédures d'exploitation et audits datés. |

## 3. Faire le changement

- **Le code, ses commentaires et la documentation sont en français.** Les
  identifiants restent en anglais, comme les noms de l'écosystème.
- **Les tests sont à côté du code.** `foo.ts` → `foo.test.ts`, avec un
  `import { describe, it, expect } from 'vitest'` explicite. Les tests serveur
  vont dans `server/lib/__tests__/`, les tests d'API dans `api/_lib/__tests__/`.
  Couvrir d'abord les règles métier, les frontières de sécurité, la persistance et
  les calculs de routage.
- **Chaque texte visible par l'utilisateur est traduit.** Ajouter une paire
  `{ fr, en }` dans `src/shared/i18n/config/translations/` ; `npm run check` échoue
  sur un texte sans traduction (`npm run i18n:audit -- --list` pour le détail).
- **Nouvel hôte externe ?** L'ajouter à la Content-Security-Policy de
  [`server/lib/csp.mjs`](server/lib/csp.mjs), sinon le navigateur le bloquera.
- **Modifié quoi que ce soit sous `public/sw-dem*` ?** Ajouter une ligne datée au
  tampon de cache dans l'en-tête de `public/sw-dem.js`.

## 4. Vérifier

| Commande | Quand |
|---|---|
| `npm run check` | Avant chaque commit : types, ESLint, tests unitaires, knip, cycles d'import, traductions (environ une minute à froid, bien moins à chaud) |
| `npm run check:full` | Avant une pull request : ajoute le build de production, le budget du bundle, les serveurs bundlés réellement démarrés, le parcours de bout en bout et les suites de régression. La CI lance la même chose. |
| `npm run bench:<suite>` | Quand un changement touche une zone mesurée : voir [`script-test-bench/`](script-test-bench/README.md) |

La porte est stricte à dessein :

- **Cliquet ESLint.** Les erreurs préexistantes sont figées dans
  `eslint-suppressions.json` et aucune nouvelle erreur ne peut entrer. Corriger les
  erreurs plutôt que les masquer ; après avoir corrigé une erreur figée, lancer
  `npm run lint:prune`.
- **Pas de code mort.** knip échoue sur un fichier, une dépendance ou un export
  inutilisé ; supprimer ce qu'un changement laisse sans usage.
- **Pas de cycle d'import.** madge échoue sur tout cycle à l'exécution dans `src/`.

## 5. Commiter

[Conventional Commits](https://www.conventionalcommits.org/), avec une portée et
un sujet par commit :

```text
fix(chart,map): garder le curseur de survol sur la route après un reroutage
refactor(scripts): regrouper les outils d'exploitation par domaine
docs(readme): relier les cartes de dossiers
```

Plusieurs sessions peuvent partager un même arbre de travail. N'indexer et ne
commiter que ses propres chemins (`git commit -- <chemins>`) ; jamais
`git add .`, `git stash` ni `git checkout .`.

## 6. Livrer

Ouvrir une pull request vers `main` avec le modèle, et attendre la CI.
Le déploiement est une étape distincte et délibérée : `npm run deploy` ne déploie
que le travail commité, après la porte complète et une vérification du schéma de
production. Lire `CLAUDE.md` avant de le lancer, et ne jamais le lancer au sein
d'un changement.
