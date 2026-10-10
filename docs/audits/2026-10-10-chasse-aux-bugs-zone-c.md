# Chasse aux bugs — 2026-10-10 — zone C (co-édition client, LiDAR, facturation, i18n / a11y)

Suite de `2026-10-10-chasse-aux-bugs.md` (zones A et B), même méthode. Rien n'est corrigé ici.

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

Preuves : tests Vitest et scripts jetables gardés hors du dépôt (scratchpad de la session) ; chaque constat dit comment il a été reproduit, ou « lu » s'il ne l'a été qu'à la lecture.

## Zones

| # | Zone | État |
|---|------|------|
| C1 | Client de co-édition (`features/collab/client/`) | fait : 2 constats (1 P1) |
| C2 | Visualiseur LiDAR (`features/lidar`) | fait : 4 constats (1 P1) |
| C3 | Facturation côté interface | fait : 4 constats (P2 au plus) |
| C4 | i18n / a11y | fait : 2 constats (P2 au plus) |

## Synthèse par sévérité

| Sévérité | Constat | Preuve |
|---|---|---|
| P1 | C1-1 Copies hors ligne de plusieurs onglets reprises une par session : vieilles modifications rejouées par-dessus des récentes | test (vrai client + salle) |
| P1 | C2-1 Trace créée / dupliquée dans le visualiseur ajoutée à chaque projet ouvert | test |
| P2 | C2-2 Visualiseur : commentaires du dernier onglet qui publie, écrits dans ce projet | test |
| P2 | C3-1 Paiement réussi puis erreur réseau : affiché comme un échec, nouvel essai impossible | lu |
| P2 | C4-1 Date personnalisée de l'ensoleillement inaccessible au clavier | balayage + lu |
| P3 | C1-2 Résultat calculé rattaché à une étape d'annulation sans lien | lu |
| P3 | C2-3 Écriture OPFS ratée : copie CacheStorage effacée à la lecture | lu |
| P3 | C2-4 Sans OPFS, quota plein sans `StorageFullError` | lu |
| P3 | C3-2 Bulle « Reprenez d'abord votre abonnement » en cas d'incident de paiement | lu |
| P3 | C3-3 Pop-in de résiliation sans piège de focus | lu |
| P3 | C3-4 Commentaire vers un hook inexistant | lu |
| P3 | C4-2 Autres actions accessibles seulement à la souris | balayage + lu |

## Constats

### C1 — Client de co-édition

#### C1-1 · P1 · Copies hors ligne de plusieurs onglets : une seule reprise par session, les autres rejouées plus tard par-dessus des modifications plus récentes

- **Où** : `src/features/collab/client/unsyncedStore.ts:113-133` (`adoptUnsynced` rend la **première** copie utilisable, la plus ancienne, et s'arrête) ; `client/session.ts:58-72` (une session = un `clientId`, une seule copie adoptée). Les autres copies restent dans `redview-collab` jusqu'à 30 jours (`MAX_AGE_MS`) et ne sont reprises qu'à une session suivante, un `clientId` à la fois.
- **Scénario** : jour 1 hors ligne (train, refuge), deux onglets du même projet partagé ; l'onglet 1 renomme l'itinéraire 1, l'onglet 2 renomme l'itinéraire 2 ; les deux sont fermés. Jour 2, un seul onglet : seule la copie de l'onglet 1 est reprise, l'utilisateur ne voit pas sa modification de l'itinéraire 2 (« perdue »), le renomme à nouveau. Jour 3 : la copie de l'onglet 2 est enfin reprise et rejouée (le serveur ne l'a jamais vue : `welcome.clientSeq` ne l'écarte pas) → le nom du jour 1 **remplace** celui du jour 2, chez tous les éditeurs, sans aucun signal. Même chose pour un tracé, une pause, un réglage : la règle « le dernier écrivain gagne » s'applique au moment de la reprise, pas à celui de la modification.
- **Preuve** : `c1-stale-copy.test.ts` (scratchpad) — vrai `CollabClient` + vrai cœur de salle (`Room`, `RoomState`), copies obtenues par `engine.unsyncedBatches()` comme les écrit `CollabSession` → jour 2 : `it-2` = « Variante » (modification de l'onglet 2 absente) ; jour 3 : `it-2` = « onglet 2 (jour 1) » au lieu de « renommé le jour 2 ». La règle « une copie par session » est lue dans `adoptUnsynced`.
- **Correctif proposé** : au démarrage, reprendre **toutes** les copies utilisables de ce projet et de cet utilisateur (chacune sous son verrou), dans l'ordre de `savedAt` : la première avec le client de la session, les suivantes par une courte connexion supplémentaire avec leur propre `clientId` (même `hello` / `welcome.clientSeq`, puis fermeture et suppression de la copie) ; à défaut, ne jamais rejouer une copie plus vieille que la dernière session ouverte sur ce projet sans le dire (toast « des modifications faites hors ligne le … ont été appliquées » / proposer de les écarter). Ajouter le scénario au simulateur (`collab/sim/`).

#### C1-2 · P3 · Un résultat calculé est rattaché à une étape d'annulation sans lien, parfois ancienne

- **Où** : `client/undoHistory.ts:155-167` : un lot `background` rejoint la **dernière étape** qui touche le même itinéraire, quelle que soit son ancienneté et même si le calcul a été causé par la modification d'un autre éditeur (bail repris après les 5 s de priorité de l'auteur, `leaseGate.ts`).
- **Scénario** (lu) : A renomme l'itinéraire 1 ; dix minutes plus tard, B déplace un point puis se déconnecte ; A reprend le bail et calcule le nouveau tracé. A annule son renommage → l'inverse rattaché remet aussi l'**ancien tracé** (celui d'avant le déplacement de B), puisque A est le dernier à avoir écrit ces propriétés : tracé et points ne correspondent plus, l'empreinte `routedInputsKey` relance un routage complet chez l'auteur du bail suivant.
- **Correctif proposé** : ne rattacher un résultat qu'à l'étape dont les entrées l'ont causé (empreinte des entrées `DERIVED_INPUTS` au moment de l'étape) et à une étape récente (même session de calcul) ; sinon, aucune étape.

### C2 — Visualiseur LiDAR

#### C2-1 · P1 · Une trace créée ou dupliquée dans le visualiseur est ajoutée à **chaque** projet ouvert dans un onglet de l'app

- **Où** : `src/features/lidar/lib/routeOverlaySync.ts:31-87` (aucun message ne porte d'identifiant de projet) ; `src/features/lidar/lib/useLidarRouteSync.ts:41-60` (tout onglet de l'app qui a un projet ouvert traite `CREATE_ROUTE` / `DUPLICATE_ROUTE`) ; `src/features/controlPanel/components/ControlPanelContainer.tsx:115-137, 184-201` (`addLidarRouteItinerary` sans condition ; une copie dont la source n'est pas dans le projet est « ajoutée comme simple copie »). L'URL du visualiseur ne dit pas non plus de quel projet il vient (`lib/viewerUrl.ts:37-56`).
- **Scénario** : projet « Alpes » ouvert dans un onglet, projet « Pyrénées » dans un autre, visualiseur ouvert depuis « Alpes ». Une trace dessinée (ou une copie faite) dans le visualiseur devient un nouvel itinéraire dans **les deux** projets, enregistré dans les deux (et diffusé à tous les éditeurs si l'un est partagé). Avec deux onglets sur le même projet, deux ajouts du même itinéraire. Modifier / renommer / supprimer passent par l'id de l'itinéraire et ne touchent que le bon projet.
- **Preuve** : `c2-viewer-channels.test.ts` (scratchpad) — deux `useLidarRouteSync` (deux onglets) sur le vrai canal, `broadcastLidarRouteCreate(…, 'lidar_viewer')` → création reçue par P1 **et** par P2.
- **Correctif proposé** : mettre l'id du projet dans l'URL du visualiseur (`buildViewerUrl`) et dans chaque message (`projectId`), et ne traiter dans l'app que les messages du projet ouvert ; l'état publié par l'app (`syncLidarRouteOverlay`) porte aussi son `projectId`, que le visualiseur compare au sien.

#### C2-2 · P2 · Le visualiseur affiche les commentaires du dernier onglet qui publie, et y écrit

- **Où** : `src/features/lidar/viewer/comments/viewerComments.ts:88-96` (tout `STATE` est accepté, quel que soit le projet) ; `comments/bridge/useLidarCommentSync.ts:56-90` (chaque onglet de l'app publie à chaque changement et répond à chaque `HELLO`).
- **Scénario** : même situation que C2-1. Le visualiseur montre tantôt les fils d'« Alpes », tantôt ceux de « Pyrénées » (selon l'onglet qui a répondu en dernier) ; un commentaire posé sur la scène des Alpes part avec le `projectId` du dernier état reçu, donc dans « Pyrénées », à des coordonnées hors de son tracé (et chez tous ses éditeurs s'il est partagé).
- **Preuve** : `c2-viewer-channels.test.ts` — deux `useLidarCommentSync` (P1 puis P2) ; un abonné au canal (comme le visualiseur) reçoit `["P1", "P2"]` et garde P2.
- **Correctif proposé** : le visualiseur connaît son projet (paramètre d'URL, cf. C2-1) et ignore les `STATE` / `CLOSED` d'un autre ; `HELLO` porte ce `projectId` et seul l'onglet de ce projet répond.

#### C2-3 · P3 · Écriture OPFS ratée (hors quota) : la tuile gardée dans CacheStorage est effacée à la lecture suivante

- **Où** : `src/features/lidar/lib/storage.ts:121-142` : `getFileHandle(fileName, { create: true })` crée le fichier ; si `createWritable` / `write` échoue pour une autre raison que le quota (fichier tenu par une poignée d'accès synchrone d'un worker, `InvalidStateError`, `NoModificationAllowedError`), le fichier vide **n'est pas supprimé** et la tuile part dans CacheStorage. `loadTileByFileName` (`:170-187`) lit d'abord l'OPFS, trouve le fichier vide (signature invalide) et appelle `deleteTile`, qui efface aussi la copie de CacheStorage (`:281-289`).
- **Scénario** (lu) : la tuile téléchargée n'est jamais lisible : chaque ouverture la retélécharge (des centaines de Mo pour une dalle IGN).
- **Correctif proposé** : supprimer le fichier OPFS sur tout échec d'écriture (comme pour le quota) ; à la lecture, une entrée OPFS invalide ne supprime que l'OPFS puis essaie CacheStorage.

#### C2-4 · P3 · Sans OPFS, un quota plein ne lève pas `StorageFullError`

- **Où** : `storage.ts:145-163` : un `QuotaExceededError` de `cache.put` n'est que journalisé et la tuile finit en mémoire de la page, que le visualiseur (autre page) ne lit pas — le commentaire de `:135-136` dit justement que c'est un téléchargement raté.
- **Scénario** (lu) : navigateur sans OPFS utilisable (WebKit sous Windows, cf. CLAUDE.md), stockage plein : téléchargement « réussi », visualiseur vide, sans le message « Stockage local plein ».
- **Correctif proposé** : `isQuotaExceeded(err)` sur `cache.put` → `StorageFullError`, comme pour l'OPFS.

### C3 — Facturation côté interface

#### C3-1 · P2 · Paiement ou essai réussi chez Stripe, puis erreur réseau de l'app : la page affiche un échec et un nouvel essai ne peut qu'échouer

- **Où** : `src/features/projectBrowser/billing/components/BillingActionModal/BillingActionForm.tsx:122-160` : `confirmPayment` / `confirmSetup` réussissent, puis `onComplete` (`syncManagedSubscription` / `activateTrialSubscription`, `useProjectBrowserOverlayState.ts:441-461`) lève (réseau, 5xx) → le même `catch` affiche le message brut (« Failed to fetch ») sous le titre « Finaliser votre abonnement », bouton de paiement de nouveau actif.
- **Scénario** (lu, pas de bac à sable Stripe lancé ici) : la carte est débitée (ou l'essai démarré, le webhook `setup_intent.succeeded` le finira) mais l'utilisateur lit une erreur ; « S'abonner et payer » relance `confirmPayment` sur un PaymentIntent déjà réussi → erreur Stripe, il reste bloqué sur la page de paiement, ou ferme et recommence depuis « Choisir », croyant ne pas avoir payé.
- **Correctif proposé** : distinguer les deux étapes : après une confirmation Stripe réussie, ne plus jamais réafficher le formulaire ; écran « Paiement reçu, activation en cours… » qui réessaie la synchronisation (et `refreshBillingOverview`) puis se ferme, le webhook restant le filet.

#### C3-2 · P3 · Bulle d'aide fausse quand un paiement est en échec

- **Où** : `src/features/projectBrowser/components/subscription/SubscriptionPanel.tsx:91, 116-117` : `canSwitch` est faux aussi quand `hasPaymentIssue(snapshot)`, mais le `title` dit toujours « Reprenez d'abord votre abonnement pour changer de formule. ».
- **Scénario** (lu) : abonnement `past_due` non résilié : l'utilisateur lit qu'il doit « reprendre » un abonnement qu'il n'a pas résilié ; aucune indication qu'il faut d'abord régler le moyen de paiement.
- **Correctif proposé** : un message par cause (`cancelAtPeriodEnd` → reprendre ; incident de paiement → mettre à jour le moyen de paiement, lien vers le bouton correspondant).

#### C3-3 · P3 · Pop-in « Résilier votre contrat » sans piège de focus

- **Où** : `components/subscription/CancelSubscriptionDialog.tsx:58-104` : `aria-modal="true"`, focus initial sur « Fermer » et retour sur le bouton d'origine, mais Tab sort de la carte vers la page derrière (aucune boucle de focus, page non `inert`).
- **Scénario** (lu) : au clavier ou au lecteur d'écran, après « Confirmer la résiliation », Tab continue dans l'onglet Abonnement masqué par le voile. Le parcours `e2e:journey` n'ouvre pas cette pop-in (axe ne teste pas l'ordre de tabulation).
- **Correctif proposé** : reprendre le piège de focus de la pop-in commune (`AppDialog`) ou poser `inert` sur le reste de l'application tant qu'elle est ouverte.

#### C3-4 · P3 · Commentaire qui renvoie à un hook inexistant

- **Où** : `BillingActionForm.tsx:52-56` cite `useBillingRedirectReturn` ; le retour de redirection est traité dans `useProjectBrowserOverlayState.ts:463-506`.
- **Correctif proposé** : corriger la référence.

### C4 — i18n / a11y

#### C4-1 · P2 · Date personnalisée de l'ensoleillement inaccessible au clavier

- **Où** : `src/features/controlPanel/sections/SunlightSection.tsx:249-256` : l'ouverture du calendrier est un `<div onClick>` (ni bouton, ni `tabIndex`, ni `role`, ni gestion de touche).
- **Scénario** : au clavier seul (ou au lecteur d'écran), on peut cocher « Choisir une date personnalisée » mais jamais ouvrir le calendrier : la date reste celle du jour. WCAG 2.1.1 (Clavier), niveau A ; hors du parcours `e2e:journey`, donc jamais audité.
- **Preuve** : balayage statique des éléments non interactifs cliquables (`clickable-divs.mjs`, scratchpad) puis lecture.
- **Correctif proposé** : un `<button type="button" aria-haspopup="dialog" aria-expanded={calendarOpen}>` avec le même contenu (le contour de focus par défaut de `src/index.css` s'applique).

#### C4-2 · P3 · Autres actions accessibles seulement à la souris

- **Où** (même balayage, lu) : durée d'une pause dans l'agenda (`TimelineEventCard.tsx:234-243`, `TimelineStandalonePauseCard.tsx:94-105` : `<span onClick>`) ; renommer une tuile LiDAR (`controlPanel/sections/LidarTilesSection.tsx:145`) ; choisir une trace dans le panneau du visualiseur (`lidar/viewer/rightPanel/RouteSection.tsx:348`) ; repères du curseur de surfaces (`tracage/SurfaceRangeSlider.tsx:297`, le curseur lui-même reste utilisable au clavier).
- **Scénario** : au clavier, impossible de modifier la durée d'une pause depuis l'agenda (la feuille de route reste un chemin possible), de renommer une tuile, de choisir une trace dans le visualiseur.
- **Correctif proposé** : boutons natifs (ou `role="button"` + `tabIndex={0}` + Entrée / Espace) ; ajouter l'agenda, le panneau LiDAR et l'ensoleillement aux écrans audités par axe (cliquet `a11y-baseline.json`).

## Zones vérifiées sans constat

- **C1** : `SyncEngine` : un lot déjà transmis n'est jamais modifié (fusion hors ligne seulement dans un lot jamais envoyé, `transmitted`), ≤ 2 000 opérations et 1 M caractères (le serveur en accepte 20 000), jamais de segments de tracé dans un lot fusionné ; lots `localOnly` retirés au premier `welcome` ; `welcome.clientSeq` écarte les lots déjà appliqués, les autres sont renvoyés (y compris après une perte du journal) ; un trou de séquence déclenche une resynchronisation. `UndoHistory` : une propriété ou une position changée par un autre n'est pas restaurée, inverses compactés une écriture par propriété, une suppression est recréée avec toutes ses propriétés, les commentaires ne sont jamais une étape. `unsyncedStore` : adoption sous Web Lock `ifAvailable` (un seul onglet), filtrée par utilisateur, formats `BATCH_FORMAT_PROTOCOLS`, copies vides / trop vieilles supprimées ; sans Web Locks ni IndexedDB, un `clientId` neuf par onglet. `CollabConnection` : 4403 / 4404 / 4426 terminaux, 4401 → jeton neuf puis session expirée au-delà de quelques refus, 4409 / 4429 / 1011 → reconnexion avec attente progressive, 1012 → retour rapide étalé ; messages reçus traités dans l'ordre derrière une décompression en cours, trame illisible → connexion neuve ; envois ordonnés derrière une compression ; rien n'est envoyé avant `welcome`.
- **C2** : le visualiseur valide tout ce qu'il lit du canal ou de localStorage (`readLidarCommentState` → `sanitizeCommentThreads`, couleurs et opacités des traces normalisées) ; l'app n'applique les actions de commentaire que pour son projet ouvert et efface la copie localStorage à la fermeture ; tuile écrite vérifiée par sa taille (WebKit) et sa signature LAS ; quota OPFS → `StorageFullError` et fichier retiré ; modifier / renommer / supprimer une trace depuis le visualiseur passent par l'id de l'itinéraire. Pertes de contexte GPU et choix du moteur : couverts par `bench:lidar-engines` (non relancé ici).
- **C3** : « Choisir » désactivé pendant l'action et le chargement ; double envoi du formulaire de paiement bloqué (`submitting`, bouton désactivé, événements discrets rendus aussitôt) ; consentement obligatoire avant tout paiement ou essai, texte du droit de rétractation et de l'accès immédiat ; essai déjà consommé : c'est le serveur qui choisit `setup` ou paiement (la page suit `result.intent`) ; retour de PayPal / 3-D Secure : paramètres retirés de l'URL avant traitement (pas de double traitement au rechargement), `failed` → message sans prélèvement, onglet jamais revenu → webhook ; résiliation : accessible directement, récapitulatif (compte, formule, référence, date de fin), double clic bloqué (`busy`), confirmation par e-mail côté webhook, reprise possible jusqu'à la fin de période ; pendant la bêta, la carte « démo » ne s'affiche que sans abonnement actif.
- **C4** : `node scripts/quality/i18n-audit.mjs --list` : 1 282 fichiers, 2 436 paires, 0 conflit, 0 texte manquant, 0 gabarit littéral en position d'interface, couverture 100 % ; les gabarits restants dans `title` / `aria-label` / `placeholder` (`SlopeLegend`, `SummaryRow`, `RythmeSection`, `PoiSection`, `AccountPanel`) assemblent des textes déjà traduits par `t()` et des nombres ; aucun bouton composé d'une seule icône sans `aria-label` / `title` (balayage `icon-buttons.mjs` : 10 résultats, tous des boutons avec texte visible).
