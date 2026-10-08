# Documentation de RedView

[← Dépôt](../README.md) · [Contribuer](../CONTRIBUTING.md) · [Sécurité](../SECURITY.md)

Tout ce qui est écrit sur RedView au-delà du code, au même endroit. La référence
technique du quotidien (commandes, architecture, règles sur lesquelles repose
chaque sous-système) est [`CLAUDE.md`](../CLAUDE.md) à la racine du dépôt. Les
documents ci-dessous approfondissent un sujet.

## Par où commencer

| Vous voulez… | Lire |
|---|---|
| Vous repérer dans le code | [Structure de `src/`](architecture/structure.md), puis les cartes de dossiers : [`server/`](../server/README.md) · [`scripts/`](../scripts/README.md) · [`script-test-bench/`](../script-test-bench/README.md) |
| Comprendre le produit et ses moteurs | [Vue d'ensemble du produit et des moteurs](architecture/overview.md) |
| Travailler sur le routage | [Architecture du routage](architecture/routing.md) |
| Travailler sur la co-édition, les commentaires ou la présence en direct | [Co-édition en temps réel](architecture/collab-realtime.txt) |
| Exploiter la production | [Configuration de l'hôte du VPS](../server/vps/README.md) · [Sauvegardes et reprise après sinistre](../server/vps/backup/README.md) · [Surveillance des services](../server/vps/watch/README.md) |
| Lire les statistiques du produit | [Guide des statistiques](analytics/stats-guide.md) (sans jargon) |

## Architecture — [`architecture/`](architecture)

| Document | Contenu |
|---|---|
| [structure.md](architecture/structure.md) | Où va un fichier dans `src/` : les rôles de `shared/`, la forme d'une feature, les sous-domaines, les barrels et les cycles d'import |
| [overview.md](architecture/overview.md) | Le produit et ses moteurs : physique, météo, neige, LiDAR |
| [routing.md](architecture/routing.md) | La pile de routage : BRouter, profils BRF produits, services du VPS |
| [collab-realtime.txt](architecture/collab-realtime.txt) | Co-édition en temps réel et présence en direct : modèle, règles de modification, sécurité (section 14), tests — texte brut à mise en page alignée |

## Exploitation — [`operations/`](operations)

| Document | Contenu |
|---|---|
| [security-runbook.md](operations/security-runbook.md) | Ordre de mise en place du durcissement de sécurité d'octobre 2026 |
| [appwrite-sdk.md](operations/appwrite-sdk.md) | SDK Appwrite épinglés sur la série du serveur de prod (1.6) : versions, vérifications contre la prod, risques |
| [licences.md](operations/licences.md) + [sbom/](operations/sbom) | Licences des dépendances livrées (serveur, navigateur) et SBOM CycloneDX 1.5, produits par `npm run sbom` après un build |
| [server-perf/](operations/server-perf) | Instantanés de performance de référence du VPS, pris avant et après chaque réglage (`bash scripts/vps/perf-snapshot.sh <libellé>`) |
| [Configuration de l'hôte du VPS](../server/vps/README.md) | Où va chaque fichier de l'hôte, comment appliquer et revenir en arrière, le plancher mémoire Always Free |
| [Sauvegardes](../server/vps/backup/README.md) | Sauvegardes chiffrées nocturnes (restic), exercice de restauration hebdomadaire, reprise après sinistre |
| [Surveillance des services](../server/vps/watch/README.md) | Contrôles lancés toutes les 5 minutes par les URL publiques, règles d'alerte |

## Statistiques — [`analytics/`](analytics)

| Document | Contenu |
|---|---|
| [stats-guide.md](analytics/stats-guide.md) | Guide des statistiques en langage simple pour toute l'équipe : où regarder, glossaire, les questions à se poser chaque semaine |
| [measurement.md](analytics/measurement.md) | Référence technique : Umami anonyme, servi depuis notre propre domaine, + rapports issus de la base, règles de confidentialité, dictionnaire des événements, entonnoirs, tableaux de bord |

## Audits datés — [`audits/`](audits)

Études ponctuelles, gardées pour leur méthode et leurs mesures. Le code a pu
changer depuis ; les noms de fichiers commencent par la date de l'audit. Les
sorties brutes auxquelles ils renvoient sont dans [`audits/data/`](audits/data).

| Date | Document |
|---|---|
| 2026-09-22 | [Audit et reconstruction de la base de POI](audits/2026-09-22-poi-database.md) |
| 2026-09-22 | [Usage des données du cycliste dans le moteur d'allure](audits/2026-09-22-prediction-data.md) |
| 2026-09-23 | [Compléter la base de POI avec quatre sources externes](audits/2026-09-23-poi-external-sources.md) |
| 2026-10-01 | [Audit avant lancement : parcours de l'utilisateur connecté](audits/2026-10-01-launch.md) |
| 2026-10-08 | [Conformité France / UE : RGPD, traceurs, mentions légales, DSA, accessibilité](audits/2026-10-08-conformite-fr-ue.md) |

## Écrire un nouveau document

- En français, comme le reste du dépôt.
- Le placer dans le dossier de son sujet : `architecture/`, `operations/` ou
  `analytics/`. Une étude ponctuelle va dans `audits/` sous le nom `AAAA-MM-JJ-<sujet>.md`.
- Noms de fichiers en minuscules, avec des tirets, sans préfixe `REDVIEW_`.
- Ajouter une ligne à cet index.
- Liens relatifs, en vérifiant qu'ils aboutissent.
- Si le document change une règle sur laquelle le code repose, mettre à jour
  `CLAUDE.md` dans le même commit.
