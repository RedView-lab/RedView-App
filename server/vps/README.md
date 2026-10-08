# Configuration du VPS (141.145.220.99)

Fichiers posés sur l'hôte, versionnés ici pour que l'état du serveur soit
reproductible. Le VPS est une instance Oracle Ampere A1 **Always Free**
(4 vCPU, 22,4 Go de RAM, 83 Go de disque) qui porte tout : BRouter, POI,
ingest météo, nginx, Coolify (app, temps réel, site vitrine), Appwrite +
MariaDB, GlitchTip, Umami, Beszel.

| Fichier | Destination | Appliquer |
|---|---|---|
| `brouter.service` | `/etc/systemd/system/brouter.service` | `daemon-reload` puis `restart brouter` (routage coupé ~40 s) |
| `journald@brouter.conf` | `/etc/systemd/journald@brouter.conf` | avant le redémarrage de BRouter (le journal `brouter` démarre avec lui) ; lecture : `journalctl --namespace=brouter -u brouter` |
| `poi-server-resources.conf` | `/etc/systemd/system/poi-server.service.d/resources.conf` | `daemon-reload` (limite appliquée à chaud) |
| `sysctl-90-redview.conf` | `/etc/sysctl.d/90-redview.conf` | `sysctl -p /etc/sysctl.d/90-redview.conf` |
| `journald-90-redview.conf` | `/etc/systemd/journald.conf.d/90-redview.conf` | `mkdir -p /var/log/journal`, `restart systemd-journald`, `journalctl --flush` |
| `docker-daemon.json` | `/etc/docker/daemon.json` | `live-restore` d'abord (`kill -HUP` de dockerd), puis `restart docker` : les conteneurs continuent de tourner |
| `appwrite/docker-compose.override.yml` | `/opt/appwrite/docker-compose.override.yml` | `docker compose config` (vérification à sec), `docker compose stop -t 120 mariadb`, `docker compose up -d` |
| `umami/docker-compose.yml` (+ `.env` du VPS, modèle `umami/.env.example`) | `/home/opc/services/umami/` | `pg_dump` (umami-db), `docker compose pull && docker compose up -d` (migrations au démarrage) ; retour : remettre l'ancien compose, `up -d`, recharger le dump si besoin. Plan de mesure : `docs/analytics/measurement.md` |
| `umami/retention.sql` + `umami/systemd/redview-umami-retention.{service,timer}` | `/usr/local/share/redview-umami/retention.sql`, `/etc/systemd/system/` | `install` + `restorecon`, `daemon-reload`, `enable --now redview-umami-retention.timer` (le 1er du mois, purge > 25 mois) |
| `nginx-stats.conf` | zone en tête de `/etc/nginx/conf.d/app.conf`, `location`s dans le bloc `server` de app.redview.tech | `nginx -t` puis `systemctl reload nginx` ; tracker first-party `/s/x.js` + `/s/api/send` |
| `nginx-analytics.conf` | `/etc/nginx/conf.d/analytics.conf` (fichier entier) | `install` + `restorecon`, `nginx -t` puis `systemctl reload nginx` ; connexion à Umami limitée à 5/min par IP (pas de 2FA ni de verrouillage dans Umami) |
| `nginx-multiplayer.conf` | zones en tête de `/etc/nginx/conf.d/app.conf`, `location`s dans le bloc `server` de app.redview.tech (remplacent `location /multiplayer`) | `nginx -t` puis `systemctl reload nginx` (connexions en cours gardées) |
| `open-meteo/docker-compose.yml` | `/opt/open-meteo/docker-compose.yml` (`install -D` + `restorecon`) ; route `location /openmeteo/` de `server/weather-daemon/brouter.conf` dans `/etc/nginx/conf.d/brouter.conf` | `docker compose -f /opt/open-meteo/docker-compose.yml up -d` ; nginx : `nginx -t` puis `systemctl reload nginx` |

L'unité de l'ingest météo reste dans `server/weather-daemon/`.

**Open-Meteo** (`open-meteo/`, installé le 07/10/2026) : seule source des
prévisions par point et de l'historique météo de l'app — jamais l'API publique
(licence non commerciale). Périmètre : France et pays limitrophes, J+4,
≤ 5 Go. Modèles Météo-France synchronisés en local (AROME 0,025° 51 h,
ARPEGE Europe 4 jours, 62 jours d'historique pour le modèle de neige),
~1,9 Go ; `--execute` supprime les fichiers sortis de la fenêtre. L'app y
accède par `OPENMETEO_UPSTREAM=http://141.145.220.99/openmeteo` (variable
Coolify de l'app, nginx réservé au local). Vérifier :

```bash
curl -s 'http://141.145.220.99/openmeteo/v1/forecast?latitude=45.92&longitude=6.87&hourly=temperature_2m&forecast_days=4&models=meteofrance_seamless' | head -c 300
sudo du -sh /var/lib/docker/volumes/open-meteo_open-meteo-data/_data   # ≤ 5 Go
sudo docker logs --tail 5 open-meteo-sync-arpege-history
```

Ajouter une variable : l'ajouter à la synchro du bon modèle (une variable
d'un modèle n'est synchronisée qu'une fois : deux `--past-days` différents se
supprimeraient leurs fichiers), `up -d`, vérifier la taille. Retour
arrière : `docker compose down` (garder le volume) et retirer la variable
Coolify — l'app répond alors 503 sur la météo par point.

**Sauvegardes et reprise après sinistre** : `backup/` (restic chiffré vers
Google Drive chaque nuit, exercice de restauration chaque semaine, alertes
par e-mail, runbook pour reconstruire sur un serveur neuf). Voir
`backup/README.md`.

**Surveillance du service** : `watch/` (timer toutes les 5 min : app, temps
réel, routage, météo et sa fraîcheur, POI, Appwrite, Umami, GlitchTip, TLS,
conteneurs `unhealthy`, âge des sauvegardes, disque, plancher mémoire ; e-mail
« PANNE » après 2 échecs d'affilée, rappel 6 h, « Rétabli » ; ping
`HEARTBEAT_URL` pour qu'un VPS arrêté soit vu de l'extérieur). Voir
`watch/README.md`.

Toujours : sauvegarde horodatée de la cible (`<fichier>.bak-<date>`), application,
vérification, et commande de rollback prête (remettre la sauvegarde, recharger).
**`systemctl daemon-reload` applique tout de suite les nouvelles limites
(`MemoryMax`…) au processus en cours** : une limite sous sa consommation
actuelle le fait tuer par le noyau.

## Mesurer

```bash
bash scripts/vps/perf-snapshot.sh <libellé> [--with-db] [--with-weather]
```

Lecture seule ; écrit `script-test-bench/reports/server-perf/snapshot-<date>-<libellé>.md` (sortie non versionnée ; les instantanés de référence sont archivés dans `docs/operations/server-perf/`)
(mémoire, swap, processus, conteneurs, tas Java et latence de BRouter sur 24 h,
mesures du temps réel, disque, tables MariaDB). À lancer avant et après chaque réglage.

## Plancher mémoire Always Free

Oracle récupère une instance A1 Always Free si, sur 7 jours, le CPU (p95), le
réseau **et la mémoire** restent tous sous 20 %. Le CPU et le réseau sont bas en
permanence : **la mémoire est le seul critère qui garde l'instance**. Il faut
rester au-dessus de 25 % de RAM utilisée, et réinvestir la RAM libérée dans
des caches utiles (tas BRouter fixe pré-touché, buffer pool MariaDB) plutôt
que de la laisser dormir. À surveiller : métrique `MemoryUtilization` de la
console OCI (alarme p95 < 25 % sur 24 h).

## Réglages et raisons (mesures du 2026-10-05)

- **BRouter** : tas de 16 Go (pré-touché) ramené à **3 Go**. L'old gen ne
  contenait que 10,6 Mo ; BRouter plafonne chaque calcul à 128 Mo
  (`memoryclass`) ; 4 threads. Les 16 Go envoyaient les autres services au
  swap (5 Go pleins). Après : RSS 3,3 Go, swap vide, pauses GC de 9 à 15 ms.
  `MemoryMax=6G`, parce que le page cache des segments (1,8 Go) est compté dans
  le cgroup du service.
- **Swap** : `vm.swappiness=10`, swapfile de 5 Go gardé comme filet.
- **journald** : sans `/var/log/journal`, le journal vivait dans `/run`
  (tmpfs, donc en RAM) : 458 Mo. Passage sur disque, borné à 300 Mo.
  BRouter journalise chaque requête avec ses coordonnées : journal à part
  (`LogNamespace=brouter`), gardé 48 h au lieu de 30 jours.
- **Docker** : cache de build BuildKit borné à 8 Go (11,6 Go purgés), et
  `live-restore` pour redémarrer dockerd sans couper les conteneurs.
- **Appwrite** : services inutilisés coupés (Assistant, builds, planificateurs
  Functions/Messaging, Messaging, Migrations). Buffer pool MariaDB porté de
  128 Mo à 2 Go, `O_DIRECT`. `_APP_WORKER_PER_CORE=2` dans `/opt/appwrite/.env`
  (6 par défaut : 24 workers HTTP).
- **POI** : base lue par mmap (`server/poi-server/db.js`), `MemoryMax=1G`.
- **Ingest météo** : priorité basse (`Nice`, `CPUWeight`, `IOWeight`), `MemoryMax=3G`.
- **PCP** (pmcd, pmlogger, pmie) : doublon de Beszel, à désactiver
  (`systemctl disable --now pmcd pmie pmlogger`).
