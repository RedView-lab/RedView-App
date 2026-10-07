# Instantané VPS — apres-deploiement-07-10

2026-10-07 13:55 UTC, up 4 weeks, 2 days, 21 hours, 21 minutes

## Mémoire et swap

```
               total        used        free      shared  buff/cache   available
Mem:           22945        9533        1031         242       12930       13412
Swap:           5119        1832        3287

NAME       TYPE SIZE USED PRIO
/.swapfile file   5G 1.8G   -2
vm.swappiness = 10
```

## Processus (RSS, Mo)

```
    3357  opc java /usr/bin/java -Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/bro
     722  systemd+ mysqld mysqld --innodb-flush-method=O_DIRECT --innodb-buffer-pool-size=2G --innodb-log-file-size=256M
     526  opc node /usr/bin/node /opt/poi-server/server.js
     365  root dockerd /usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock
     228  1001 next-server (v1 next-server (v16.3.3)
     207  1001 next-server (v next-server (v
     166  5000 python3 /usr/local/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=8, pipe_handle=10) --multiprocessing-fork
     135  1001 node node dist-server/server.mjs
     118  pcp pmlogger /usr/libexec/pcp/bin/pmlogger -N -P -d "/var/oled/pcp/pmlogger/LOCALHOSTNAME" -r -T24h10m -c config.ora -v 100mb -mreexec %Y%m%d.%H.%M
     116  5000 python python /code/manage.py runworker --scheduler
     116  1001 node node dist-server/multiplayer.mjs
      97  setroub+ setroubleshootd /usr/bin/python3 -Es /usr/sbin/setroubleshootd -f
      87  root php php app/http.php
      82  root php php app/http.php
      79  root systemd-journal /usr/lib/systemd/systemd-journald
      78  root containerd /usr/bin/containerd
      77  9999 php /usr/local/bin/php artisan horizon:work redis --name=default --supervisor=611f87dde1ce-yi5d:s6 --backoff=0 --max-time=0 --max-jobs=400 --mem
      70  root php php app/http.php
      70  root php php app/http.php
      69  root php php app/http.php
```

## Conteneurs

```
appwrite	322.9MiB / 22.41GiB	0.00%
appwrite-console	4.715MiB / 22.41GiB	0.00%
appwrite-mariadb	711.1MiB / 22.41GiB	0.00%
appwrite-realtime	65.1MiB / 22.41GiB	0.01%
appwrite-redis	60.09MiB / 22.41GiB	0.20%
appwrite-task-maintenance	21.68MiB / 22.41GiB	0.00%
appwrite-traefik	58.44MiB / 22.41GiB	0.04%
appwrite-worker-audits	26.72MiB / 22.41GiB	0.00%
appwrite-worker-certificates	16.69MiB / 22.41GiB	0.00%
appwrite-worker-databases	20.12MiB / 22.41GiB	0.00%
appwrite-worker-deletes	28.55MiB / 22.41GiB	0.00%
appwrite-worker-functions	27.12MiB / 22.41GiB	0.00%
appwrite-worker-mails	29.26MiB / 22.41GiB	0.00%
appwrite-worker-usage	28.77MiB / 22.41GiB	0.01%
appwrite-worker-usage-dump	23.97MiB / 22.41GiB	0.01%
appwrite-worker-webhooks	28.2MiB / 22.41GiB	0.00%
beszel-agent	16.35MiB / 22.41GiB	0.00%
beszel-hub	43.98MiB / 22.41GiB	0.00%
coolify	244.8MiB / 22.41GiB	0.17%
coolify-db	60.57MiB / 22.41GiB	0.00%
coolify-realtime	70.29MiB / 22.41GiB	0.25%
coolify-redis	15.66MiB / 22.41GiB	0.53%
coolify-sentinel	224.3MiB / 22.41GiB	0.02%
glitchtip-db	48.63MiB / 22.41GiB	0.02%
glitchtip-redis	6.586MiB / 22.41GiB	0.50%
glitchtip-web	170.6MiB / 22.41GiB	0.00%
glitchtip-worker	114.2MiB / 22.41GiB	0.59%
jsssoodwfi6rvvmvawcg3isq-175736083243	254.1MiB / 22.41GiB	0.08%
krejrvgvs2w5kmfo27rutffz-135343773363	61.3MiB / 1.5GiB	0.07%
openruntimes-executor	37.02MiB / 22.41GiB	0.00%
q7lznj8fhunybhvuvm3jcu0u-135020399692	82.29MiB / 768MiB	1.61%
umami-app	219.4MiB / 22.41GiB	0.00%
umami-db	31.82MiB / 22.41GiB	0.00%
```

## BRouter — JVM

```
uptime 1-18:29:20, RSS 3357 Mo
-Xms3g -Xmx3g -XX:+AlwaysPreTouch -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ExitOnOutOfMemoryError -Xlog:gc*:file=/var/log/brouter/gc.log:time,uptime,level,tags:filecount=5,filesize=10m 
VmSwap:	     616 kB
569109:
 garbage-first heap   total 3145728K, used 1338139K [0x0000000740000000, 0x0000000800000000)
  region size 2048K, 504 young (1032192K), 5 survivors (10240K)
 Metaspace       used 3747K, committed 4096K, reserved 1114112K
    S0C         S1C         S0U         S1U          EC           EU           OC           OU          MC         MU       CCSC      CCSU     YGC     YGCT     FGC    FGCT     CGC    CGCT       GCT   
        0.0     10240.0         0.0     10240.0    1972224.0    1019904.0    1163264.0     305947.3     4096.0     3747.9     384.0     198.5    289     8.239     0     0.000    68     0.091     8.330
```

## BRouter — durée des calculs sur 24 h (ms)

```
n=2387 p50=378 p90=1627 p95=2191 p99=5040 max=17247
```

## Serveur temps réel — /metrics.json

```
{"ok":true,"rooms":0,"clients":0,"batches":1,"fenced":0,"journalErrors":0,"checkpointErrors":0,"loads":1,"loadErrors":0,"deletedRooms":1,"shadowChecks":0,"shadowMismatches":0,"shadowErrors":0,"motionIn":3,"motionDroppedRate":0,"motionInvalid":0,"motionSkippedBackpressure":0,"connectionsReplaced":0,"rateLimited":0,"roomFailures":0,"connectionsRefused":0,"bytesThrottled":0,"journal_latency_p50_ms":29,"journal_latency_p95_ms":29,"checkpoint_p95_ms":0,"event_loop_delay_p99_ms":20.3,"event_loop_delay_max_ms":37.9,"rss_bytes":121847808,"heap_used_bytes":36230040}
```

## Disque

```
Filesystem                 Type  Size  Used Avail Use% Mounted on
/dev/mapper/ocivolume-root xfs    83G   48G   36G  57% /
/dev/sda2                  xfs   2.0G  730M  1.3G  37% /boot
/dev/mapper/ocivolume-oled xfs    15G  464M   15G   4% /var/oled
/dev/sda1                  vfat  100M  7.9M   92M   8% /boot/efi

TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          35        21        17.77GB   5.937GB (33%)
Containers      33        33        15.52MB   0B (0%)
Local Volumes   13        13        5.759GB   0B (0%)
Build Cache     99        0         4.727GB   4.489GB

21G	/var/lib/containerd
5.6G	/var/lib/docker
1.8G	/opt/brouter
810M	/opt/poi-server/data
1014M	/var/cache/dnf
4.0K	/var/tmp
1.2G	/var/www/weather
3.1G	/var/backups
Archived and active journals take up 462.9M in the file system.
```

## Volumes Docker

```
9171f4c2935de58ec8236255c2e4ddd7036140037eab7816090525181da61eaf 60K
appwrite_appwrite-builds                      0
appwrite_appwrite-cache                       48K
appwrite_appwrite-certificates                0
appwrite_appwrite-config                      0
appwrite_appwrite-functions                   0
appwrite_appwrite-mariadb                     4.7G
appwrite_appwrite-redis                       48M
appwrite_appwrite-uploads                     322M
coolify-db                                    100M
coolify-redis                                 2.4M
glitchtip_pg-data                             83M
glitchtip_uploads                             172M
```
