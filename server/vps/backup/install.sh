#!/usr/bin/env bash
# install.sh — installe ou met à jour redview-backup sur un serveur (root).
# Idempotent : relancer après chaque modification de server/vps/backup/.
#
#   sudo bash install.sh              installe, crée le dépôt s'il n'existe pas, active les timers
#   sudo bash install.sh --no-timers  idem sans activer les timers (reprise en cours sur un nouveau serveur)
#
# Avant le premier lancement : /etc/redview-backup/restic-password (0600) et la
# configuration rclone désignée par RCLONE_CONFIG (voir README.md, « Installation »).

set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo bash "$0" "$@"
cd "$(dirname "$0")"

timers=1
[[ ${1:-} == --no-timers ]] && timers=0

# restic : paquet signé de la distribution (EPEL sur Oracle Linux 9), sinon le
# binaire officiel vérifié par SHA-256 (version épinglée).
readonly RESTIC_VERSION=0.19.1
declare -A RESTIC_SHA256=(
  [arm64]=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465
  [amd64]=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
)
install_restic() {
  command -v restic > /dev/null && return 0
  if command -v dnf > /dev/null && dnf -y -q install restic; then return 0; fi
  if command -v apt-get > /dev/null && apt-get install -y -q restic && restic version | grep -qE 'restic 0\.(1[7-9]|[2-9][0-9])'; then return 0; fi
  local arch tmp
  case $(uname -m) in aarch64 | arm64) arch=arm64 ;; x86_64) arch=amd64 ;; *) echo "architecture non prévue : $(uname -m)" >&2; exit 1 ;; esac
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/restic.bz2" "https://github.com/restic/restic/releases/download/v$RESTIC_VERSION/restic_${RESTIC_VERSION}_linux_$arch.bz2"
  echo "${RESTIC_SHA256[$arch]}  $tmp/restic.bz2" | sha256sum -c -
  bunzip2 "$tmp/restic.bz2"
  install -m 0755 "$tmp/restic" /usr/local/bin/restic
  rm -rf "$tmp"
}
install_restic
command -v rclone > /dev/null || { curl -fsSL https://rclone.org/install.sh | bash; }
for bin in jq curl docker openssl flock numfmt shuf; do
  command -v "$bin" > /dev/null || { echo "outil manquant : $bin" >&2; exit 1; }
done

install -D -m 0755 redview-backup /usr/local/sbin/redview-backup
install -D -m 0755 redview-restore /usr/local/sbin/redview-restore
install -D -m 0644 README.md /usr/local/share/doc/redview-backup/README.md
install -d -m 0700 /etc/redview-backup /var/lib/redview-backup /var/cache/redview-backup
[[ -e /etc/redview-backup/backup.env ]] || install -m 0600 backup.env.example /etc/redview-backup/backup.env
install -m 0600 paths.txt /etc/redview-backup/paths
install -m 0600 excludes.txt /etc/redview-backup/excludes
install -m 0644 systemd/redview-backup.service systemd/redview-backup.timer \
  systemd/redview-backup-verify.service systemd/redview-backup-verify.timer \
  systemd/redview-backup-alert@.service /etc/systemd/system/
# SELinux : un fichier copié garde le contexte de sa source (user_tmp_t depuis
# /tmp) et crond/systemd le refusent — c'est ce qui a tenu l'ancien cron de
# sauvegarde à l'arrêt du 21/09 au 07/10/2026. On remet les contextes par défaut.
if command -v restorecon > /dev/null; then
  restorecon -RF /usr/local/sbin/redview-backup /usr/local/sbin/redview-restore /usr/local/share/doc/redview-backup \
    /etc/redview-backup /var/lib/redview-backup /var/cache/redview-backup /etc/systemd/system/redview-backup*
fi
systemctl daemon-reload

if [[ ! -s /etc/redview-backup/restic-password ]]; then
  echo "Mot de passe du dépôt absent : poser /etc/redview-backup/restic-password (0600), voir README.md." >&2
  exit 1
fi
if ! /usr/local/sbin/redview-backup restic cat config > /dev/null 2>&1; then
  echo "Dépôt absent : création."
  /usr/local/sbin/redview-backup restic init --repository-version 2
fi

if (( timers )); then
  systemctl enable --now redview-backup.timer redview-backup-verify.timer
  systemctl list-timers --no-pager 'redview-backup*'
fi
echo "redview-backup installé."
