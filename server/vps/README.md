# Configuration du VPS

[← server/](../README.md) · [Index de la documentation](../../docs/README.md) · [Sauvegardes](backup/README.md) · [Surveillance](watch/README.md)

Fichiers posés sur l'hôte de production, versionnés ici pour que l'état du
serveur soit reproductible.

Le VPS (`141.145.220.99`) est une instance Oracle Ampere A1 **Always Free**
(4 vCPU, 22,4 Go de RAM, 83 Go de disque). Elle porte tout :
- BRouter, POI et l'ingest météo ;
- nginx ;
- Coolify (app, temps réel, site vitrine) ;
- Appwrite + MariaDB ;
- GlitchTip, Umami et Beszel.

## Règle pour chaque changement

Pour chaque changement, dans l'ordre :

1. Faire une **sauvegarde horodatée de la cible** (`<fichier>.bak-<date>`).
2. Appliquer le changement.
3. Vérifier qu'il a pris effet.
4. Garder **la commande de retour arrière prête** : remettre la sauvegarde, puis recharger.

> ⚠️ **`systemctl daemon-reload` applique tout de suite les nouvelles limites
> (`MemoryMax`…) au processus en cours.** Une limite plus basse que sa
> consommation actuelle le fait tuer par le noyau.

Les fichiers installés sur l'hôte gardent leur contexte SELinux : toujours
`install` + `restorecon`, jamais un `cp` ou un `mv` depuis `/tmp`.

## Fichiers versionnés

| Fichier | Destination sur l'hôte | Appliquer |
|---|---|---|
| [`brouter.service`](brouter.service) | `/etc/systemd/system/brouter.service` | `daemon-reload` puis `restart brouter` (routage coupé ~40 s) |
| [`journald@brouter.conf`](journald@brouter.conf) | `/etc/systemd/journald@brouter.conf` | Avant le redémarrage de BRouter (le journal `brouter` démarre avec lui). Lecture : `journalctl --namespace=brouter -u brouter` |
| [`poi-server-resources.conf`](poi-server-resources.conf) | `/etc/systemd/system/poi-server.service.d/resources.conf` | `daemon-reload` (limite appliquée à chaud) |
| [`sysctl-90-redview.conf`](sysctl-90-redview.conf) | `/etc/sysctl.d/90-redview.conf` | `sysctl -p /etc/sysctl.d/90-redview.conf` |
| [`journald-90-redview.conf`](journald-90-redview.conf) | `/etc/systemd/journald.conf.d/90-redview.conf` | `mkdir -p /var/log/journal`, `restart systemd-journald`, `journalctl --flush` |
| [`docker-daemon.json`](docker-daemon.json) | `/etc/docker/daemon.json` | `live-restore` d'abord (`kill -HUP` de dockerd), puis `restart docker` : les conteneurs continuent de tourner |
| [`appwrite/docker-compose.override.yml`](appwrite/docker-compose.override.yml) | `/opt/appwrite/docker-compose.override.yml` | `docker compose config` (vérification à sec), `docker compose stop -t 120 mariadb`, `docker compose up -d` |
| [`umami/docker-compose.yml`](umami/docker-compose.yml) (+ `.env` du VPS, modèle [`umami/.env.example`](umami/.env.example)) | `/home/opc/services/umami/` | `pg_dump` (umami-db), puis `docker compose pull && docker compose up -d` (migrations au démarrage). Retour : remettre l'ancien compose, `up -d`, recharger le dump si besoin. Plan de mesure : [`docs/analytics/measurement.md`](../../docs/analytics/measurement.md) |
| [`umami/retention.sql`](umami/retention.sql) + [`umami/systemd/`](umami/systemd) | `/usr/local/share/redview-umami/retention.sql`, `/etc/systemd/system/` | `install` + `restorecon`, `daemon-reload`, `enable --now redview-umami-retention.timer` (le 1er du mois, purge au-delà de 25 mois) |
| [`nginx-stats.conf`](nginx-stats.conf) | Zone en tête de `/etc/nginx/conf.d/app.conf`, `location`s dans le bloc `server` de app.redview.tech | `nginx -t` puis `systemctl reload nginx`. Tracker first-party `/s/x.js` + `/s/api/send` |
| [`nginx-analytics.conf`](nginx-analytics.conf) | `/etc/nginx/conf.d/analytics.conf` (fichier entier) | `install` + `restorecon`, `nginx -t` puis `systemctl reload nginx`. Connexion à Umami limitée à 5/min par IP (Umami n'a ni 2FA ni verrouillage) |
| [`nginx-multiplayer.conf`](nginx-multiplayer.conf) | Zones en tête de `/etc/nginx/conf.d/app.conf`, `location`s dans le bloc `server` de app.redview.tech (remplacent `location /multiplayer`) | `nginx -t` puis `systemctl reload nginx` (connexions en cours gardées) |
| [`open-meteo/docker-compose.yml`](open-meteo/docker-compose.yml) | `/opt/open-meteo/docker-compose.yml` (`install -D` + `restorecon`). Route `location /openmeteo/` de [`server/weather-daemon/brouter.conf`](../weather-daemon/brouter.conf) dans `/etc/nginx/conf.d/brouter.conf` | `docker compose -f /opt/open-meteo/docker-compose.yml up -d` ; nginx : `nginx -t` puis `systemctl reload nginx` |

L'unité de l'ingest météo reste dans [`server/weather-daemon/`](../weather-daemon).

## Services décrits ailleurs

| Dossier | Rôle |
|---|---|
| [`backup/`](backup/README.md) | Sauvegarde restic chiffrée vers Google Drive chaque nuit, exercice de restauration chaque semaine, alertes par e-mail, runbook pour reconstruire sur un serveur neuf |
| [`watch/`](watch/README.md) | Surveillance du service rendu toutes les 5 min. Vérifie l'app, le temps réel, le routage, la météo et sa fraîcheur, les POI, Appwrite, Umami, GlitchTip, TLS, les conteneurs `unhealthy`, l'âge des sauvegardes, le disque et le plancher mémoire. Après 2 échecs d'affilée, e-mail « PANNE », rappel toutes les 6 h, puis « Rétabli ». Un ping `HEARTBEAT_URL` permet de voir de l'extérieur un VPS arrêté |

## Open-Meteo auto-hébergé

Installé le 07/10/2026 ([`open-meteo/`](open-meteo)). C'est la **seule source**
des prévisions par point et de l'historique météo de l'app. On n'utilise
jamais l'API publique, qui est sous licence non commerciale.

- **Périmètre** : France et pays limitrophes, J+4, ≤ 5 Go.
- **Modèles Météo-France synchronisés en local**, ~1,9 Go au total :
  - AROME 0,025° sur 51 h ;
  - ARPEGE Europe sur 4 jours ;
  - 62 jours d'historique pour le modèle de neige.
- `--execute` supprime les fichiers sortis de la fenêtre.
- **Accès de l'app** : `OPENMETEO_UPSTREAM=http://141.145.220.99/openmeteo`.
  C'est une variable Coolify de l'app ; nginx réserve cette route au local.

Vérifier :

```bash
curl -s 'http://141.145.220.99/openmeteo/v1/forecast?latitude=45.92&longitude=6.87&hourly=temperature_2m&forecast_days=4&models=meteofrance_seamless' | head -c 300
sudo du -sh /var/lib/docker/volumes/open-meteo_open-meteo-data/_data   # ≤ 5 Go
sudo docker logs --tail 5 open-meteo-sync-arpege-history
```

- **Ajouter une variable** :
  1. L'ajouter à la synchro du bon modèle. Une variable d'un modèle n'est
     synchronisée qu'une fois : deux `--past-days` différents se
     supprimeraient leurs fichiers.
  2. `up -d`.
  3. Vérifier la taille.
- **Retour arrière** : `docker compose down` (garder le volume), puis retirer
  la variable Coolify. L'app répond alors 503 sur la météo par point.

## Mesurer

```bash
bash scripts/vps/perf-snapshot.sh <libellé> [--with-db] [--with-weather]
```

La commande est en lecture seule. Elle relève :
- la mémoire, le swap, les processus et les conteneurs ;
- le tas Java et la latence de BRouter sur 24 h ;
- les mesures du temps réel ;
- le disque et les tables MariaDB.

Le rapport s'écrit dans `script-test-bench/reports/server-perf/snapshot-<date>-<libellé>.md`.
Cette sortie n'est pas versionnée. Les instantanés de référence sont archivés
dans [`docs/operations/server-perf/`](../../docs/operations/server-perf). À
lancer avant et après chaque réglage.

## Plancher mémoire Always Free

Oracle récupère une instance A1 Always Free si, sur 7 jours, trois mesures
restent toutes sous 20 % : le CPU (p95), le réseau **et la mémoire**.

Le CPU et le réseau sont bas en permanence, donc **la mémoire est le seul
critère qui garde l'instance**. Il faut rester au-dessus de 25 % de RAM
utilisée. La RAM libérée doit servir à des caches utiles (tas BRouter fixe
pré-touché, buffer pool MariaDB) plutôt que de rester inutilisée.

À surveiller : la métrique `MemoryUtilization` de la console OCI (alarme
p95 < 25 % sur 24 h). Le timer de [`watch/`](watch/README.md) vérifie aussi
ce plancher.

## Réglages et raisons (mesures du 2026-10-05)

| Composant | Réglage | Pourquoi |
|---|---|---|
| **BRouter** | Tas ramené de 16 Go (pré-touché) à **3 Go**, 4 threads, `MemoryMax=6G` | L'old gen ne contenait que 10,6 Mo, et BRouter plafonne chaque calcul à 128 Mo (`memoryclass`). Les 16 Go envoyaient les autres services au swap (5 Go pleins). Après : RSS 3,3 Go, swap vide, pauses GC de 9 à 15 ms. `MemoryMax=6G` parce que le page cache des segments (1,8 Go) est compté dans le cgroup du service. |
| **Swap** | `vm.swappiness=10`, swapfile de 5 Go gardé | Filet de sécurité |
| **journald** | Journal sur disque, borné à 300 Mo ; journal BRouter à part (`LogNamespace=brouter`), gardé 48 h au lieu de 30 jours | Sans `/var/log/journal`, le journal vivait dans `/run` (tmpfs, donc en RAM) : 458 Mo. BRouter journalise chaque requête avec ses coordonnées. |
| **Docker** | Cache de build BuildKit borné à 8 Go, `live-restore` | 11,6 Go purgés ; redémarrer dockerd sans couper les conteneurs |
| **Appwrite** | Services inutilisés coupés (Assistant, builds, planificateurs Functions/Messaging, Messaging, Migrations). Buffer pool MariaDB de 128 Mo à 2 Go, `O_DIRECT`. `_APP_WORKER_PER_CORE=2` dans `/opt/appwrite/.env` | Le défaut, 6, donnait 24 workers HTTP |
| **POI** | Base lue par mmap ([`server/poi-server/db.js`](../poi-server/db.js)), `MemoryMax=1G` | — |
| **Ingest météo** | Priorité basse (`Nice`, `CPUWeight`, `IOWeight`), `MemoryMax=3G` | — |
| **PCP** (pmcd, pmlogger, pmie) | À désactiver : `systemctl disable --now pmcd pmie pmlogger` | Doublon de Beszel |
