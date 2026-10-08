# SDK Appwrite alignés sur le serveur 2.3

> Règle (2026-10-08) : les deux SDK suivent la version du serveur Appwrite de
> production, pas la dernière version publiée. On ne les monte qu'avec le
> serveur ([appwrite-montee.md](appwrite-montee.md)).

## État

| | Version | Format de réponse |
|---|---|---|
| Serveur de production | **Appwrite 2.3.0** (monté depuis 1.6.0 le 2026-10-08) | 2.3.0 |
| `node-appwrite` (API, scripts, serveur temps réel) | **30.0.0**, épinglé exact | 2.3.0 |
| `appwrite` (client web) | **28.1.0**, épinglé exact | 2.3.0 |

Épinglage sans `^` dans `package.json` ; Dependabot ignore leurs versions
majeures (`.github/dependabot.yml`). Attention : sur npm, l'étiquette `latest`
de `node-appwrite` pointait encore sur 29.1.0 le jour de la montée ; vérifier le
format de réponse dans l'archive publiée, pas l'étiquette.

Historique : avant la montée, le serveur était en 1.6.0 et les SDK épinglés en
`node-appwrite` 16.0.0 / `appwrite` 17.0.2 (29 / 26 auparavant envoyaient un
format plus récent que le serveur : `x-appwrite-warning` à chaque requête).

## Ce qui a changé pour le code

- **Compte bloqué : 403 `user_blocked` depuis 1.9** (401 avant). Le client le
  traite comme une session refusée (`shared/lib/appwriteErrors.ts`,
  `isSessionRejectedError` : sonde de session au démarrage, `getAppwriteUser`,
  revérification des échecs de persistance) ; l'API (`api/_lib/appwrite.ts`) et
  le serveur temps réel (`server/multiplayer/auth.ts`) acceptaient déjà 403. Cas
  réel : l'étiquette `deletionpending` pendant la suppression d'un compte.
- Aucune autre adaptation : le code reste sur `Databases` / documents en
  paramètres positionnels (toujours servis en 2.3, `TablesDB` non adopté),
  `Query`, `Permission` / `Role`, `Teams`, `Users`, `Storage`, `Account`,
  `createJWT`, `InputFile`, `client.call`. Pas de `createVerification` ni de
  `createRecovery` (codes de vérification maison, `api/auth/*`).
- `client.call` brut : `X-Appwrite-Project` reste passé explicitement
  (`accessQueries.ts`), sans effet de bord.

## Vérifications

- `npm run check:full` vert avec les deux SDK (E2E du parcours, persistance,
  co-édition sur faux backend).
- Sur la répétition puis sur la prod en 2.3.0 : projets et charges gzip,
  bucket `project-payloads`, FIT relus à l'octet, miniatures, équipes
  `p<projectId>`, `users.createJWT` + `Account.get`, préférences ;
  `secure-shared-projects --check-documents --all` 120/120 acceptés ;
  `fit-orphans` ; un cycle de suppression de compte sur un compte jetable ;
  0 avertissement de format.

## Montée suivante

Lire les notes de version du serveur pour chaque mineure franchie, répéter la
montée sur une copie (en surveillant le **disque** à chaque téléchargement
d'images, pas seulement la RAM : voir l'incident de la répétition dans
[appwrite-montee.md](appwrite-montee.md)), puis monter les SDK sur la série
dont le format de réponse égale la version du serveur.
