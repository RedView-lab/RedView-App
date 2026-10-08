# SDK Appwrite alignés sur le serveur 1.6

> Décision du 2026-10-08 : les deux SDK suivent la version du serveur Appwrite
> de production, pas la dernière version publiée.

## Constat

- Serveur de production : **Appwrite 1.6.0** (`GET /v1/health/version`, 2026-10-08).
  **Mis à jour le même jour en 2.3.0** ([appwrite-montee.md](appwrite-montee.md)) : les
  SDK passent à `node-appwrite` 30.0.0 et `appwrite` 28.1.0 (format 2.3.0) ; ce
  document décrit l'épinglage 1.6 qui précédait.
- SDK avant ce changement : `node-appwrite` 29.1.0 (serveur, API, scripts, serveur
  temps réel) et `appwrite` 26.2.0 (client web). Ils envoient
  `X-Appwrite-Response-Format` 2.0.0 et 1.9.5 : le serveur 1.6 répondait avec
  l'en-tête `x-appwrite-warning` (« The current SDK is built for Appwrite 2.0.0 … »),
  affiché par le SDK à chaque requête. La dette date au moins de node-appwrite 29.0.0.
- Séries compatibles 1.6, d'après le README de chaque paquet publié sur npm
  (« compatible with Appwrite server version 1.6.x ») et le format de réponse
  envoyé :

  | Paquet | Séries 1.6 | Dernière 1.6 (date npm) | Série suivante |
  |---|---|---|---|
  | `node-appwrite` | 14.x – 16.x | **16.0.0** (2025-04-17) | 17.x → serveur 1.7 |
  | `appwrite` (web) | 16.x – 17.x | **17.0.2** (2025-04-17) | 18.x → serveur 1.7 |

## Choix

Épinglage exact sur **node-appwrite 16.0.0** et **appwrite 17.0.2**
(`package.json`, sans `^`). Dependabot ignore leurs versions majeures
(`.github/dependabot.yml`).

Le code n'utilisait déjà que ce que 1.6 connaît : l'API `Databases` / documents
en paramètres positionnels (aucun `TablesDB`), `Query`, `Permission` / `Role`,
`ID`, `Teams`, `Users`, `Storage`, `Account`, `createJWT`, `InputFile`
(`node-appwrite/file`) et `client.call` côté web. Une seule adaptation :
`users.listMemberships(userId)` ne prend pas de requêtes en 1.6
(`api/_lib/accountDeletion.ts`). Le serveur 1.6 ignorait déjà le `limit`
envoyé : ce point d'accès renvoie toutes les adhésions du compte d'un coup, le
comportement en production ne change pas.

## Vérifications (2026-10-08)

- `npm run check:full` vert (16/16) avec les deux SDK épinglés ; la facturation
  (`api/_lib/billing`) compile sans changement.
- Contre la production, en lecture seule, SDK actuel puis SDK 1.6 :

  | Contrôle | SDK 29 / 26 | SDK 16 / 17 |
  |---|---|---|
  | `scripts/appwrite/fit-orphans.ts` (Storage, Databases) | 4 avertissements | 0, même rapport |
  | `scripts/appwrite/secure-shared-projects.ts` (Teams, Databases : accès des projets partagés) | 6 avertissements | 0, même rapport |
  | Vérification du serveur temps réel : JWT signé par `users.createJWT` (aucune écriture) → `Account.get()` | OK, 4 avertissements | OK, 0 |
  | Client web : `Locale.listCodes()` et `client.call` brut | 2 avertissements, `client.call` sans `X-Appwrite-Project` | 0, en-tête projet présent |

  `appwrite` 17 fusionne les en-têtes du client dans `client.call` : le correctif
  qui passe `X-Appwrite-Project` explicitement (`accessQueries.ts`, appel brut
  de la v26) reste valide et devient redondant.

## Risques restants

- Les SDK ont un an de retard sur les versions publiées : correctifs de
  sécurité des SDK seulement par leurs séries 16 / 17, s'il en sort. Le SDK web
  ne porte pas de secret ; le SDK serveur ne parle qu'à notre Appwrite.
- `e2e:journey` simule Appwrite (faux backend) : il ne détecte pas un écart de
  version. Les contrôles ci-dessus contre la production sont à refaire à chaque
  changement de SDK ou de serveur.
- Monter le serveur Appwrite (1.7, 1.8…) est une opération sur le VPS
  (sauvegarde, migration, `scripts/appwrite/setup-appwrite-schema.mjs --check`),
  décidée par l'utilisateur. Les SDK montent ensuite à la série du nouveau
  serveur, dans le même changement.
