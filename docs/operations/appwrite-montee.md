# Montée d'Appwrite 1.6.0 → 2.3.0 (production)

> **Fait le 2026-10-08 : la production est en Appwrite 2.3.0** (12:02 → 13:16
> UTC). Répétition complète sur une copie de la sauvegarde du jour, puis
> montée en prod étape par étape avec contrôles. SDK à monter ensuite :
> `node-appwrite` 30.0.0 et `appwrite` 28.1.0 (format de réponse 2.3.0) ; voir
> [appwrite-sdk.md](appwrite-sdk.md).

## Déroulé en production (2026-10-08)

Point de retour : instantané restic `a1a82209` (11:56 UTC : 31 comptes,
2 équipes, 4 adhésions, 120 projets) ; configuration 1.6.0 copiée dans
`/root/appwrite-1.6.0-20261008`. Script des étapes et journaux :
`/root/aw-upgrade/` (`step.sh <version> <précédente>`, `step-<version>.log`).

| Étape | Coupure Appwrite (UTC) | Durée | Remarque |
|---|---|---|---|
| 1.6.2 | 12:07:26 → 12:10:12 | 166 s | `migrate` à court de mémoire PHP (512M, collection `audit`), rejoué 12:12–12:14 avec 2 Go, API déjà en service |
| 1.7.5 | 12:22:26 → ~12:31 | **≈ 8,5 min** | API en 500 (« Unknown resource type ») tant que la migration V22 n'a pas typé les règles de domaine ; le script attendait la santé avant de migrer |
| 1.8.1 | 12:38:51 → 12:41:40 | 169 s | |
| 1.9.6 | 12:51:17 → 12:55:06 | 229 s | V24 puis V25 |
| 2.3.0 | 13:05:48 → 13:09:41 | 233 s | puis 12 s de redémarrage de Traefik (MQTT sur 127.0.0.1) |

Contrôles à chaque étape, identiques à la référence 1.6.0 : projets (120,
2 partagés), lecture d'un projet gz, bucket `project-payloads`, un FIT relu à
l'octet près, miniatures, équipes `p…`, `users.createJWT` + `Account.get`,
préférences ; vrai client web de prod (SDK 17) : connexion, « Partagés avec
moi » (`GET /v1/teams` 200), ouverture d'un projet ; `redview-watch check`
15/15. Après 2.3.0 : `secure-shared-projects --check-documents --all` avec le
SDK 30 (120/120 acceptés, aucun avertissement), cycle complet de suppression
sur un compte jetable (compte et projet supprimés, ligne `account_deletions`),
sauvegarde `5b2434f5` réussie, surcharge nettoyée (`appwrite-assistant`),
`appwrite-embedding` retiré, anciennes images supprimées (disque 76 % : les
images 2.3.0 pèsent ~12 Go de plus que celles de 1.6).

Leçons de la prod, absentes de la répétition :
- la prod contient la collection d'audit (exclue des sauvegardes, donc de la
  copie) : la limite PHP de 512M codée dans `app/init.php` ne suffit pas à
  `migrate`, lancé ici dans un conteneur ponctuel (`docker compose run --rm
  --no-deps --entrypoint sh appwrite -c "sed -i 's/512M/2048M/'
  /usr/src/code/app/init.php; php /usr/src/code/app/cli.php migrate"`) ;
- à partir de 1.7, les requêtes par domaine (`appwrite.redview.tech`) passent
  par les règles : migrer dès que le serveur répond, sans attendre la santé
  par le domaine (la copie était interrogée par son IP, sans règle).

## Répétition (copie jetable)

Copie de la sauvegarde du matin dans un Docker-in-Docker isolé sur le VPS.
**Incident** : les images des six versions ont rempli le disque de l'hôte
(97 %) et dégradé la prod d'environ 11:00 à 11:47 UTC (lenteurs, `/health`
de l'app et contrôle BRouter en échec) ; copie arrêtée et supprimée, tout est
revenu à 15/15. Règle retenue : `df` avant chaque pull (seuil 10 Go) et
suppression des images entre deux étapes.

## Chemin

Guide officiel (self-hosting, « updates ») : chaque version mineure à son
dernier correctif, l'installateur puis `migrate` à chaque étape ; 2.3.0 se
monte depuis 1.9.6 (les notes 2.0, 2.1 et 2.2 s'appliquent).

**1.6.0 → 1.6.2 → 1.7.5 → 1.8.1 → 1.9.6 → 2.3.0**

| Étape | Migration jouée | Coupure mesurée en répétition (`up -d` + `migrate`) | Pull (avant la coupure) |
|---|---|---|---|
| 1.6.2 | V21 | 31 s | 8 s |
| 1.7.5 | V22 | 45 s | 137 s |
| 1.8.1 | V23 | 42 s | 59 s |
| 1.9.6 | **V24 (`--version=1.9.0`) puis V25** | 59 s + ~5 s | 182 s |
| 2.3.0 | V25 (2.0 → 2.3) | 81 s | 297 s |

Coupure cumulée ≈ 4 à 5 min, fenêtre totale ≈ 45 à 60 min (pulls et
contrôles entre les étapes). La table des migrations se lit dans l'image
cible (`src/Appwrite/Migration/Migration.php`) : chaque classe distincte
entre la version de départ et la cible doit être jouée.

## Pièges trouvés en répétition (déjà intégrés aux étapes)

1. **1.9.6 sans V24 → toute l'API en 500** (`Attribute not found in schema:
   resourceType`) : le `migrate` de 1.9.6 ne joue que V25. Jouer
   `migrate --version=1.9.0` puis `migrate --version=1.9.6`.
2. **L'installateur 2.3.0 non interactif remet les ports à 80/443** : Traefik
   prendrait les ports du nginx de l'hôte. Toujours passer
   `--http-port=8082 --https-port=8444`, et vérifier `.env` avant `up -d`.
3. **MQTT 2.3.0 publié sur toutes les interfaces** (8883, 8084) : poser
   `_APP_MQTT_PORT=127.0.0.1:8883` et `_APP_MQTT_WSS_PORT=127.0.0.1:8084`.
4. **`appwrite-embedding` (1,5 Gio)** démarre en 1.9.6 (dépendance stricte
   de dix services) et reste en route après 2.3.0, où il est derrière un
   profil : `docker compose rm -sf appwrite-embedding` une fois en 2.3.0.
5. **Surcharge** (`server/vps/appwrite/docker-compose.override.yml`) :
   `appwrite-assistant` n'existe plus à partir de 1.9 (toléré par compose,
   à retirer à la fin) ; les six autres services coupés existent toujours.
   Les réglages MariaDB (buffer pool 2 Go, `O_DIRECT`) restent appliqués.
6. **1.6.2** : `appwrite-task-stats-resources` plante (montages de
   développement `./app`, `./src` dans le modèle officiel) ; sans effet sur
   l'API, disparaît en 1.7.5. Supprimer ensuite les dossiers vides
   `/opt/appwrite/app` et `/opt/appwrite/src`.
7. **Disque** : chaque image Appwrite pèse 1,7 à 2 Go. La répétition, qui
   gardait les six versions, a rempli le disque de l'hôte (97 %) et dégradé
   la prod ~45 min (2026-10-08, 11:00–11:47 UTC). Ici : contrôle du disque
   avant chaque pull et suppression de l'image précédente après chaque étape.

## Avant

- Fenêtre hors 02:00–05:00 UTC (sauvegarde 02:30, vérification le dimanche
  04:30), un jour où personne n'édite ; annoncer la coupure si besoin.
- **Sauvegarde fraîche et vérifiée** juste avant :
  `sudo /usr/local/sbin/redview-backup run`, puis contrôler l'instantané
  (`redview-restore snapshots`) et les comptes du dump
  (`appwrite-mariadb.sql.meta.json`). Noter l'identifiant de l'instantané :
  c'est le point de retour.
- Copie de `/opt/appwrite` (compose, surcharge, `.env`) dans
  `/root/appwrite-1.6.0-<date>/`.
- `df -h /` ≥ 10 Go libres ; charge (`uptime`) < 4 ; RAM utilisée < 60 % ;
  `redview-watch check` 15/15.
- Surcharge compose : **inchangée pendant la montée**. Retirer
  `appwrite-assistant` dès maintenant le ferait démarrer de 1.6.2 à 1.8.1, où
  il existe encore ; compose tolère l'entrée une fois le service disparu
  (vérifié en 1.9.6 et 2.3.0). Elle est nettoyée et commitée à la fin.
- Référence de contrôle relevée sur la prod (lecture seule) : projets,
  lecture d'un projet gz, bucket `project-payloads`, un FIT, miniatures,
  équipes `p…`, `users.createJWT` + `Account.get`, préférences.

## Une étape (vers `V`)

```bash
cd /opt/appwrite
df -h / | tail -1                     # ≥ 10 Go libres, sinon arrêt
mkdir -p /root/appwrite-avant-$V && cp -a docker-compose.yml docker-compose.override.yml .env /root/appwrite-avant-$V/
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/appwrite:/usr/src/code/appwrite:rw --entrypoint=upgrade appwrite/appwrite:$V \
  --interactive=N --no-start=true --http-port=8082 --https-port=8444
grep -E '^_APP_HTTPS?_PORT' .env        # 8082 / 8444, sinon corriger avant d'aller plus loin
docker compose config -q                 # surcharge compatible
docker compose pull -q                   # l'ancienne version tourne encore ; df -h / chaque minute, arrêt sous 10 Go
docker compose up -d --remove-orphans    # début de la coupure
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082/v1/health/version)" != 000 ]; do sleep 2; done
# migrer tout de suite (≥ 1.7 : le domaine ne répond pas avant), limite PHP relevée
docker compose run --rm --no-deps -T --entrypoint sh appwrite -c \
  "sed -i 's/512M/2048M/' /usr/src/code/app/init.php; php /usr/src/code/app/cli.php migrate"
#   1.9.6 : migrate --version=1.9.0 puis migrate --version=1.9.6
curl -s -H "Host: appwrite.redview.tech" http://127.0.0.1:8082/v1/health/version   # {"version":"V"}
docker compose ps -a                     # tout « running » (sauf le cas 6 en 1.6.2)
docker image rm appwrite/appwrite:<version précédente>   # libérer le disque
```

Contrôles entre deux étapes : API 200 (`/v1/health/version` = V), la
référence ci-dessus (mêmes résultats, aucun avertissement : un projet et son
gz, un FIT, équipes `p…`, `users.createJWT` + `Account.get`), connexion à
l'app et ouverture d'un projet partagé ; `df`, RAM et charge notés. **Au premier écart : arrêt** et décision (corriger ou revenir).

## Après 2.3.0

1. `docker compose rm -sf appwrite-embedding` ; ports MQTT sur 127.0.0.1
   (`.env`), `docker compose up -d`.
2. Surcharge : retirer `appwrite-assistant` (dépôt + hôte), `docker compose
   config -q`.
3. Images et volumes inutiles : `docker image prune` (anciennes versions,
   console, executor), dossiers vides `app/` et `src/`.
4. SDK 30 / 28 commités et app + temps réel déployés (session pair).
5. `redview-watch check`, `bench:collab-prod`, contrôles de la référence
   avec les SDK 30 ; `secure-shared-projects --check-documents --all`,
   `fit-orphans` (lecture seule).
6. Sauvegarde : `redview-backup run` puis vérifier le dump (mêmes noms de
   conteneurs : `appwrite-mariadb` ; volumes `uploads`, `config`,
   `certificates`, `functions` toujours présents ; le volume des builds est
   renommé par la migration d'infrastructure 2.0.0). Les données ClickHouse
   (exécutions, statistiques) ne sont pas sauvegardées, comme les audits.
7. Mettre à jour `server/vps/README.md` (version, services) et
   `docs/operations/appwrite-sdk.md`.

## Ressources

Pile 2.3.0 sans embedding ≈ 3 Go de RAM contre ≈ 2 Go en 1.6 (ClickHouse
~380 Mo, navigateur ~150 Mo, orchestrator, mqtt, geo, autogravity, jobs,
notifications). L'hôte reste sous 60 % de RAM utilisée et au-dessus du
plancher Always Free (25 %).

## Retour arrière

Les migrations ne se défont pas : le retour est une **restauration 1.6.0**
depuis l'instantané pris à l'étape « Avant » (`server/vps/backup/README.md`,
« Reprise après sinistre »). La base et Redis repartent vides puis reçoivent
le dump : aucune table ni file d'attente de la 2.x ne reste.

```bash
cd /opt/appwrite
docker compose down --remove-orphans                 # toute la pile 2.x arrêtée
docker volume rm appwrite_appwrite-mariadb appwrite_appwrite-redis
sudo /usr/local/sbin/redview-restore fetch <instantané> /srv/redview-restore
sudo /usr/local/sbin/redview-restore appwrite /srv/redview-restore --force
#   remet compose + surcharge + .env 1.6.0, tire les images 1.6.0, recrée les
#   volumes, recopie uploads/config/certificates/functions, importe le dump, up -d
curl -s http://127.0.0.1:8082/v1/health/version      # {"version":"1.6.0"}
```

Puis la référence de contrôle et `redview-watch check`. Les écritures faites
entre la sauvegarde et le retour sont perdues : d'où la fenêtre sans édition.
Les volumes propres à la 2.x (ClickHouse, modèles d'embedding, builds
renommés) se suppriment ensuite à la main. L'app reste sur les SDK 16 / 17
tant que les SDK 30 / 28 ne sont pas commités.

## Non vérifié en répétition (fait en prod après la montée)

Le rejeu des documents et la suppression d'un compte n'ont pas pu aller au
bout en répétition (copie arrêtée par l'incident de disque). Après 2.3.0 :
`secure-shared-projects --check-documents --all` (lecture seule), puis un
cycle complet de suppression sur un compte jetable créé pour l'occasion
(création, projet, `updateStatus(false)`, purge `deleteAccount`,
vérification : compte et projet supprimés, ligne `account_deletions`).
