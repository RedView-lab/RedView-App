# Chasse aux bugs — 2026-10-10 — zone F (prédiction côté app, outils de la carte, carte 3D)

Suite de `2026-10-10-chasse-aux-bugs.md` (zones A à E), même méthode. Rien n'est corrigé ici (consigne de l'utilisateur : audit seulement). Flyover et export vidéo hors périmètre.

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

Preuves : tests Vitest et scripts jetables gardés hors du dépôt (scratchpad de la session) ; « lu » = établi à la lecture seulement.

## Zones

| # | Zone | État |
|---|------|------|
| F1 | Prédiction côté app (`fitPredictor`, `useItineraryFitRuntime`) | fait : 1 constat (P2, à confirmer) |
| F2 | Outils de la carte (`centerPanel/tools`) | fait : 1 constat (P1) |
| F3 | Carte 3D (`map3d/hooks/useMap`, surcouches) | fait : 1 constat (P2, à confirmer) |

## Synthèse par sévérité

| Sévérité | Constat | Preuve |
|---|---|---|
| P1 | F2-1 Découpe : feuille de route des deux moitiés effacée, tracé complet du GPX perdu | test |
| P2 | F1-1 Panique du moteur Rust : instance WASM empoisonnée gardée | lu, à confirmer |
| P2 | F3-1 Changement direct de projet : vue carte de A enregistrée dans B | lu, à confirmer en E2E |

## Constats

### F1 — Prédiction côté app

#### F1-1 · P2 (à confirmer) · Après une panique du moteur Rust, le worker garde une instance WASM empoisonnée

- **Où** : `src/features/fitPredictor/engine/worker.ts:39-117` : une panique Rust (`panic = abort` en wasm32 → `RuntimeError: unreachable`) est attrapée par le `try/catch` du worker et renvoyée comme une erreur ordinaire ; le worker reste vivant avec la **même** instance WASM. `engine/api.ts:84-95` ne remplace le worker que sur `onerror` (plantage non attrapé), jamais après une erreur renvoyée.
- **Scénario** (lu, aucune panique provoquée ici) : une entrée qui déclenche une panique (FIT exotique qui passe le contrôle d'en-tête, cas limite du moteur vélo) fait échouer ce calcul — attendu — mais la documentation de wasm-bindgen tient l'instance pour indéfinie après une panique (emprunts `RefCell` restés pris, état global à moitié écrit) : les calculs suivants de **tous** les itinéraires peuvent échouer ou rendre des résultats faux jusqu'au rechargement de la page. Le message affiché est brut (« unreachable »), et `parseFailingFitIndex` ne peut pas désigner le .fit fautif, qui n'est donc pas écarté automatiquement.
- **Correctif proposé** : dans le worker, sur une `WebAssembly.RuntimeError`, répondre l'erreur puis se fermer (`self.close()`), ou côté `api.ts` terminer et recréer le worker quand l'erreur porte ce type ; message traduit (« le moteur a rencontré une erreur, relancez le calcul ») ; à confirmer en provoquant une panique dans un test wasm32 (`wasm-bindgen-test`).

### F2 — Outils de la carte

#### F2-1 · P1 · Découper un itinéraire efface la feuille de route des deux moitiés et la résolution du GPX importé

- **Où** : `src/features/itineraryPanel/lib/project/split-itinerary.ts:57-130` : chaque moitié reçoit une feuille de route **neuve** (`createImportedTimeline(leftPoints)` / `(rightPoints)`) : points de passage nommés, POI favoris avec leur pause, lignes masquées, notes, horaires et départ / arrivée nommés sont remplacés par des lignes génériques (« Point de passage 1 », coordonnées en guise de nom). Le découpage se fait sur `gpxRoute.points` (tracé **simplifié** d'un GPX importé) et `originalPoints` reçoit cette moitié simplifiée : le tracé complet est perdu (export GPX, qualité, altitudes).
- **Scénario** : l'utilisateur coupe un ultra de deux jours en deux étapes pour les préparer séparément : la nuit à l'hôtel (favori, pause de 8 h), le ravitaillement nommé au col et le reste de sa feuille de route disparaissent des deux itinéraires, et le GPX de l'organisateur n'est plus qu'au dixième de sa résolution. Annuler juste après rattrape tout ; s'en rendre compte plus tard, non.
- **Preuve** : `f2-split.test.ts` (scratchpad), vrai `splitItineraryProject` : feuille de route gauche `["start", "6.00000, 45.00000"], ["waypoint", "Point de passage 1"], …` (plus de « Col (ravito) » ni d'« Hôtel réservé » à 480 min) ; points complets **1 001 → 102** (gauche + droite).
- **Correctif proposé** : répartir les lignes existantes selon leur kilométrage (celles avant la coupe à gauche, après à droite, en recalant les distances de la moitié droite), créer seulement la nouvelle arrivée / le nouveau départ à la coupe ; couper `originalPoints` au point correspondant (projection de la coupe) au lieu de le remplacer par le tracé simplifié.

### F3 — Carte 3D

#### F3-1 · P2 (à confirmer en E2E) · Passer directement d'un projet à un autre peut enregistrer la vue carte du premier dans le second

- **Où** : `src/features/map3d/hooks/useMap/index.ts:304-317` : au démontage, la carte appelle `subscriptions.persistCurrentViewport()` (`useMapSubscriptions.ts:152-160`), qui appelle `onViewportChange` **sans savoir pour quel projet**. La carte est démontée parce que `ProjectProvider` est remonté par projet (`DashboardEditor.tsx:488`, `MapView` est dedans) ; à ce moment, `activeProjectInitial` / `activeProjectIdRef` désignent déjà le projet B (ouvert depuis le gestionnaire sans repasser par la fermeture de A, `useDashboardProjectState.ts:117-181`). `handleMapViewportChange` (`useDashboardChrome.ts:238-253`) remplace alors la vue de B, que l'effet `:228-236` enregistre dans la vue de B (`updatePersistedDashboard`), et qui revient à la carte de B par `initialViewport` — « une autre vue » que la sienne, donc un saut (`useMap` n'ignore que son propre écho).
- **Scénario** (lu) : projet A ouvert sur les Alpes ; l'utilisateur ouvre le gestionnaire par-dessus et clique sur le projet B (Pyrénées) : B peut s'ouvrir puis sauter sur les Alpes, et sa vue enregistrée devient celle de A (prochaine ouverture de B au mauvais endroit). La réinitialisation « dans le même rendu » (`useDashboardChrome.ts:93-106`), qui corrigeait « un nouveau projet apparaît sur l'emplacement du dernier projet », a lieu **avant** le démontage de l'ancienne carte, qui l'écrase ensuite. Fermer A (retour au gestionnaire) puis ouvrir B n'est pas touché (aucun projet actif au démontage).
- **Correctif proposé** : passer à `useMap` / `MapView` l'id du projet à la création et ignorer (ou ne pas émettre) l'enregistrement de démontage quand il ne correspond plus au projet actif ; plus simplement, `persistCurrentViewport` au démontage n'écrit que dans le stockage local de la carte, sans appeler `onViewportChange`. Vérification : parcours E2E « A ouvert, déplacé, ouvrir B depuis le gestionnaire » (`bench:collab-e2e` / `e2e:journey` savent ouvrir deux projets).

## Zones vérifiées sans constat

- **F1** : `ENGINE_VERSION` (Rust, `cycling/mod.rs:35`) et `CYCLING_ENGINE_VERSION` (`engine/version.ts:6`) valent tous deux 4 ; un résultat n'est écrit que si les entrées (tracé, discipline, rythme) n'ont pas changé pendant le calcul — changer de discipline (vélo ↔ trail) en plein calcul jette le résultat ; deux itinéraires calculés en même temps : file par clé d'itinéraire, chaque résultat écrit sur l'itinéraire de sa clé, une demande plus récente du même itinéraire remplace la précédente en file (`superseded`), l'annulation ne touche que l'itinéraire actif ; worker qui ne charge pas / plante (`onerror`) → erreur affichée, bouton de nouveau actif, worker recréé à la demande suivante, `init` du WASM réessayé après un 502 ; un .fit refusé par le moteur (« Error parsing FIT file #N ») est écarté et le calcul relancé sans lui ; fichiers de course à pied ignorés par le moteur vélo (`split_by_sport`). Prédiction périmée après l'affinage des altitudes : déjà notée en D2-1.
- **F2** (lu + tests existants) : armer un outil désarme les autres (`toolDisarm.test.tsx`) ; geste du point de trace (`tracePointGesture.test.ts`) ; un clic sur un POI pendant le tracé passe par le même test de clic au pixel (`queryPoiAtPoint`) ; annuler / rétablir pendant un routage : le tracé restauré est vérifié par son estampille au passage suivant (`VERIFY_STORED_ROUTE`), un correctif en vol pour l'ancien état est jeté (`pendingKey`) ; la découpe refuse un tracé de moins de 4 points et ne coupe jamais au premier ni au dernier point (`safeSplitIndex` borné à [1, n − 2]), et chaque moitié BRouter est estampillée (pas de recalcul complet).
- **F3** (lu) : gestionnaires `styledata` examinés (étiquettes, vent, altitude, zones interdites, couches de route) : ne modifient le style que si une valeur diffère ou qu'une couche manque, et `bench:screens` échoue sur un `styledata` émis au repos ; la carte est détruite et recréée à chaque projet (`map.remove()`), les couches de route d'itinéraires disparus sont retirées (`removeRouteLayer`) : pas de surcouche d'un projet précédent ; écho de `initialViewport` ignoré par `useMap` ; garde-fous de progression sur `visibleClock` (onglet caché) ; `styleLessMapGuards` couvert par `e2e:journey` sans jeton Mapbox.
