# redview-watch — surveillance du service rendu

Toutes les 5 minutes, le VPS vérifie ce qu'un utilisateur voit, par les URL
publiques (DNS, TLS, nginx de l'hôte, conteneurs), et envoie un e-mail quand
quelque chose tombe, puis quand c'est rétabli.

Écrit le 07/10/2026 : deux pannes de la veille sont restées 24 h sans que
personne le sache (serveur temps réel « unhealthy », 658 échecs du contrôle
de santé ; « Partagés avec moi » vide pour tous les invités).

## Contrôles

| Contrôle | Échoue quand |
|---|---|
| Application `/health` | pas `{"status":"ok"}` |
| Page d'accueil | pas 200, ou pas l'écran de démarrage `.rv-boot` |
| Serveur temps réel `/multiplayer/health` | pas `{"ok":true}` (sans le service, nginx renvoie l'`index.html` de l'app avec 200) |
| Calcul d'itinéraire | `/api/brouter` ne rend pas de tracé (points décalés à chaque passage : le cache de l'API ne répond pas à la place de BRouter) |
| Météo | `/api/openmeteo` ne vient pas de l'Open-Meteo du VPS, ou la prévision couvre moins de 48 h (synchro arrêtée) |
| POI | `/api/poi?op=health` pas `ok` |
| Appwrite | `/v1/health/version` |
| Traceur d'audience | `/s/x.js` absent |
| Umami, GlitchTip | `/api/heartbeat`, `/_health/` |
| Certificats TLS | un des hôtes expire dans moins de 14 jours (certbot renouvelle à 30) |
| Conteneurs | un conteneur `unhealthy` ou `restarting` |
| Sauvegardes | dernière sauvegarde de plus de 30 h, ou dernier exercice de restauration en échec (`/var/lib/redview-backup/status.json`) |
| Disque | `/` plein à 80 % (alerte tôt : le disque porte toute l’infra, buckets ouverts aux envois des comptes) |
| Plancher mémoire | mémoire utilisée sous 25 % : Oracle récupère une instance Always Free inactive (voir `../README.md`) |

## Alertes

- Une panne est confirmée après **2 échecs d'affilée** (≈ 10 min) : un
  redémarrage de conteneur ou un déploiement n'alerte pas.
- Un e-mail « PANNE » liste toutes les pannes confirmées, un rappel part toutes
  les **6 h** tant qu'elles durent, un e-mail « Rétabli » à la fin.
- Envoi par Resend avec la clé de l'app, lue dans son conteneur à chaque envoi
  (copie de secours `/etc/redview-watch/resend.key` quand l'app est arrêtée) —
  même règle que les sauvegardes.
- **`HEARTBEAT_URL`** (healthchecks.io ou équivalent) reçoit un ping à chaque
  passage, `…/fail` pendant une panne confirmée. C'est le seul moyen d'être
  prévenu quand le VPS lui-même est arrêté, isolé du réseau, ou que ce timer
  ne tourne plus : ce script tourne sur la machine surveillée. Réglage du
  check côté healthchecks.io : période 5 min, grâce 10 min.

## Installation et mise à jour

```bash
scp -r server/vps/watch opc@<vps>:redview-watch-src
ssh opc@<vps> 'sudo bash ~/redview-watch-src/install.sh'
```

`install.sh` est idempotent : il installe le script (`/usr/local/sbin`), les
unités, pose `/etc/redview-watch/watch.env` depuis `watch.env.example` s'il
n'existe pas (jamais écrasé ensuite), remet les contextes SELinux et active le
timer.

## Utilisation

```bash
sudo /usr/local/sbin/redview-watch check       # contrôles affichés, sans alerte ; code 1 si un échoue
sudo /usr/local/sbin/redview-watch status      # pannes en cours, depuis quand, alertes envoyées
sudo /usr/local/sbin/redview-watch test-alert  # e-mail de test
journalctl -u redview-watch -n 100              # passages récents
```

Un contrôle se teste en forçant son seuil dans l'environnement (il l'emporte
sur `watch.env`) : `sudo env MEM_MIN_PCT=95 /usr/local/sbin/redview-watch check`.

## Désinstallation

```bash
sudo systemctl disable --now redview-watch.timer
sudo rm -f /etc/systemd/system/redview-watch.* /usr/local/sbin/redview-watch
sudo rm -rf /usr/local/share/doc/redview-watch /var/lib/redview-watch /etc/redview-watch
sudo systemctl daemon-reload
```
