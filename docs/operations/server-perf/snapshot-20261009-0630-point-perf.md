# Instantané VPS — j0910-point-perf

2026-10-09 06:30 UTC, up 4 weeks, 4 days, 13 hours, 56 minutes

## Mémoire et swap

```
               total        used        free      shared  buff/cache   available
Mem:           22945       11448        5805         805        6803       11497
Swap:           5119        4281         838

NAME       TYPE SIZE USED PRIO
/.swapfile file   5G 4.2G   -2
vm.swappiness = 10
```

## Processus (RSS, Mo)

```
    3271  opc java /usr/bin/java -Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/bro
    1344  101 clickhouse-serv clickhouse-server --config-file=/etc/clickhouse-server/config.xml
     657  systemd+ mysqld mysqld --innodb-flush-method=O_DIRECT --innodb-buffer-pool-size=2G --innodb-log-file-size=256M
     404  root dockerd /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
     386  opc node /usr/bin/node /opt/poi-server/server.js
     325  1001 next-server (v1 next-server (v16.3.3)
     259  1001 next-server (v next-server (v
     256  root bun bun --preload ./src/lib/sentry/init-server.ts ./server.ts
     206  1001 node node dist-server/server.mjs
     163  5000 python3 /usr/local/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=8, pipe_handle=10) --multiprocessing-fork
     146  root php php app/http.php
     144  root php php app/http.php
     139  root php php app/http.php
     137  1001 node node dist-server/multiplayer.mjs
     137  root php php app/http.php
     135  root php php app/http.php
     135  root php php app/http.php
     134  root php php app/http.php
     133  root php php app/http.php
     129  root traefik traefik traefik --providers.file.directory=/storage/config --providers.file.watch=true --providers.docker=true --providers.docker.expose
```

## Conteneurs

```
appwrite	342MiB / 22.41GiB	0.00%
appwrite-autogravity	17.44MiB / 22.41GiB	0.00%
appwrite-browser	34.51MiB / 22.41GiB	0.00%
appwrite-clickhouse-1	1.149GiB / 22.41GiB	0.97%
appwrite-console	306.9MiB / 22.41GiB	0.20%
appwrite-geo	25.82MiB / 22.41GiB	0.00%
appwrite-mariadb	705.8MiB / 22.41GiB	0.01%
appwrite-mqtt	28.47MiB / 22.41GiB	0.00%
appwrite-realtime	37.03MiB / 22.41GiB	0.06%
appwrite-redis	74.82MiB / 22.41GiB	2.13%
appwrite-task-interval	34.86MiB / 22.41GiB	0.00%
appwrite-task-maintenance	40.18MiB / 22.41GiB	0.00%
appwrite-traefik	95.89MiB / 22.41GiB	0.04%
appwrite-worker-certificates	44.21MiB / 22.41GiB	0.03%
appwrite-worker-databases	46.02MiB / 22.41GiB	0.02%
appwrite-worker-deletes	78.87MiB / 22.41GiB	0.03%
appwrite-worker-executions	26.68MiB / 22.41GiB	0.01%
appwrite-worker-functions	36.06MiB / 22.41GiB	0.02%
appwrite-worker-jobs	50.21MiB / 22.41GiB	0.03%
appwrite-worker-mails	34.63MiB / 22.41GiB	0.02%
appwrite-worker-notifications	34.3MiB / 22.41GiB	0.02%
appwrite-worker-screenshots	36.11MiB / 22.41GiB	0.01%
appwrite-worker-stats-resources	54.78MiB / 22.41GiB	0.02%
appwrite-worker-stats-usage	52.27MiB / 22.41GiB	0.02%
appwrite-worker-webhooks	34.57MiB / 22.41GiB	0.03%
beszel-agent	14.55MiB / 22.41GiB	0.00%
beszel-hub	46.64MiB / 22.41GiB	0.00%
coolify	305.1MiB / 22.41GiB	0.19%
coolify-db	65.83MiB / 22.41GiB	0.00%
coolify-realtime	82.18MiB / 22.41GiB	0.31%
coolify-redis	11.86MiB / 22.41GiB	0.50%
coolify-sentinel	414.4MiB / 22.41GiB	0.02%
exc1	36.41MiB / 22.41GiB	0.00%
glitchtip-db	56.78MiB / 22.41GiB	0.02%
glitchtip-redis	6.117MiB / 22.41GiB	0.52%
glitchtip-web	162.1MiB / 22.41GiB	0.00%
glitchtip-worker	113.5MiB / 22.41GiB	0.64%
jsssoodwfi6rvvmvawcg3isq-175736083243	374.9MiB / 22.41GiB	0.03%
krejrvgvs2w5kmfo27rutffz-200800551884	84.07MiB / 1.5GiB	0.10%
open-meteo	11.84MiB / 2GiB	0.06%
open-meteo-sync-arome	54.34MiB / 512MiB	0.01%
open-meteo-sync-arpege	59.64MiB / 512MiB	0.03%
open-meteo-sync-arpege-history	66.98MiB / 512MiB	0.05%
orchestrator	36.34MiB / 22.41GiB	0.00%
q7lznj8fhunybhvuvm3jcu0u-200846784831	152.7MiB / 768MiB	0.00%
umami-app	255.1MiB / 22.41GiB	0.00%
umami-db	27.22MiB / 22.41GiB	0.00%
```

## BRouter — JVM

```
uptime 09:35:00, RSS 3271 Mo
-Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/brouter/gc.log:time,uptime,level,tags:filecount=5,filesize=10m 
VmSwap:	       0 kB
2111686:
 garbage-first heap   total 3145728K, used 613434K [0x0000000740000000, 0x0000000800000000)
  region size 2048K, 297 young (608256K), 5 survivors (10240K)
 Metaspace       used 2981K, committed 3328K, reserved 1114112K
    S0C         S1C         S0U         S1U          EC           EU           OC           OU          MC         MU       CCSC      CCSU     YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT   
        0.0     10240.0         0.0      9223.6    1968128.0     595968.0    1167360.0       7219.3     3328.0     2951.7     384.0     200.2     10     0.097     0     0.000     0     0.000     0.097
```

## BRouter — durée des calculs sur 24 h (ms)

```
n=208 p50=137 p90=148 p95=159 p99=258 max=1034
```

## Serveur temps réel — /metrics.json

```
{"ok":true,"rooms":0,"clients":0,"batches":339,"fenced":0,"journalErrors":0,"checkpointErrors":0,"loads":10,"loadErrors":0,"deletedRooms":0,"shadowChecks":13,"shadowMismatches":0,"shadowErrors":0,"motionIn":21224,"motionDroppedRate":1109,"motionInvalid":0,"motionSkippedBackpressure":0,"connectionsReplaced":1,"rateLimited":0,"roomFailures":0,"connectionsRefused":0,"bytesThrottled":0,"journal_latency_p50_ms":18,"journal_latency_p95_ms":247,"checkpoint_p95_ms":987,"entry_auth_p50_ms":86,"entry_auth_p95_ms":391,"entry_auth_max_ms":892,"entry_auth_count":87,"entry_auth_sum_ms":10084,"entry_auth_le_50":27,"entry_auth_le_100":52,"entry_auth_le_250":76,"entry_auth_le_500":86,"entry_auth_le_1000":87,"entry_auth_le_2000":87,"entry_auth_le_5000":87,"entry_auth_le_10000":87,"entry_room_load_p50_ms":161,"entry_room_load_p95_ms":957,"entry_room_load_max_ms":957,"entry_room_load_count":10,"entry_room_load_sum_ms":2681,"entry_room_load_le_50":0,"entry_room_load_le_100":2,"entry_room_load_le_250":7,"entry_room_load_le_500":8,"entry_room_load_le_1000":10,"entry_room_load_le_2000":10,"entry_room_load_le_5000":10,"entry_room_load_le_10000":10,"entry_welcome_p50_ms":1,"entry_welcome_p95_ms":116,"entry_welcome_max_ms":889,"entry_welcome_count":87,"entry_welcome_sum_ms":3248,"entry_welcome_le_50":77,"entry_welcome_le_100":81,"entry_welcome_le_250":84,"entry_welcome_le_500":85,"entry_welcome_le_1000":87,"entry_welcome_le_2000":87,"entry_welcome_le_5000":87,"entry_welcome_le_10000":87,"entry_total_p50_ms":277,"entry_total_p95_ms":5630,"entry_total_max_ms":8369,"entry_total_count":87,"entry_total_sum_ms":68256,"entry_total_le_50":1,"entry_total_le_100":8,"entry_total_le_250":41,"entry_total_le_500":70,"entry_total_le_1000":78,"entry_total_le_2000":79,"entry_total_le_5000":81,"entry_total_le_10000":87,"event_loop_delay_p99_ms":20.3,"event_loop_delay_max_ms":97.3,"rss_bytes":143708160,"heap_used_bytes":38009808}
```

## Disque

```
Filesystem                 Type  Size  Used Avail Use% Mounted on
/dev/mapper/ocivolume-root xfs    83G   50G   33G  61% /
/dev/sda2                  xfs   2.0G  730M  1.3G  37% /boot
/dev/mapper/ocivolume-oled xfs    15G  458M   15G   3% /var/oled
/dev/sda1                  vfat  100M  7.9M   92M   8% /boot/efi

TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          33        25        23.5GB    4.627GB (19%)
Containers      47        47        15.98MB   0B (0%)
Local Volumes   19        17        9.299GB   681.8MB (7%)
Build Cache     0         0         0B        0B

22G	/var/lib/containerd
9.1G	/var/lib/docker
1.8G	/opt/brouter
810M	/opt/poi-server/data
1020M	/var/cache/dnf
1004M	/var/tmp
1.2G	/var/www/weather
0	/var/backups
Archived and active journals take up 439.2M in the file system.
Archived and active journals take up 24.7M in the file system.
```

## Volumes Docker

```
9171f4c2935de58ec8236255c2e4ddd7036140037eab7816090525181da61eaf 48K
appwrite-builds                               0
appwrite_appwrite-builds                      0
appwrite_appwrite-cache                       48K
appwrite_appwrite-certificates                0
appwrite_appwrite-clickhouse                  551M
appwrite_appwrite-config                      0
appwrite_appwrite-functions                   0
appwrite_appwrite-imports                     0
appwrite_appwrite-mariadb                     4.8G
appwrite_appwrite-models                      651M
appwrite_appwrite-redis                       49M
appwrite_appwrite-sites                       0
appwrite_appwrite-uploads                     240M
coolify-db                                    91M
coolify-redis                                 2.4M
glitchtip_pg-data                             85M
glitchtip_uploads                             306M
open-meteo_open-meteo-data                    2.1G
```
