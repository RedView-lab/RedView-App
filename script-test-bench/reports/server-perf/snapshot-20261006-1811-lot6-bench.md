# Instantané VPS — lot6-bench

2026-10-06 18:11 UTC, up 4 weeks, 2 days, 1 hour, 37 minutes

## Mémoire et swap

```
               total        used        free      shared  buff/cache   available
Mem:           22945        9516        1447         459       12816       13429
Swap:           5119        1279        3840

NAME       TYPE SIZE USED PRIO
/.swapfile file   5G 1.2G   -2
vm.swappiness = 10
```

## Processus (RSS, Mo)

```
    3350  opc java /usr/bin/java -Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/bro
     789  systemd+ mysqld mysqld --innodb-flush-method=O_DIRECT --innodb-buffer-pool-size=2G --innodb-log-file-size=256M
     498  opc node /usr/bin/node /opt/poi-server/server.js
     331  root dockerd /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
     316  1001 next-server (v1 next-server (v16.3.3)
     240  1001 next-server (v next-server (v
     172  1001 node node dist-server/server.mjs
     166  5000 python3 /usr/local/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=8, pipe_handle=10) --multiprocessing-fork
     156  pcp pmlogger /usr/libexec/pcp/bin/pmlogger -N -P -d "/var/oled/pcp/pmlogger/LOCALHOSTNAME" -r -T24h10m -c config.ora -v 100mb -mreexec %Y%m%d.%H.%M
     131  1001 node node dist-server/multiplayer.mjs
     117  5000 python python /code/manage.py runworker --scheduler
      86  root php php app/http.php
      83  root containerd /usr/bin/containerd
      80  root php php app/http.php
      77  9999 php /usr/local/bin/php artisan horizon:work redis --name=default --supervisor=611f87dde1ce-yi5d:s6 --backoff=0 --max-time=0 --max-jobs=400 --mem
      64  root php php app/http.php
      61  root php php app/http.php
      59  root php php app/http.php
      59  systemd+ redis-server redis-server *:6379
      59  root systemd-journal /usr/lib/systemd/systemd-journald
```

## Conteneurs

```
appwrite	268.1MiB / 22.41GiB	0.00%
appwrite-console	4.715MiB / 22.41GiB	0.00%
appwrite-mariadb	773.9MiB / 22.41GiB	0.01%
appwrite-realtime	52.49MiB / 22.41GiB	0.01%
appwrite-redis	62.37MiB / 22.41GiB	0.16%
appwrite-task-maintenance	32.64MiB / 22.41GiB	0.00%
appwrite-traefik	98.65MiB / 22.41GiB	0.04%
appwrite-worker-audits	29.46MiB / 22.41GiB	0.00%
appwrite-worker-certificates	24.45MiB / 22.41GiB	0.00%
appwrite-worker-databases	24.65MiB / 22.41GiB	0.01%
appwrite-worker-deletes	28.38MiB / 22.41GiB	0.00%
appwrite-worker-functions	28.48MiB / 22.41GiB	0.00%
appwrite-worker-mails	35.2MiB / 22.41GiB	0.00%
appwrite-worker-usage	30.38MiB / 22.41GiB	0.00%
appwrite-worker-usage-dump	27.7MiB / 22.41GiB	0.00%
appwrite-worker-webhooks	28.43MiB / 22.41GiB	0.00%
beszel-agent	16.78MiB / 22.41GiB	0.00%
beszel-hub	50.02MiB / 22.41GiB	0.00%
coolify	257.6MiB / 22.41GiB	3.80%
coolify-db	53.7MiB / 22.41GiB	0.00%
coolify-realtime	83.04MiB / 22.41GiB	0.27%
coolify-redis	14.76MiB / 22.41GiB	0.56%
coolify-sentinel	232.7MiB / 22.41GiB	0.02%
glitchtip-db	49.34MiB / 22.41GiB	0.02%
glitchtip-redis	5.711MiB / 22.41GiB	0.51%
glitchtip-web	166.7MiB / 22.41GiB	0.01%
glitchtip-worker	116MiB / 22.41GiB	0.56%
jsssoodwfi6rvvmvawcg3isq-175736083243	374.5MiB / 22.41GiB	0.04%
krejrvgvs2w5kmfo27rutffz-103946836476	74.76MiB / 1.5GiB	0.17%
openruntimes-executor	39.12MiB / 22.41GiB	0.00%
q7lznj8fhunybhvuvm3jcu0u-104010128640	116.9MiB / 768MiB	0.00%
umami-app	253.2MiB / 22.41GiB	0.00%
umami-db	35.37MiB / 22.41GiB	0.00%
```

## BRouter — JVM

```
uptime 22:45:17, RSS 3350 Mo
-Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/brouter/gc.log:time,uptime,level,tags:filecount=5,filesize=10m 
VmSwap:	       0 kB
569109:
 garbage-first heap   total 3145728K, used 1150385K [0x0000000740000000, 0x0000000800000000)
  region size 2048K, 440 young (901120K), 8 survivors (16384K)
 Metaspace       used 3653K, committed 4096K, reserved 1114112K
    S0C         S1C         S0U         S1U          EC           EU           OC           OU          MC         MU       CCSC      CCSU     YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT   
        0.0     16384.0         0.0     15742.2    1966080.0     882688.0    1163264.0     250931.3     4096.0     3653.0     384.0     181.7    271     8.037     0     0.000    56     0.078     8.114
```

## BRouter — durée des calculs sur 24 h (ms)

```
n=2034 p50=446 p90=1751 p95=2471 p99=5741 max=20306
```

## Serveur temps réel — /metrics.json

```
{"ok":true,"rooms":1,"clients":1,"batches":215,"fenced":0,"journalErrors":0,"checkpointErrors":0,"loads":10,"loadErrors":0,"deletedRooms":0,"shadowChecks":7,"shadowMismatches":0,"shadowErrors":0,"motionIn":9020,"motionDroppedRate":0,"motionInvalid":0,"motionSkippedBackpressure":30,"journal_latency_p50_ms":178,"journal_latency_p95_ms":788,"checkpoint_p95_ms":2531,"event_loop_delay_p99_ms":20.3,"event_loop_delay_max_ms":333.4,"rss_bytes":136880128,"heap_used_bytes":46677968}
```

## Disque

```
Filesystem                 Type  Size  Used Avail Use% Mounted on
/dev/mapper/ocivolume-root xfs    83G   45G   39G  55% /
/dev/sda2                  xfs   2.0G  730M  1.3G  37% /boot
/dev/mapper/ocivolume-oled xfs    15G  544M   15G   4% /var/oled
/dev/sda1                  vfat  100M  7.9M   92M   8% /boot/efi

TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          31        21        17.45GB   5.629GB (32%)
Containers      33        33        15.51MB   0B (0%)
Local Volumes   13        13        5.899GB   0B (0%)
Build Cache     56        0         2.452GB   2.214GB

19G	/var/lib/containerd
5.8G	/var/lib/docker
1.8G	/opt/brouter
810M	/opt/poi-server/data
1014M	/var/cache/dnf
4.0K	/var/tmp
1.2G	/var/www/weather
3.1G	/var/backups
Archived and active journals take up 454.9M in the file system.
```

## Volumes Docker

```
9171f4c2935de58ec8236255c2e4ddd7036140037eab7816090525181da61eaf 48K
appwrite_appwrite-builds                      0
appwrite_appwrite-cache                       48K
appwrite_appwrite-certificates                0
appwrite_appwrite-config                      0
appwrite_appwrite-functions                   0
appwrite_appwrite-mariadb                     4.7G
appwrite_appwrite-redis                       49M
appwrite_appwrite-uploads                     321M
coolify-db                                    98M
coolify-redis                                 1.9M
glitchtip_pg-data                             83M
glitchtip_uploads                             308M
```
