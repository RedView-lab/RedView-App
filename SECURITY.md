# Politique de sécurité

[← Dépôt](README.md) · [Contribuer](CONTRIBUTING.md) · [Index de la documentation](docs/README.md)

## Signaler une vulnérabilité

Merci de signaler les problèmes de sécurité **en privé** via les
[GitHub Security Advisories](https://github.com/RedView-lab/RedView-App/security/advisories/new),
pas dans une issue publique.

Indiquer :

- le composant concerné (application, API, serveur temps réel, service du VPS) ;
- les étapes pour reproduire ;
- l'impact observé.

## Comment le code est protégé

| Domaine | Où il se trouve |
|---|---|
| Droits sur les projets partagés, toujours vérifiés côté serveur ; les attributs écrits par le client ne font jamais foi | [`server/lib/project-access.mjs`](server/lib/project-access.mjs) |
| Content-Security-Policy de chaque page et script de worker (sans `unsafe-eval`) | [`server/lib/csp.mjs`](server/lib/csp.mjs) |
| Durcissement des requêtes partagé par les adaptateurs de développement et de production : normalisation des chemins, limites de corps, clés de limitation de débit, listes blanches des services amont | [`server/lib/http-security.mjs`](server/lib/http-security.mjs) |
| Erreurs envoyées à GlitchTip avec URL, en-têtes et corps nettoyés | [`server/lib/observability.mjs`](server/lib/observability.mjs), `src/shared/lib/errorReportScrub.ts` |
| Aucun secret dans l'historique git : gitleaks sur tous les commits, en CI | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |

## Pour aller plus loin

- Mise en place du durcissement d'octobre 2026 :
  [`docs/operations/security-runbook.md`](docs/operations/security-runbook.md)
- Modèle de menace de la co-édition en temps réel : section 14 de
  [`docs/architecture/collab-realtime.txt`](docs/architecture/collab-realtime.txt)
