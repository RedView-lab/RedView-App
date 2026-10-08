# Instantané VPS — baseline

2026-10-05 19:23 UTC, up 4 weeks, 1 day, 2 hours, 49 minutes

## Mémoire et swap

```
               total        used        free      shared  buff/cache   available
Mem:           22945       16960         793         159        5660        5984
Swap:           5119        5103          16

NAME       TYPE SIZE USED PRIO
/.swapfile file   5G   5G   -2
vm.swappiness = 60
```

## Processus (RSS, Mo)

```
   10096  opc java /usr/bin/java -Xms16G -Xmx16G -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=30 -XX:ParallelGCThreads=4 -XX:ConcGCThreads=2 -DmaxRunn
     659  root dockerd /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
     606  systemd+ mysqld mysqld --innodb-flush-method=fsync
     238  1001 node node --import tsx server/multiplayer/main.ts
     231  1001 next-server (v next-server (v
     195  1001 node node --import tsx server.mjs
     190  1001 next-server (v1 next-server (v16.3.3)
     170  5000 python3 /usr/local/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=8, pipe_handle=10) --multiprocessing-fork
     122  opc node /usr/bin/node /opt/poi-server/server.js
      94  pcp pmlogger /usr/libexec/pcp/bin/pmlogger -N -P -d "/var/oled/pcp/pmlogger/LOCALHOSTNAME" -r -T24h10m -c config.ora -v 100mb -mreexec %Y%m%d.%H.%M
      85  5000 python python /code/manage.py runworker --scheduler
      84  root php php app/http.php
      77  9999 php /usr/local/bin/php artisan horizon:work redis --name=default --supervisor=611f87dde1ce-yi5d:s6 --backoff=0 --max-time=0 --max-jobs=400 --mem
      74  root containerd /usr/bin/containerd
      68  root php php app/http.php
      68  root php php app/http.php
      66  root php php app/http.php
      62  root php php app/http.php
      59  root php php app/http.php
      56  root php php app/http.php
```

## Conteneurs

```
appwrite	597.1MiB / 22.41GiB	0.63%
appwrite-assistant	12.75MiB / 22.41GiB	0.00%
appwrite-console	1020KiB / 22.41GiB	0.00%
appwrite-mariadb	641.9MiB / 22.41GiB	0.24%
appwrite-realtime	130.7MiB / 22.41GiB	0.28%
appwrite-redis	15.38MiB / 22.41GiB	0.30%
appwrite-task-maintenance	6.449MiB / 22.41GiB	0.00%
appwrite-task-scheduler-executions	27.71MiB / 22.41GiB	0.09%
appwrite-task-scheduler-functions	27.45MiB / 22.41GiB	0.00%
appwrite-task-scheduler-messages	25.68MiB / 22.41GiB	0.03%
appwrite-traefik	61.88MiB / 22.41GiB	0.14%
appwrite-worker-audits	17.63MiB / 22.41GiB	0.00%
appwrite-worker-builds	16.21MiB / 22.41GiB	0.01%
appwrite-worker-certificates	16.16MiB / 22.41GiB	0.00%
appwrite-worker-databases	16.23MiB / 22.41GiB	0.00%
appwrite-worker-deletes	20.09MiB / 22.41GiB	0.01%
appwrite-worker-functions	15.14MiB / 22.41GiB	0.22%
appwrite-worker-mails	14.87MiB / 22.41GiB	0.00%
appwrite-worker-messaging	14.9MiB / 22.41GiB	0.00%
appwrite-worker-migrations	13.52MiB / 22.41GiB	0.00%
appwrite-worker-usage	19.77MiB / 22.41GiB	0.08%
appwrite-worker-usage-dump	16.86MiB / 22.41GiB	0.00%
appwrite-worker-webhooks	18.72MiB / 22.41GiB	0.11%
beszel-agent	15.98MiB / 22.41GiB	0.00%
beszel-hub	37.44MiB / 22.41GiB	0.00%
coolify	240.1MiB / 22.41GiB	0.28%
coolify-db	29.15MiB / 22.41GiB	1.57%
coolify-realtime	35.57MiB / 22.41GiB	0.30%
coolify-redis	12.56MiB / 22.41GiB	0.51%
coolify-sentinel	304.9MiB / 22.41GiB	0.02%
glitchtip-db	25.4MiB / 22.41GiB	0.02%
glitchtip-redis	7.035MiB / 22.41GiB	0.55%
glitchtip-web	169.3MiB / 22.41GiB	0.00%
glitchtip-worker	95.21MiB / 22.41GiB	0.58%
jsssoodwfi6rvvmvawcg3isq-175736083243	230.8MiB / 22.41GiB	0.04%
krejrvgvs2w5kmfo27rutffz-173513006193	203.7MiB / 22.41GiB	2.81%
openruntimes-executor	30.25MiB / 22.41GiB	0.13%
q7lznj8fhunybhvuvm3jcu0u-172707614964	174MiB / 22.41GiB	2.98%
umami-app	255.8MiB / 22.41GiB	0.00%
umami-db	34MiB / 22.41GiB	0.01%
```

## BRouter — JVM

```
uptime 01:58:26, RSS 10096 Mo
-Xms16G -Xmx16G -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=30 -XX:ParallelGCThreads=4 -XX:ConcGCThreads=2 
VmSwap:	 2043584 kB
319906:
 garbage-first heap   total 16777216K, used 376720K [0x0000000400000000, 0x0000000800000000)
  region size 8192K, 45 young (368640K), 2 survivors (16384K)
 Metaspace       used 3059K, committed 3392K, reserved 1114112K
    S0C         S1C         S0U         S1U          EC           EU           OC           OU          MC         MU       CCSC      CCSU     YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT   
        0.0     16384.0         0.0     13874.7     868352.0     344064.0   15892480.0      10590.3     3328.0     3051.4     384.0     208.2     11     0.227     0     0.000     0     0.000     0.227
```

## BRouter — durée des calculs sur 24 h (ms)

```
n=617 p50=197 p90=1158 p95=2620 p99=6086 max=13162
```

## Serveur temps réel — /metrics.json

```
{"ok":true,"rooms":1,"clients":2,"batches":253,"fenced":0,"journalErrors":0,"checkpointErrors":0,"loads":3,"loadErrors":0,"deletedRooms":1,"shadowChecks":7,"shadowMismatches":0,"shadowErrors":0,"journal_latency_p50_ms":170,"journal_latency_p95_ms":438,"checkpoint_p95_ms":3207,"event_loop_delay_p99_ms":20.5,"event_loop_delay_max_ms":454.3,"rss_bytes":272994304,"heap_used_bytes":140395896}
```

## Disque

```
Filesystem                 Type  Size  Used Avail Use% Mounted on
/dev/mapper/ocivolume-root xfs    83G   57G   27G  69% /
/dev/sda2                  xfs   2.0G  730M  1.3G  37% /boot
/dev/mapper/ocivolume-oled xfs    15G  501M   15G   4% /var/oled
/dev/sda1                  vfat  100M  7.9M   92M   8% /boot/efi

TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          46        21        23.95GB   8.108GB (33%)
Containers      40        40        16.23MB   0B (0%)
Local Volumes   13        13        5.601GB   0B (0%)
Build Cache     225       0         11.6GB    11.16GB

33G	/var/lib/containerd
5.7G	/var/lib/docker
1.8G	/opt/brouter
810M	/opt/poi-server/data
1012M	/var/cache/dnf
877M	/var/tmp
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
appwrite_appwrite-mariadb                     4.5G
appwrite_appwrite-redis                       4.9M
appwrite_appwrite-uploads                     327M
coolify-db                                    98M
coolify-redis                                 2.0M
glitchtip_pg-data                             82M
glitchtip_uploads                             227M
```
