#!/usr/bin/env bash
# install.sh — installe ou met à jour redview-watch sur le serveur (root).
# Idempotent : relancer après chaque modification de server/vps/watch/.
#
#   sudo bash install.sh

set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo bash "$0" "$@"
cd "$(dirname "$0")"

for bin in jq curl docker openssl flock timeout; do
  command -v "$bin" > /dev/null || { echo "outil manquant : $bin" >&2; exit 1; }
done

install -D -m 0755 redview-watch /usr/local/sbin/redview-watch
install -D -m 0644 README.md /usr/local/share/doc/redview-watch/README.md
install -d -m 0700 /etc/redview-watch /var/lib/redview-watch
[[ -e /etc/redview-watch/watch.env ]] || install -m 0600 watch.env.example /etc/redview-watch/watch.env
install -m 0644 systemd/redview-watch.service systemd/redview-watch.timer /etc/systemd/system/
# SELinux : un fichier copié depuis /tmp garde user_tmp_t et systemd le refuse
# (l'ancien cron de sauvegarde est resté mort 16 jours ainsi).
if command -v restorecon > /dev/null; then
  restorecon -RF /usr/local/sbin/redview-watch /usr/local/share/doc/redview-watch \
    /etc/redview-watch /var/lib/redview-watch /etc/systemd/system/redview-watch*
fi
systemctl daemon-reload
systemctl enable --now redview-watch.timer
systemctl list-timers --no-pager redview-watch.timer
echo "redview-watch installé."
