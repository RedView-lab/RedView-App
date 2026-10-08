# Structure du code

[← Index de la documentation](../README.md) · [Dépôt](../../README.md)

Où va un fichier dans `src/` et `public/`, et pourquoi. Les règles ci-dessous
s'appliquent aujourd'hui à chaque dossier. [`npm run check`](../../scripts/README.md)
fait respecter ce qu'un outil peut vérifier : aucun fichier ni export inutilisé
(knip), aucun cycle d'import (madge).

## Où va ce fichier ?

Se poser ces questions dans l'ordre :

1. **N'est-il utilisé que par une feature ?** Le placer dans cette feature.
2. **Est-il utilisé par plusieurs features sans appartenir à aucune ?** Le placer
   dans `shared/`, dans le dossier de son rôle ([voir plus bas](#shared--sept-dossiers-un-rôle-chacun)).
3. **Fait-il des entrées / sorties avec notre backend ?** Le placer dans
   `shared/services/`, ou dans le `queries/` de la feature pour les hooks TanStack Query.
4. **Est-ce une zone cohérente avec ses propres composants, hooks et logique ?**
   Lui donner un dossier de sous-domaine nommé dans sa feature.
5. **Une autre feature a-t-elle besoin de l'un de ses rouages internes ?** Alors
   soit ce rouage est public (l'exporter depuis `index.ts` ou `types.ts`), soit le
   code est dans la mauvaise feature.

## Premier niveau de `src/`

```text
src/
  main.tsx, App.tsx, index.css   amorçage : thème, rapport d'erreurs, session, Dashboard chargé à la demande
  pages/                         un dossier par page (racines de composition)
  features/                      domaines du produit, découpés par feature
  shared/                        code utilisé par plusieurs features, sans propriétaire métier
  types/                         déclarations ambiantes seulement (*.d.ts des paquets non typés)
```

Rien d'autre ne vit à la racine de `src/`. Il n'y a ni `src/lib`, ni `src/components`, ni `src/utils`.

## `shared/` — sept dossiers, un rôle chacun

| Dossier | Contient | Exemples |
|---|---|---|
| `components/` | Composants React (un dossier quand il y a un fichier CSS ou des aides) | `RedViewLogo.tsx`, `UserAvatar/`, `AppToaster/` |
| `hooks/` | Hooks React génériques | `useLatestRef`, `useHorizontalScrollOverflow` |
| `lib/` | Fonctions pures et petits modules sans framework, sans entrée / sortie vers notre backend | `appScale`, `appTheme`, `notify`, `terrarium`, `analytics/` |
| `services/` | Entrées / sorties : Appwrite, le client TanStack Query, la persistance des projets | `appwrite.ts`, `queryClient.ts`, `projects/`, `storage/idbProjectStore.ts` |
| `styles/` | Jetons CSS globaux et couches visuelles partagées | `theme.css`, `typography.css`, `dialog.css` |
| `i18n/` | Moteur de traduction et fichiers de paires `{ fr, en }` | `AppI18nProvider`, `config/translations/` |
| `test/` | Aides de test partagées par plusieurs fichiers de test | `renderHook.ts`, `renderComponent.ts` |

Il n'y a ni `shared/ui` ni `shared/utils`. Un nouveau fichier partagé va dans
l'un des sept dossiers ci-dessus. Si aucun ne convient, il appartient
probablement à une feature.

## Forme d'une feature

```text
features/<nom>/
  index.ts        API publique (facultative, voir « API publique et barrels »)
  types.ts        types publics (types/ quand ils sont nombreux)
  components/     composants React
  hooks/          hooks React
  lib/            logique pure, fichiers de données (p. ex. poi/lib/poi-taxonomy.json), la logique exécutée par les workers
  context/        contextes et stores React (facultatif)
  styles/         CSS de la feature partagé par plusieurs composants (facultatif)
  queries/        hooks TanStack Query pour l'état serveur (facultatif)
  <sous-domaine>/ une sous-zone cohérente avec ses propres components/, hooks/, lib/ (facultatif)
```

1. **La racine d'une feature ne contient que `index.ts`, `types.ts` ou `types/`,
   `config.ts`, et des sous-dossiers.** Un composant, un hook ou une aide trouvé à
   la racine part dans `components/`, `hooks/` ou `lib/`.
2. **Les tests sont à côté de leur module :** `foo.ts` → `foo.test.ts`. Un test qui
   couvre plusieurs sous-zones se place dans leur parent commun, par exemple
   `centerPanel/tools/toolDisarm.test.tsx`.
3. **Les sous-domaines portent un vrai nom, jamais un `subfeatures/` générique.**
   Exemples : `centerPanel/flyover`, `centerPanel/tools/<outil>`, `lidar/viewer`,
   `weather/overlay`, `weather/radar`, `controlPanel/sections`,
   `projectBrowser/{account,billing,settings}`, `collab/{client,model,room,sim}`,
   `livePresence/engine`, `comments/bridge`. Les sous-domaines frères de même
   nature sont regroupés : `centerPanel/tools/` contient `chartPlacement`,
   `forbiddenZones`, `routeDragWaypoint`, `routeMerge`, `routeSplit` et `tracer`.
4. **Une exception documentée : un contrat d'échange reste à la racine.**
   `collab/protocol.ts`, `wire.ts`, `schema.ts`, `realtime.ts` et `routeChunks.ts`
   forment le protocole entre client et serveur. `server/multiplayer` et les bancs
   les importent. Ils restent à la racine de la feature, avec les tests qui les
   exercent de bout en bout (`collab.test.ts`, `presence.test.ts`), pour que le
   contrat reste visible et stable.

## API publique et barrels

- **Quand il existe un `index.ts`, importer la feature par lui.** Une feature en a
  un quand d'autres features consomment une vraie surface publique : providers,
  un composant principal, des hooks publics.
- **À l'intérieur d'une feature, ne jamais importer son propre barrel.** Un module
  que le barrel réexporte, directement ou transitivement, importe des modules
  concrets. Sinon il ferme un cycle d'import, et `npm run cycles` doit rester à zéro.
- **Garder le gestionnaire de projets léger.** La coque n'importe jamais les barrels
  `map3d` ou `controlPanel` : `npm run bundle:check` garde mapbox-gl et l'éditeur 3D
  hors de son chemin critique.
- **Certaines petites features n'ont volontairement pas de barrel :**
  `contourLines`, `labels`, `slope` et `poi`. Un barrel `poi` tirerait sa couche de
  marqueurs Mapbox et son CSS dans des modules qui n'ont besoin que de `poi/types`,
  et créerait des cycles avec `map3d`. Leur surface publique est `types.ts` plus les
  modules de `lib/` que nomment leurs importateurs.

## `pages/`

Une page est une racine de composition, avec la même forme qu'une feature :

```text
pages/Dashboard/
  index.tsx        la page
  editorLoader.ts  entrée à la demande de l'éditeur 3D (gardée à la racine : c'est le point de découpage du code)
  components/      interface propre à la page (DashboardEditor, recherche de lieu, écran de chargement)
  hooks/           hooks propres à la page (useDashboardChrome, useDashboardProjectState, …)
  lib/             aides propres à la page (layout, dashboardProjectCache, editorReadyMeter)
```

## Styles

- **Tailles de police et couleurs viennent des jetons.** Chaque taille de police
  passe par les jetons de `shared/styles/typography.css`, chaque couleur par ceux
  de `shared/styles/theme.css`. Les règles sont dans [`CLAUDE.md`](../../CLAUDE.md),
  aux rubriques « Typographie » et « Thèmes ».
- **Le CSS d'un composant est à côté de lui**, comme `UserAvatar/UserAvatar.css`.
  Quand plusieurs composants d'une feature partagent une feuille de style, elle va
  dans le dossier `styles/` de la feature, avec un `index.css`.
- **Les styles en ligne sont réservés aux valeurs d'exécution :** des valeurs
  calculées pendant que l'application tourne.

## `public/` — fichiers statiques servis tels quels

| Chemin | Contient |
|---|---|
| `icons/ui/` | Icônes d'interface, dessinées en masques `currentColor` via `SvgV2Icon` |
| `icons/poi/` | Glyphes, épingles et badges des POI, l'icône de groupe de POI du graphique d'analyse |
| `icons/context-menu/` | Icônes des menus contextuels de la carte et des POI |
| `flags/` | Drapeaux des sélecteurs de pays et de langue |
| `brand/` | Le logo RedView, dans ses deux variantes de couleur |
| `images/` | Images matricielles (aperçus des réglages, image d'aperçu de lien `images/og/`) |
| `sw-dem.js`, `sw-dem/` | Le Service Worker des tuiles. Tout changement demande une ligne datée dans le tampon de cache de l'en-tête de `sw-dem.js`. |
| fichiers racine | Favicons, icônes d'application, `robots.txt`, les binaires WebAssembly, `france-border.json` |

Le code désigne ces fichiers par URL absolue (`/icons/ui/…`). Knip ne les voit pas :
après avoir déplacé ou supprimé un fichier, construire l'application et vérifier
que chaque URL utilisée par le code existe encore dans `dist/`.

## Déplacer des fichiers

- Déplacer avec `git mv`, pour garder l'historique.
- Réécrire chaque import dans le même commit, références hors de `src/` comprises :
  bancs, `server/`, `scripts/`, commentaires, `CLAUDE.md`.
- `npm run check` doit être vert à chaque commit.
- Plusieurs sessions peuvent partager un même arbre de travail. Commiter une liste
  explicite de fichiers (`git commit -- <fichiers>`), jamais un dossier entier.
