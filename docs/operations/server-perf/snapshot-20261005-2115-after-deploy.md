# Instantané VPS — after-deploy

2026-10-05 21:15 UTC, up 4 weeks, 1 day, 4 hours, 40 minutes

## Mémoire et swap

```
               total        used        free      shared  buff/cache   available
Mem:           22945        9518        1727         582       12607       13427
Swap:           5119         944        4175

NAME       TYPE SIZE   USED PRIO
/.swapfile file   5G 944.3M   -2
vm.swappiness = 10
```

## Processus (RSS, Mo)

```
    3331  opc java /usr/bin/java -Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/bro
     578  systemd+ mysqld mysqld --innodb-flush-method=O_DIRECT --innodb-buffer-pool-size=2G --innodb-log-file-size=256M
     462  1001 next-server (v1 next-server (v16.3.3)
     398  opc node /usr/bin/node /opt/poi-server/server.js
     317  1001 next-server (v next-server (v
     214  root dockerd /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
     169  5000 python3 /usr/local/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=8, pipe_handle=10) --multiprocessing-fork
     120  1001 node node dist-server/multiplayer.mjs
     117  5000 python python /code/manage.py runworker --scheduler
     109  pcp pmlogger /usr/libexec/pcp/bin/pmlogger -N -P -d "/var/oled/pcp/pmlogger/LOCALHOSTNAME" -r -T24h10m -c config.ora -v 100mb -mreexec %Y%m%d.%H.%M
     108  1001 node node dist-server/server.mjs
      78  9999 php /usr/local/bin/php artisan horizon:work redis --name=default --supervisor=611f87dde1ce-yi5d:s6 --backoff=0 --max-time=0 --max-jobs=400 --mem
      77  root containerd /usr/bin/containerd
      52  root php php app/http.php
      53  root php php app/http.php
      50  root php php app/http.php
      50  root php Maintenance V1
      49  root traefik traefik traefik --providers.file.directory=/storage/config --providers.file.watch=true --providers.docker=true --providers.docker.expose
      49  root php php app/http.php
      49  root php php app/http.php
```

## Conteneurs

```
appwrite	181.9MiB / 22.41GiB	0.00%
appwrite-console	2.961MiB / 22.41GiB	0.00%
appwrite-mariadb	576.6MiB / 22.41GiB	0.04%
appwrite-realtime	43.19MiB / 22.41GiB	0.09%
appwrite-redis	18.37MiB / 22.41GiB	0.15%
appwrite-task-maintenance	32.65MiB / 22.41GiB	0.00%
appwrite-traefik	90.57MiB / 22.41GiB	0.00%
appwrite-worker-audits	57.28MiB / 22.41GiB	0.00%
appwrite-worker-certificates	24.45MiB / 22.41GiB	0.00%
appwrite-worker-databases	24.65MiB / 22.41GiB	0.00%
appwrite-worker-deletes	30.3MiB / 22.41GiB	0.00%
appwrite-worker-functions	29.36MiB / 22.41GiB	0.00%
appwrite-worker-mails	25.2MiB / 22.41GiB	0.00%
appwrite-worker-usage	30.38MiB / 22.41GiB	0.00%
appwrite-worker-usage-dump	27.71MiB / 22.41GiB	0.00%
appwrite-worker-webhooks	30.43MiB / 22.41GiB	0.00%
beszel-agent	16.86MiB / 22.41GiB	0.00%
beszel-hub	37.25MiB / 22.41GiB	0.00%
coolify	292.6MiB / 22.41GiB	3.75%
coolify-db	62.34MiB / 22.41GiB	1.30%
coolify-realtime	72.41MiB / 22.41GiB	0.31%
coolify-redis	15.01MiB / 22.41GiB	0.70%
coolify-sentinel	201.6MiB / 22.41GiB	1.35%
glitchtip-db	58.52MiB / 22.41GiB	0.02%
glitchtip-redis	6.18MiB / 22.41GiB	0.57%
glitchtip-web	169.2MiB / 22.41GiB	0.00%
glitchtip-worker	114.3MiB / 22.41GiB	0.63%
jsssoodwfi6rvvmvawcg3isq-175736083243	503.8MiB / 22.41GiB	0.05%
krejrvgvs2w5kmfo27rutffz-211149823865	63.77MiB / 1.5GiB	0.18%
openruntimes-executor	51.18MiB / 22.41GiB	0.04%
q7lznj8fhunybhvuvm3jcu0u-211238834357	53.91MiB / 768MiB	0.00%
umami-app	317.2MiB / 22.41GiB	0.00%
umami-db	46.16MiB / 22.41GiB	0.00%
```

## BRouter — JVM

```
uptime 01:48:46, RSS 3331 Mo
-Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/brouter/gc.log:time,uptime,level,tags:filecount=5,filesize=10m 
VmSwap:	       0 kB
569109:
 garbage-first heap   total 3145728K, used 519530K [0x0000000740000000, 0x0000000800000000)
  region size 2048K, 98 young (200704K), 14 survivors (28672K)
 Metaspace       used 3080K, committed 3392K, reserved 1114112K
    S0C         S1C         S0U         S1U          EC           EU           OC           OU          MC         MU       CCSC      CCSU     YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT   
        0.0     28672.0         0.0     27648.0     456704.0     169984.0    2660352.0     320950.3     3392.0     3078.8     384.0     206.8     20     0.421     0     0.000     0     0.000     0.421
```

## BRouter — durée des calculs sur 24 h (ms)

```
n=699 p50=186 p90=1173 p95=2582 p99=6330 max=20306
```

## Serveur temps réel — /metrics.json

```
{"ok":true,"rooms":1,"clients":1,"batches":0,"fenced":0,"journalErrors":0,"checkpointErrors":0,"loads":1,"loadErrors":0,"deletedRooms":0,"shadowChecks":0,"shadowMismatches":0,"shadowErrors":0,"journal_latency_p50_ms":0,"journal_latency_p95_ms":0,"checkpoint_p95_ms":0,"event_loop_delay_p99_ms":21.6,"event_loop_delay_max_ms":147.8,"rss_bytes":126021632,"heap_used_bytes":37615296}
```

## Disque

```
Filesystem                 Type  Size  Used Avail Use% Mounted on
/dev/mapper/ocivolume-root xfs    83G   52G   32G  63% /
/dev/sda2                  xfs   2.0G  730M  1.3G  37% /boot
/dev/mapper/ocivolume-oled xfs    15G  574M   15G   4% /var/oled
/dev/sda1                  vfat  100M  7.9M   92M   8% /boot/efi

TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          48        20        24.35GB   11.62GB (47%)
Containers      33        33        15.56MB   0B (0%)
Local Volumes   13        13        5.791GB   0B (0%)
Build Cache     60        0         2.974GB   2.974GB

26G	/var/lib/containerd
5.7G	/var/lib/docker
1.8G	/opt/brouter
810M	/opt/poi-server/data
1012M	/var/cache/dnf
4.0K	/var/tmp
1.1G	/var/www/weather
3.1G	/var/backups
Archived and active journals take up 465.7M in the file system.
```

## Volumes Docker

```
9171f4c2935de58ec8236255c2e4ddd7036140037eab7816090525181da61eaf 56K
appwrite_appwrite-builds                      0
appwrite_appwrite-cache                       48K
appwrite_appwrite-certificates                0
appwrite_appwrite-config                      0
appwrite_appwrite-functions                   0
appwrite_appwrite-mariadb                     4.7G
appwrite_appwrite-redis                       7.7M
appwrite_appwrite-uploads                     313M
coolify-db                                    99M
coolify-redis                                 2.2M
glitchtip_pg-data                             82M
glitchtip_uploads                             254M
```
