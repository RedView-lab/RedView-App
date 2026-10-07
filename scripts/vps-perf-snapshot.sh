#!/usr/bin/env bash
# =============================================================================
# Instantané des ressources du VPS RedView (141.145.220.99) — LECTURE SEULE.
# À lancer depuis la racine du repo, sur le poste local :
#
#   bash scripts/vps-perf-snapshot.sh <libellé> [--with-db] [--with-weather]
#
# Écrit script-test-bench/reports/server-perf/snapshot-<date>-<libellé>.md :
# mémoire/swap, processus, conteneurs, disque, tas Java de BRouter et latence
# de ses calculs sur 24 h, mesures du serveur temps réel. Sert d'avant/après à
# chaque réglage (server/vps/README.md).
#
#   --with-db       tailles des tables MariaDB d'Appwrite (information_schema)
#   --with-weather  contenu de /var/www/weather et timers systemd
# =============================================================================
set -euo pipefail

LABEL="${1:-snapshot}"
shift || true
WITH_DB=0
WITH_WEATHER=0
for arg in "$@"; do
  case "$arg" in
    --with-db) WITH_DB=1 ;;
    --with-weather) WITH_WEATHER=1 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

KEY="${KEY:-$HOME/.ssh/oracle_brouter.key}"
HOST="${HOST:-opc@141.145.220.99}"

cd "$(dirname "$0")/.."
OUT_DIR=script-test-bench/reports/server-perf
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/snapshot-$(date -u +%Y%m%d-%H%M)-$LABEL.md"

ssh -i "$KEY" -o ConnectTimeout=15 -o LogLevel=ERROR "$HOST" \
  "WITH_DB=$WITH_DB WITH_WEATHER=$WITH_WEATHER LABEL=$LABEL bash -s" > "$OUT" <<'REMOTE'
set -uo pipefail
section() { printf '\n## %s\n\n```\n' "$1"; }
end() { printf '```\n'; }

printf '# Instantané VPS — %s\n\n%s UTC, %s\n' "$LABEL" "$(date -u '+%Y-%m-%d %H:%M')" "$(uptime -p)"

section 'Mémoire et swap'
free -m
echo
swapon --show
echo "vm.swappiness = $(cat /proc/sys/vm/swappiness)"
end

section 'Processus (RSS, Mo)'
ps -eo rss=,user=,comm=,args= --sort=-rss | head -20 \
  | awk '{ rss = $1; $1 = ""; printf "%8.0f %s\n", rss / 1024, substr($0, 1, 150) }'
end

section 'Conteneurs'
sudo docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | sort -t$'\t' -k1,1
end

section 'BRouter — JVM'
BROUTER_PID=$(pgrep -u opc -f brouter-server.jar | head -1)
if [ -n "$BROUTER_PID" ]; then
  ps -o etime=,rss= -p "$BROUTER_PID" | awk '{ printf "uptime %s, RSS %.0f Mo\n", $1, $2 / 1024 }'
  tr '\0' ' ' < "/proc/$BROUTER_PID/cmdline" | grep -oE -- '-X[^ ]+' | tr '\n' ' '
  echo
  grep -E '^VmSwap' "/proc/$BROUTER_PID/status"
  jcmd "$BROUTER_PID" GC.heap_info 2>&1 | head -4
  jstat -gc "$BROUTER_PID" 2>&1
else
  echo 'BRouter absent'
fi
end

section 'BRouter — durée des calculs sur 24 h (ms)'
sudo journalctl --namespace=brouter -u brouter --since '-24h' -o cat 2>/dev/null \
  | grep -oE 'ms=[0-9]+' | cut -d= -f2 | sort -n \
  | awk 'function q(f,  i) { i = int(NR * f); if (i < NR * f) i++; return v[i < 1 ? 1 : i] }
      { v[NR] = $1 }
      END {
        if (NR == 0) { print "aucune requête"; exit }
        printf "n=%d p50=%d p90=%d p95=%d p99=%d max=%d\n", NR, q(0.50), q(0.90), q(0.95), q(0.99), v[NR]
      }'
end

section 'Serveur temps réel — /metrics.json'
MP=$(sudo docker ps -q -f name=krejrvgvs2w5kmfo27rutffz | head -1)
[ -n "$MP" ] && sudo docker exec "$MP" wget -qO- http://127.0.0.1:17791/metrics.json
echo
end

section 'Disque'
df -hT -x tmpfs -x devtmpfs -x efivarfs
echo
sudo docker system df
echo
sudo du -xsh /var/lib/containerd /var/lib/docker /opt/brouter /opt/poi-server/data \
  /var/cache/dnf /var/tmp /var/www/weather /var/backups 2>/dev/null
sudo journalctl --disk-usage
sudo journalctl --namespace=brouter --disk-usage
end

section 'Volumes Docker'
sudo docker volume ls -q | while read -r v; do
  printf '%-45s %s\n' "$v" "$(sudo du -sh "$(sudo docker volume inspect -f '{{.Mountpoint}}' "$v")" 2>/dev/null | cut -f1)"
done
end

if [ "$WITH_DB" = 1 ]; then
  section 'MariaDB — tables les plus lourdes (Mo)'
  sudo docker exec appwrite-mariadb sh -c 'mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" -t -e "
    SELECT table_name, table_rows,
           ROUND(data_length / 1048576) AS data_mb,
           ROUND(index_length / 1048576) AS index_mb,
           ROUND(data_free / 1048576) AS free_mb
    FROM information_schema.tables WHERE table_schema = \"appwrite\"
    ORDER BY data_length + index_length DESC LIMIT 25;
    SHOW GLOBAL VARIABLES WHERE Variable_name IN
      (\"innodb_buffer_pool_size\", \"innodb_flush_method\", \"innodb_log_file_size\", \"max_connections\");
    SHOW GLOBAL STATUS WHERE Variable_name IN
      (\"Innodb_buffer_pool_reads\", \"Innodb_buffer_pool_read_requests\", \"Threads_connected\");"'
  end
fi

if [ "$WITH_WEATHER" = 1 ]; then
  section 'Météo — /var/www/weather et timers'
  sudo du -h --max-depth=2 /var/www/weather 2>/dev/null | sort -h | tail -15
  sudo find /var/www/weather -type f | sed -E 's/.*\.//' | sort | uniq -c | sort -rn | head
  systemctl list-timers --all --no-pager | head -15
  end
fi
REMOTE

echo "Instantané écrit : $OUT"
