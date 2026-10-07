# RedView — Runbook de durcissement sécurité (2026-10)

Ordre de mise en production des correctifs de l'audit sécurité. Chaque étape
est indépendante et réversible ; respecter l'ordre 1 → 2 (miniatures).

## 0. Déjà appliqué en production
- Bucket Appwrite `itinerary-fit-files` : permissions bucket réduites à
  `create("users")` (avant : `read/update/delete("users")` → tout utilisateur
  connecté pouvait lire/supprimer les FIT de tous). Les 96 fichiers gardent
  leurs permissions `user:<owner>`. Rollback : remettre les 4 permissions via
  `PUT /storage/buckets/itinerary-fit-files`.

## 1. Déployer l'app
`npm run deploy "fix(security): ..."` (après revue du diff).
Smoke test : connexion, ouverture d'un projet, carte 3D, radar météo, POI
corridor, calcul d'itinéraire, prédiction FIT, inscription (code à 6 chiffres),
déconnexion.

## 2. Appwrite — miniatures (APRÈS l'étape 1)
Le nouveau frontend crée les miniatures en `Role.user` et les affiche via le
SDK authentifié. Ensuite seulement :
```bash
node scripts/appwrite/audit-appwrite-permissions.mjs            # état avant
node scripts/appwrite/patch-security-schema.mjs                 # buckets → create("users") seulement
node scripts/appwrite/migrate-thumbnail-permissions.mjs         # dry-run
node scripts/appwrite/migrate-thumbnail-permissions.mjs --apply # read("any") → read("user:<owner>")
node scripts/appwrite/audit-appwrite-permissions.mjs            # doit afficher « Aucune permission trop large »
```

## 3. VPS (141.145.220.99) — `ssh -i ~/.ssh/oracle_brouter.key opc@141.145.220.99`
Constats (2026-10-01) : seuls 22/80/443 sont joignables depuis Internet
(security list Oracle) ; mais nginx :80 publiait **Coolify en HTTP clair**
(`http://141.145.220.99/` → `/login`) et **`/poi/`** publiquement.

### 3a. POI server (Fastify 5 → Node ≥ 20 requis : `node -v`)
```bash
sudo cp -a /opt/poi-server /opt/poi-server.bak-$(date +%F)
# copier server/poi-server/{server.js,db.js,viewport-sampler.js,package.json,package-lock.json}
cd /opt/poi-server && sudo npm ci --omit=dev
# unité systemd : Environment=POI_HOST=127.0.0.1  Environment=NODE_ENV=production (=> base en lecture seule)
sudo systemctl restart poi-server && curl -s 127.0.0.1:17778/health
curl -s "127.0.0.1:17778/bbox?south=-90&west=-180&north=90&east=180&limit=-1" | head -c 200   # ≤ 1 résultat
```

### 3b. nginx (serveur par défaut :80)
```bash
sudo cp -a /etc/nginx /etc/nginx.bak-$(date +%F)
sudo grep -rl "default_server" /etc/nginx/conf.d/          # fichier à remplacer
# installer server/weather-daemon/redview-internal-only.conf -> /etc/nginx/redview-internal-only.conf
# remplacer le fichier default_server par server/weather-daemon/brouter.conf
sudo nginx -t && sudo systemctl reload nginx
```
Vérifier depuis l'extérieur : `curl -I http://141.145.220.99/` → 404,
`curl -I http://141.145.220.99/poi/health` → 403 ; et dans l'app : POI,
routage et météo fonctionnent toujours (l'app y accède depuis l'hôte).
Si l'app reçoit 403 : `sudo tail /var/log/nginx/access.log` pour voir l'IP
source réelle du conteneur et l'ajouter à `redview-internal-only.conf`.

Coolify ensuite uniquement par tunnel :
`ssh -i ~/.ssh/oracle_brouter.key -L 8000:127.0.0.1:8000 -L 6001:127.0.0.1:6001 -L 6002:127.0.0.1:6002 opc@141.145.220.99`
→ http://localhost:8000. Mettre Coolify à jour (4.3.23 installé).

### 3c. Ingest météo sans root
```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin redview-weather
sudo chown -R redview-weather:redview-weather /var/www/weather
sudo cp server/weather-daemon/redview-weather.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl start redview-weather.service
journalctl -u redview-weather.service -n 50   # vérifier que l'ingest réussit
```

### 3d. Défense en profondeur (recommandé)
- Publier les ports Docker sur `127.0.0.1` au lieu de `0.0.0.0` (app 3000,
  3002, Coolify 8000/6001/6002, Traefik Appwrite 8082/8444) : aujourd'hui
  seule la security list Oracle les protège.
- BRouter écoute sur `*:17777` : lui passer l'adresse de bind `127.0.0.1`
  (dernier argument de `RouteServer`).
- `beszel.141.145.220.99.sslip.io` est servi en HTTP clair : passer en HTTPS
  ou le retirer d'nginx (accès par tunnel).
- Restreindre SSH (22) à vos IP dans la security list Oracle.

## 4. Consoles tierces (manuel)
- Mapbox : restreindre le token public aux URL `https://app.redview.tech/*`.
- Coolify → variables d'env de l'app : `STRIPE_WEBHOOK_SECRET` réel (le `.env`
  local contient un placeholder) ; `WEATHER_UPSTREAM` défini (plus de valeur
  par défaut codée en dur).
- Umami : plus de recorder (replay retiré le 2026-10-07) ; mesure anonyme first-party, filtrée par `beforeSend.ts` (docs/analytics/measurement.md).

## 5. Co-édition (audit du 2026-10-06)
Détail des failles et des règles : section 14 de `docs/architecture/collab-realtime.txt`.
1. Déployer (serveur temps réel puis app, protocole 4 : les onglets restés en
   protocole 3 voient « rechargez la page »).
2. Mettre en conformité les projets partagés (l'ancien format donnait
   l'écriture de la ligne à l'équipe) :
   `npx tsx --env-file=.env scripts/appwrite/secure-shared-projects.ts` (à sec), puis
   `--apply`, puis `--check-documents --all` (chaque document passe la
   validation du serveur). Rollback d'une ligne : remettre
   `update("team:p<projet>")` à ses permissions (console Appwrite).
3. nginx : `server/vps/nginx-multiplayer.conf` (zones `limit_conn` /
   `limit_req` en tête de `/etc/nginx/conf.d/app.conf`, `location`s
   `= /multiplayer` et `/multiplayer/`) ; sauvegarde datée, `nginx -t`,
   `systemctl reload nginx`. Rollback : remettre la sauvegarde, recharger.
4. Coolify (manuel) : `MULTIPLAYER_INTERNAL_SECRET` (≥ 32 car., `openssl rand
   -hex 32`) identique sur l'app et sur `redview-multiplayer`, et
   `MULTIPLAYER_INTERNAL_URL=https://app.redview.tech/multiplayer` sur l'app,
   puis redéployer les deux : retrait d'un éditeur appliqué tout de suite
   (sans : en ≤ 15 s par la revérification périodique).
5. Console Appwrite (manuel) : clé API du serveur temps réel réduite aux
   droits utiles (bases : lecture/écriture des documents ; stockage :
   lecture/écriture des fichiers ; équipes : lecture).
6. Vérifier : `npm run bench:collab-prod` (deux comptes de test réels).
