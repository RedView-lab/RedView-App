# Instantané VPS — after-brouter

2026-10-05 20:04 UTC, up 4 weeks, 1 day, 3 hours, 29 minutes

## Mémoire et swap

```
               total        used        free      shared  buff/cache   available
Mem:           22945       12824        3622         811        7619       10121
Swap:           5119           4        5115

NAME       TYPE SIZE USED PRIO
/.swapfile file   5G 4.5M   -2
vm.swappiness = 10
```

## Processus (RSS, Mo)

```
    3305  opc java /usr/bin/java -Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/bro
     996  systemd+ mysqld mysqld --innodb-flush-method=fsync
     938  1001 next-server (v1 next-server (v16.3.3)
     678  root dockerd /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
     359  1001 next-server (v next-server (v
     325  1001 node node --import tsx server/multiplayer/main.ts
     208  1001 node node --import tsx server.mjs
     196  pcp pmlogger /usr/libexec/pcp/bin/pmlogger -N -P -d "/var/oled/pcp/pmlogger/LOCALHOSTNAME" -r -T24h10m -c config.ora -v 100mb -mreexec %Y%m%d.%H.%M
     179  5000 python3 /usr/local/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=8, pipe_handle=10) --multiprocessing-fork
     134  opc node /usr/bin/node /opt/poi-server/server.js
     117  5000 python python /code/manage.py runworker --scheduler
     109  root php php app/http.php
     108  root php php app/http.php
      93  root php php app/http.php
      92  root php php app/http.php
      88  root php php app/http.php
      88  root php php app/http.php
      84  root php php app/http.php
      82  root containerd /usr/bin/containerd
      80  root php php app/http.php
```

## Conteneurs

```
appwrite	1010MiB / 22.41GiB	0.00%
appwrite-assistant	82.72MiB / 22.41GiB	0.00%
appwrite-console	4.211MiB / 22.41GiB	0.00%
appwrite-mariadb	1007MiB / 22.41GiB	0.04%
appwrite-realtime	165MiB / 22.41GiB	0.27%
appwrite-redis	18.14MiB / 22.41GiB	0.18%
appwrite-task-maintenance	31.68MiB / 22.41GiB	0.00%
appwrite-task-scheduler-executions	32.47MiB / 22.41GiB	0.03%
appwrite-task-scheduler-functions	32.27MiB / 22.41GiB	0.00%
appwrite-task-scheduler-messages	32.12MiB / 22.41GiB	0.09%
appwrite-traefik	41.24MiB / 22.41GiB	0.06%
appwrite-worker-audits	28.22MiB / 22.41GiB	0.01%
appwrite-worker-builds	24.56MiB / 22.41GiB	0.00%
appwrite-worker-certificates	24.11MiB / 22.41GiB	0.00%
appwrite-worker-databases	29.25MiB / 22.41GiB	0.01%
appwrite-worker-deletes	29.97MiB / 22.41GiB	0.00%
appwrite-worker-functions	29.81MiB / 22.41GiB	0.01%
appwrite-worker-mails	25.47MiB / 22.41GiB	0.00%
appwrite-worker-messaging	24.51MiB / 22.41GiB	0.01%
appwrite-worker-migrations	24.54MiB / 22.41GiB	0.00%
appwrite-worker-usage	28.73MiB / 22.41GiB	0.01%
appwrite-worker-usage-dump	28.24MiB / 22.41GiB	0.01%
appwrite-worker-webhooks	29.59MiB / 22.41GiB	0.01%
beszel-agent	16.21MiB / 22.41GiB	0.83%
beszel-hub	53.28MiB / 22.41GiB	1.47%
coolify	391.3MiB / 22.41GiB	0.17%
coolify-db	64.68MiB / 22.41GiB	2.37%
coolify-realtime	71.14MiB / 22.41GiB	0.30%
coolify-redis	14.71MiB / 22.41GiB	0.52%
coolify-sentinel	310MiB / 22.41GiB	0.02%
glitchtip-db	62.04MiB / 22.41GiB	0.33%
glitchtip-redis	8.031MiB / 22.41GiB	0.53%
glitchtip-web	211MiB / 22.41GiB	0.00%
glitchtip-worker	117MiB / 22.41GiB	0.57%
jsssoodwfi6rvvmvawcg3isq-175736083243	1010MiB / 22.41GiB	0.04%
krejrvgvs2w5kmfo27rutffz-173513006193	300MiB / 22.41GiB	0.17%
openruntimes-executor	47.62MiB / 22.41GiB	0.00%
q7lznj8fhunybhvuvm3jcu0u-172707614964	194.7MiB / 22.41GiB	1.78%
umami-app	397.8MiB / 22.41GiB	0.00%
umami-db	52.68MiB / 22.41GiB	0.01%
```

## BRouter — JVM

```
uptime 37:55, RSS 3305 Mo
-Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/brouter/gc.log:time,uptime,level,tags:filecount=5,filesize=10m 
VmSwap:	       0 kB
569109:
 garbage-first heap   total 3145728K, used 1003877K [0x0000000740000000, 0x0000000800000000)
  region size 2048K, 347 young (710656K), 9 survivors (18432K)
 Metaspace       used 3044K, committed 3392K, reserved 1114112K
    S0C         S1C         S0U         S1U          EC           EU           OC           OU          MC         MU       CCSC      CCSU     YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT   
        0.0     18432.0         0.0     18351.6    1054720.0     688128.0    2072576.0     294326.3     3328.0     3041.7     384.0     203.5     19     0.400     0     0.000     0     0.000     0.400
```

## BRouter — durée des calculs sur 24 h (ms)

```
n=680 p50=189 p90=1173 p95=2582 p99=6330 max=20306
```

## Serveur temps réel — /metrics.json

```
{"ok":true,"rooms":1,"clients":2,"batches":469,"fenced":0,"journalErrors":0,"checkpointErrors":21,"loads":3,"loadErrors":0,"deletedRooms":1,"shadowChecks":10,"shadowMismatches":0,"shadowErrors":0,"journal_latency_p50_ms":186,"journal_latency_p95_ms":1223,"checkpoint_p95_ms":5789,"event_loop_delay_p99_ms":20.8,"event_loop_delay_max_ms":982.5,"rss_bytes":340590592,"heap_used_bytes":223522592}
```

## Disque

```
Filesystem                 Type  Size  Used Avail Use% Mounted on
/dev/mapper/ocivolume-root xfs    83G   47G   37G  56% /
/dev/sda2                  xfs   2.0G  730M  1.3G  37% /boot
/dev/mapper/ocivolume-oled xfs    15G  539M   15G   4% /var/oled
/dev/sda1                  vfat  100M  7.9M   92M   8% /boot/efi

TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          46        21        23.95GB   8.108GB (33%)
Containers      40        40        16.24MB   0B (0%)
Local Volumes   13        13        5.619GB   0B (0%)
Build Cache     32        0         1.537GB   1.537GB

24G	/var/lib/containerd
5.7G	/var/lib/docker
1.8G	/opt/brouter
810M	/opt/poi-server/data
11M	/var/cache/dnf
4.0K	/var/tmp
1.1G	/var/www/weather
88M	/var/backups
Archived and active journals take up 457.7M in the file system.
```

## Volumes Docker

```
9171f4c2935de58ec8236255c2e4ddd7036140037eab7816090525181da61eaf 48K
appwrite_appwrite-builds                      0
appwrite_appwrite-cache                       48K
appwrite_appwrite-certificates                0
appwrite_appwrite-config                      0
appwrite_appwrite-functions                   0
appwrite_appwrite-mariadb                     4.6G
appwrite_appwrite-redis                       4.9M
appwrite_appwrite-uploads                     340M
coolify-db                                    98M
coolify-redis                                 2.1M
glitchtip_pg-data                             82M
glitchtip_uploads                             227M
```
