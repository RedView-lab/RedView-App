# Sauvegardes du VPS et reprise après sinistre

Le VPS Oracle (Always Free, une seule machine) porte toute la production :
Appwrite et sa base, Coolify et les apps, le serveur temps réel, BRouter, POI,
météo, nginx et ses certificats, GlitchTip, Umami. Oracle peut récupérer une
instance Always Free. Ce dossier garantit qu'on ne perd rien et qu'on
reconstruit ailleurs.

**En bref**

- Chaque nuit à 02:30 UTC (à ±10 min près), un instantané chiffré de tout le
  serveur part sur Google Drive (dossier `RedView-Restic`, compte Drive de
  5 To).
- Chaque dimanche à 04:30 UTC : relecture d'une partie du dépôt, puis
  restauration réelle des bases dans des conteneurs jetables, avec comparaison
  ligne à ligne et octet à octet. Le rapport arrive par e-mail.
- Tout échec, ou toute sauvegarde qui fond anormalement, envoie un e-mail à
  `runningsimon65@gmail.com`.
- Sans e-mail le lundi, quelque chose ne tourne plus (voir « Diagnostic »).

Installé le 2026-10-07. Il remplace l'ancien `/etc/cron.d/redview-backup`, qui
n'a jamais tourné du 21/09 au 07/10/2026 : son fichier portait le contexte
SELinux `user_tmp_t` et crond le refusait en silence. Ses archives étaient de
plus envoyées en clair sur un Drive ouvert en entier. Il a été supprimé avec
ses archives.

## Ce qui est sauvegardé

| Quoi | Comment | Pourquoi |
|---|---|---|
| Base Appwrite (MariaDB : comptes, projets, vues, journal de co-édition, facturation) | dump logique `--single-transaction` dans le conteneur, mot de passe lu sur place | cohérent sans arrêter la base |
| Bases Coolify, GlitchTip, Umami (PostgreSQL) | `pg_dump --no-owner --no-privileges` dans chaque conteneur | se recharge dans n'importe quel conteneur neuf |
| Fichiers Appwrite (FIT, miniatures, charges utiles, points de sauvegarde collab), config et certificats Appwrite | volumes `appwrite_appwrite-{uploads,config,certificates,functions}` | |
| `/opt/appwrite` : compose, override, **`.env`** | fichiers | `_APP_OPENSSL_KEY_V1` du `.env` est indispensable : sans elle, les fichiers restaurés sont illisibles |
| `/data/coolify` : **`source/.env`** (APP_KEY), clés SSH, config des apps | fichiers | APP_KEY déchiffre les variables d'environnement des apps stockées dans la base Coolify |
| `/etc` entier : nginx (+ `conf.d/app.conf`), Let's Encrypt, unités systemd, sysctl, docker, firewalld, SSH | fichiers | la configuration de l'hôte |
| `/opt/brouter` (segments 1,8 Go), `/opt/poi-server` (base 810 Mo), `/opt/redview-weather`, `/usr/local`, `/root`, `/home/opc` (sans caches) | fichiers | rebâtir la base POI prend des heures |
| GlitchTip (pièces jointes), Beszel | fichiers | |
| **Manifeste système** : paquets, unités actives, conteneurs, images avec digests, `docker inspect` complet, réseaux, pare-feu, SELinux, disques | généré avant chaque sauvegarde (`/var/lib/redview-backup/manifest`) | la description exacte de la machine à reconstruire |

**Exclusions, et pourquoi :**

- Table d'audit d'Appwrite (`_1_audit`, ainsi que `_console_audit` et les
  compteurs anti-abus) : seule sa structure est sauvegardée. Elle pesait
  4,46 Go sur 4,7 Go de base, parce que chaque sauvegarde automatique d'un
  projet y recopie le document ; Appwrite la purge après 14 jours. Le dump est
  passé de 3,2 Go à 51 Mo.
- Fichiers bruts des bases : on sauvegarde les dumps, pas les fichiers en
  cours d'écriture.
- Tuiles météo (`/var/www/weather`, 1,2 Go) : régénérées par l'ingest.
- Données Open-Meteo (volume `open-meteo_open-meteo-data`, ~1,9 Go) :
  retéléchargées par les synchros depuis les données ouvertes Météo-France
  (`/opt/open-meteo/docker-compose.yml`, sauvegardé, identique à
  `server/vps/open-meteo/`) ; prévisions de retour en quelques minutes,
  62 jours d'historique du modèle de neige en quelques heures.
- Images Docker : le manifeste garde leurs digests, on les retélécharge.
- Caches (npm, gradle, restic).

Listes exactes : `paths.txt` et `excludes.txt`.

## Chiffrement, rétention, vérifications

- **restic 0.19** (paquet EPEL signé) : dépôt chiffré AES-256 et authentifié,
  dédupliqué et compressé (zstd), en paquets de 64 Mio. Le premier instantané
  a envoyé 2,6 Gio, les suivants n'envoient que les changements.
- **Transport** : rclone vers Google Drive. Google ne voit que des blocs
  chiffrés.
- **Rétention** : 7 quotidiennes, 5 hebdomadaires, 12 mensuelles (`forget`
  chaque nuit, `prune` le dimanche). Les données d'un compte supprimé (RGPD)
  disparaissent donc des sauvegardes au plus tard 12 mois après.
- **Contrôle hebdomadaire** (`redview-backup verify`) :
  1. `restic check --read-data-subset n/12` relit 1/12 des données chaque
     semaine, donc tout le dépôt en 12 semaines.
  2. Exercice de restauration sur le dernier instantané :
     - la base Appwrite est rechargée dans un MariaDB jetable (tmpfs, sans
       réseau, même image) ; le nombre de lignes des tables clés (comptes,
       équipes, toutes les collections) est comparé au relevé fait juste
       après le dump ;
     - chaque base PostgreSQL est rechargée de la même façon ; chaque table
       doit avoir exactement les lignes de son dump ;
     - 40 fichiers Appwrite tirés au hasard et inchangés depuis l'instantané
       sont restaurés et comparés **octet pour octet** au disque ;
     - la présence des fichiers critiques est vérifiée (les deux `.env`,
       `app.conf`, certificats, unités, données POI et BRouter, manifeste).
  3. Le rapport part par e-mail.
- **Anomalies** : si un instantané ou un dump fond de plus de 30 % d'un jour
  à l'autre (volume vidé, table tronquée, rançongiciel), c'est une alerte, et
  l'instantané est quand même gardé.

## Alertes

- Les unités `redview-backup.service` et `redview-backup-verify.service` ont
  `OnFailure=redview-backup-alert@…`, qui envoie le statut et les 120
  dernières lignes du journal. Cette chaîne a été testée par un échec
  volontaire le 2026-10-07.
- L'envoi passe par **Resend**, avec la clé de l'app, lue dans son conteneur
  au moment de l'envoi (une rotation de clé est suivie d'elle-même). Une
  copie de secours est gardée dans `/etc/redview-backup/resend.key` pour le
  cas où l'app est arrêtée.
- **Ce que ça ne détecte pas** : une machine éteinte ou détruite n'envoie
  plus rien. Deux filets :
  - le rapport du lundi : s'il n'arrive pas, enquêter ;
  - mieux, un « heartbeat » externe gratuit : créer un check sur
    healthchecks.io (période 1 jour, grâce 2 h), puis le mettre dans
    `HEARTBEAT_URL` de `/etc/redview-backup/backup.env`. Le site prévient
    quand la sauvegarde ne l'appelle plus. Non fait : cela demande la
    création d'un compte.

## Commandes

Sur le VPS (`sudo` n'a pas `/usr/local/sbin` dans son PATH sous Oracle Linux) :

```bash
sudo /usr/local/sbin/redview-backup status       # âges, tailles, dernier exercice
sudo /usr/local/sbin/redview-backup snapshots    # instantanés
sudo systemctl start redview-backup              # sauvegarde maintenant (journal : journalctl -u redview-backup -f)
sudo systemctl start redview-backup-verify       # contrôle + exercice + rapport maintenant
sudo /usr/local/sbin/redview-backup drill        # exercice seul (~4 min)
sudo /usr/local/sbin/redview-backup test-alert   # e-mail de test
sudo /usr/local/sbin/redview-backup restic …     # restic brut avec la config du dépôt (ls, find, diff, stats…)
systemctl list-timers 'redview-backup*'
```

Récupérer un fichier précis, par exemple `app.conf` d'il y a 3 jours :
`sudo /usr/local/sbin/redview-backup restic snapshots`, puis
`sudo /usr/local/sbin/redview-backup restic restore <id> --target /tmp/r --include /etc/nginx/conf.d/app.conf`.

## Kit de reprise (hors du VPS)

Sans ces éléments, les sauvegardes sont inutilisables. À garder ailleurs que
sur le VPS :

1. **Mot de passe du dépôt restic**. Il a été généré sur le PC de dev dans
   `~/.redview/backup/restic-password` (hors du dépôt git). **À copier dans
   un gestionnaire de mots de passe.** S'il est perdu, tout est perdu.
2. **Accès au dépôt** : `~/.redview/backup/rclone.conf` sur le PC de dev
   (remote `gdrive-backup`, jeton limité aux fichiers créés par rclone), ou
   le compte Google `runningsimon65@gmail.com` pour refaire l'autorisation
   (voir « Accès Google Drive »).
3. Ce dépôt git (scripts et runbook).
4. Accès au DNS de `redview.tech` (bascule des enregistrements A), à GitHub
   (Coolify reconstruit les apps depuis le dépôt), à Stripe, Resend et Google
   Cloud.

## Reprise après sinistre (nouveau serveur)

Cible : un serveur Linux neuf (Oracle Linux 9, RHEL 9 ou Ubuntu 24.04,
arm64 ou x86_64, au moins 4 vCPU, 16 Go de RAM et 80 Go de disque), avec un
accès root.

**Ce qui a été vérifié :**
- la restauration des bases et des fichiers, chaque semaine, dans des
  conteneurs jetables ;
- la présence de tout ce qu'il faut pour reconstruire.

**Ce qui n'a pas encore été répété de bout en bout :** les étapes 4 à 8 sur
une machine vierge. Les commandes viennent de la documentation d'Appwrite et
de Coolify et de la configuration réelle (manifeste). Les durées sont des
estimations.

1. **Outils** (~5 min) : Docker (`dnf install docker-ce` ou le script
   officiel), puis `install.sh --no-timers` de ce dossier, qui installe
   restic, rclone, `redview-backup` et `redview-restore`.
2. **Accès au dépôt** : poser `/etc/redview-backup/restic-password` et
   `/etc/redview-backup/rclone.conf` (les deux en 0600, depuis le kit), et
   `backup.env` (modèle `backup.env.example`). Vérifier :
   `sudo /usr/local/sbin/redview-restore snapshots`.
3. **Tout rapatrier** (~10 min pour 3,5 Go) :
   `sudo /usr/local/sbin/redview-restore fetch latest /srv/redview-restore`,
   puis `sudo /usr/local/sbin/redview-restore manifest` pour voir ce qui
   tournait (conteneurs, images, unités, tailles).
4. **Appwrite** (~10 min) : `sudo /usr/local/sbin/redview-restore appwrite`.
   La commande remet `/opt/appwrite` avec son `.env`, crée les volumes, y
   copie les fichiers, charge la base, démarre et lance `doctor`.
5. **Hôte** : `redview-restore files /srv/redview-restore /etc/nginx /etc/letsencrypt /etc/systemd/system/brouter.service /etc/systemd/system/poi-server.service /etc/systemd/system/redview-weather.service /etc/systemd/system/redview-weather.timer /opt/brouter /opt/poi-server /opt/redview-weather /etc/sysctl.d/90-redview.conf /etc/docker/daemon.json`.
   Installer ensuite Java 17+ (BRouter), Node 22 (POI), Python 3 (météo) et
   nginx, puis `systemctl daemon-reload` et
   `systemctl enable --now brouter poi-server redview-weather.timer nginx`.
   Ne pas recopier `/etc` en entier : fstab, réseau et noyau sont propres à
   chaque machine. Prendre au cas par cas ce que le manifeste montre (règles
   firewalld, contextes SELinux).
6. **Coolify** (~20 min, d'après la procédure officielle) :
   - installer la **même version** (manifeste, `images.txt` : 4.3.23) avec
     `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash -s 4.3.23` ;
   - arrêter `coolify`, `coolify-realtime` et `coolify-proxy` (garder
     `coolify-db`) ;
   - `redview-restore postgres /srv/redview-restore/var/lib/redview-backup/staging/coolify-db.sql coolify-db` ;
   - dans `/data/coolify/source/.env`, mettre l'ancienne `APP_KEY`
     (`/srv/redview-restore/data/coolify/source/.env`) dans
     `APP_PREVIOUS_KEYS` ;
   - remettre `/data/coolify/ssh/keys` et ajouter la clé publique de Coolify
     à `/root/.ssh/authorized_keys` ;
   - relancer le script d'installation ;
   - dans l'interface, revalider le serveur « localhost » puis redéployer
     `redview-app`, `redview-multiplayer` et le site vitrine (builds depuis
     GitHub).
7. **GlitchTip, Umami, Beszel** : remettre `/home/opc/services/<nom>`,
   `docker compose up -d` (avec `docker compose up -d <db>` d'abord), puis
   `redview-restore postgres …/glitchtip-db.sql glitchtip-db` (idem pour
   `umami-db`). Ces services sont secondaires : ils peuvent attendre.
8. **Bascule** : enregistrements A de `app`, `appwrite`, `errors`,
   `analytics` et du site vitrine vers la nouvelle IP. Ensuite
   `certbot renew`, puis vérifier `https://app.redview.tech`,
   `/multiplayer/health` (JSON `{"ok":true}`, le SPA répond 200 à tout le
   reste) et une connexion avec ouverture de projet.
9. **Sauvegardes** : `install.sh` sans `--no-timers`, en gardant
   `RESTIC_HOST=redview-vps` pour que l'historique continue.
10. **RGPD** : voir la section suivante.

### Après une restauration : rejouer les suppressions de compte

Restaurer un instantané fait revenir les comptes supprimés depuis cet
instantané. Le registre `account_deletions` restauré connaît les suppressions
antérieures. Lancer depuis un poste qui a la clé API :

```bash
npx tsx --env-file=.env scripts/appwrite/account-deletions.ts --reapply
```

Les suppressions faites entre l'instantané et le sinistre (moins de 24 h)
sont dans les journaux de l'app (`[account-deletion] compte supprimé <id>`).
Si la machine est perdue, ces journaux le sont aussi. Il reste alors l'accusé
de suppression envoyé à la personne, à retraiter à sa demande.

## Diagnostic

- **Pas de rapport le lundi** :
  `systemctl list-timers 'redview-backup*'` (timers actifs ?),
  `systemctl status redview-backup redview-backup-verify`,
  `journalctl -u redview-backup --since -3d`.
- **`rateLimitExceeded` dans le journal** : quota de l'API Drive du projet
  Google Cloud ; restic réessaie seul. Rare depuis le client OAuth dédié.
- **`invalid_grant` / jeton expiré ou révoqué** : refaire l'autorisation
  (section suivante, « Refaire l'autorisation »).
- **Fichier refusé par systemd ou crond** : `ls -Z`, puis `restorecon -RF`
  sur le fichier (c'est ce qui avait tué l'ancien cron).
- **Dépôt verrouillé après un arrêt brutal** :
  `sudo /usr/local/sbin/redview-backup restic unlock`.

## Accès Google Drive

Depuis le 2026-10-07, rclone passe par un **client OAuth propre à RedView**
(projet Google Cloud `redview-backups-e4b0c9` du compte
`runningsimon65@gmail.com`, application publiée, type « Application de
bureau ») avec le scope **`drive.file`** : le jeton du VPS ne voit que les
fichiers que rclone a créés (le dossier `RedView-Restic`), pas le reste du
Drive. Remote `gdrive-backup` dans `/etc/redview-backup/rclone.conf` ; copie
de reprise sur le PC de dev, `~/.redview/backup/rclone.conf`.

Il remplace l'ancien jeton de root (identifiant client partagé de rclone,
retiré par rclone courant 2026, scope `drive` sur tout le Drive). L'historique
a été copié (`restic copy`, mêmes paramètres de découpage), contrôlé par un
exercice de restauration, puis l'ancien dossier `RedView-Backups` est parti à
la corbeille du Drive et l'ancien jeton a été supprimé du VPS. Pour couper ce
jeton partout : compte Google → Sécurité → « Applications tierces » →
« rclone » → supprimer l'accès (l'application « RedView Backups » doit rester).

**Refaire l'autorisation** (jeton révoqué, nouveau serveur, `invalid_grant`) :

1. Sur un PC avec navigateur, rclone installé :
   `rclone authorize drive <base64 de {"client_id":"…","client_secret":"…","scope":"drive.file"}, sans « = » final>`
   (ID et secret : console Google Cloud → projet `redview-backups-e4b0c9` →
   Google Auth Platform → Clients → `rclone VPS`). Choisir le compte
   `runningsimon65@gmail.com` ; « Google n'a pas validé cette application »
   est normal (Paramètres avancés → Accéder à RedView Backups).
2. Avec le jeton affiché, écrire la section `[gdrive-backup]` (`type = drive`,
   `client_id`, `client_secret`, `scope = drive.file`, `token = …`) dans
   `/etc/redview-backup/rclone.conf` (0600), puis `restorecon -F` dessus.
3. Vérifier : `sudo /usr/local/sbin/redview-backup snapshots`.

Le même client OAuth est indispensable : avec `drive.file`, un autre client
ne verrait pas les fichiers du dépôt (il faudrait alors le scope `drive`).

## Installation et mise à jour

Depuis un poste avec ce dépôt :

```bash
tar -cf - -C server/vps backup | ssh -i ~/.ssh/oracle_brouter.key opc@141.145.220.99 \
  'rm -rf ~/redview-backup-src && mkdir ~/redview-backup-src && tar -xf - -C ~/redview-backup-src && sudo bash ~/redview-backup-src/backup/install.sh'
```

`install.sh` est idempotent :
- il installe restic, les scripts (`/usr/local/sbin`), les listes et les
  unités ;
- il remet les contextes SELinux et crée le dépôt s'il manque ;
- il active les timers ;
- il n'écrase jamais `/etc/redview-backup/backup.env`.

Première installation : poser d'abord le mot de passe, sans qu'il passe sur
la ligne de commande :
`ssh … 'sudo install -d -m 700 /etc/redview-backup && sudo sh -c "umask 077; cat > /etc/redview-backup/restic-password"' < ~/.redview/backup/restic-password`.

## Choix et raisons

- **Pas d'image disque.** Une image du volume de boot Oracle ne redémarre pas
  chez un autre hébergeur (noyau, cloud-init, arm64 contre x86), pèse 83 Go
  et serait incohérente si elle était prise à chaud. La reprise repose plutôt
  sur des dumps cohérents, des fichiers, un manifeste exact et ce runbook.
  En complément facultatif, chez Oracle : une politique de sauvegarde du
  volume de boot (Always Free : 5 sauvegardes de volume gratuites). Elle
  permet un retour rapide dans le même compte, mais ne protège pas contre la
  perte du compte.
- **restic plutôt que des archives `tar`** : chiffrement, déduplication
  (7 + 5 + 12 instantanés pour à peine plus que la taille d'un seul),
  vérification d'intégrité intégrée et restauration fichier par fichier.
- **Exercice automatique plutôt que confiance.** Une sauvegarde jamais
  restaurée ne compte pas. L'ancien cron a montré qu'un mécanisme muet peut
  être mort pendant des semaines.

## Mesures du 2026-10-07 (premier instantané `bb557280`)

| | |
|---|---|
| Données lues | 3,5 Gio, 11 399 fichiers |
| Envoyé (chiffré, compressé) | 2,6 Gio en 812 s (premier envoi, freiné par le quota de l'identifiant partagé) |
| Dumps | Appwrite 51 Mo, Coolify 29 Mo, Umami 8,9 Mo, GlitchTip 1,4 Mo |
| Pic mémoire du service | 1,2 Go (limite 3 Go) |
| Exercice de restauration | réussi en 255 s : 11 tables clés Appwrite, 65 + 259 + 25 tables PostgreSQL identiques au dump, 40 fichiers identiques octet pour octet |
