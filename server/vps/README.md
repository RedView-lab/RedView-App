# Configuration du VPS (141.145.220.99)

Fichiers posés sur l'hôte, versionnés ici pour que l'état du serveur soit
reproductible. Le VPS est une instance Oracle Ampere A1 **Always Free**
(4 vCPU, 22,4 Go de RAM, 83 Go de disque) qui porte tout : BRouter, POI,
ingest météo, nginx, Coolify (app, temps réel, site vitrine), Appwrite +
MariaDB, GlitchTip, Umami, Beszel.

| Fichier | Destination | Appliquer |
|---|---|---|
| `brouter.service` | `/etc/systemd/system/brouter.service` | `daemon-reload` puis `restart brouter` (routage coupé ~40 s) |
| `poi-server-resources.conf` | `/etc/systemd/system/poi-server.service.d/resources.conf` | `daemon-reload` (limite appliquée à chaud) |
| `sysctl-90-redview.conf` | `/etc/sysctl.d/90-redview.conf` | `sysctl -p /etc/sysctl.d/90-redview.conf` |
| `journald-90-redview.conf` | `/etc/systemd/journald.conf.d/90-redview.conf` | `mkdir -p /var/log/journal`, `restart systemd-journald`, `journalctl --flush` |
| `docker-daemon.json` | `/etc/docker/daemon.json` | `live-restore` d'abord (`kill -HUP` de dockerd), puis `restart docker` : les conteneurs continuent de tourner |
| `appwrite/docker-compose.override.yml` | `/opt/appwrite/docker-compose.override.yml` | `docker compose config` (vérification à sec), `docker compose stop -t 120 mariadb`, `docker compose up -d` |
| `nginx-multiplayer.conf` | zones en tête de `/etc/nginx/conf.d/app.conf`, `location`s dans le bloc `server` de app.redview.tech (remplacent `location /multiplayer`) | `nginx -t` puis `systemctl reload nginx` (connexions en cours gardées) |

L'unité de l'ingest météo reste dans `server/weather-daemon/`.

Toujours : sauvegarde horodatée de la cible (`<fichier>.bak-<date>`), application,
vérification, et commande de rollback prête (remettre la sauvegarde, recharger).
**`systemctl daemon-reload` applique tout de suite les nouvelles limites
(`MemoryMax`…) au processus en cours** : une limite sous sa consommation
actuelle le fait tuer par le noyau.

## Mesurer

```bash
bash scripts/vps-perf-snapshot.sh <libellé> [--with-db] [--with-weather]
```

Lecture seule ; écrit `script-test-bench/reports/server-perf/snapshot-<date>-<libellé>.md`
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
