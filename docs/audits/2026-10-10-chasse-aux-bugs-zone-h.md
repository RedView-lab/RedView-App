# Chasse aux bugs — 2026-10-10 — zone H (graphique d'analyse, outils du visualiseur LiDAR, neige et ensoleillement, réglages)

Suite de `2026-10-10-chasse-aux-bugs.md` (zones A à G), même méthode. Rien n'est corrigé ici (consigne de l'utilisateur : audit seulement). Flyover et export vidéo hors périmètre.

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

Preuves : tests Vitest et scripts jetables gardés hors du dépôt (scratchpad de la session) ; « lu » = établi à la lecture seulement.

## Zones

| # | Zone | État |
|---|------|------|
| H1 | Graphique d'analyse et panneau central | fait : 1 constat (P3) |
| H2 | Outils du visualiseur LiDAR | fait : 2 constats (P2) |
| H3 | Neige et ensoleillement côté app | fait : sans constat |
| H4 | Réglages et unités | fait : sans constat |

## Synthèse par sévérité

| Sévérité | Constat | Preuve |
|---|---|---|
| P2 | H2-1 Surface d'un polygone qui se recoupe : 0 m² | test |
| P2 | H2-2 Édition à main levée du visualiseur sur un aller-retour (famille G3-1) | lu + test G3-1 |
| P3 | H1-1 Axe « heure » sans changement d'heure | lu |

## Constats

### H1 — Graphique d'analyse

#### H1-1 · P3 · Axe « heure » : heure murale = départ + temps écoulé, sans changement d'heure

- **Où** : `src/features/centerPanel/flyover/playback.ts:45-46` (`xValueFromDistance`, partagé par le graphique et les curseurs distants ; lu seulement — fichier dans le périmètre d'une autre session) : `elapsedHours + parseStartTimeHours(startTime)`.
- **Scénario** (lu) : nuit du 24 au 25/10 sur la selle : après 03:00 (heure d'été), l'axe « heure » et les étiquettes de survol affichent une heure de plus que l'heure réelle, alors que l'agenda et les noms GPS (instants absolus) donnent la bonne ; même famille que B4-1.
- **Correctif proposé** : calculer l'heure murale depuis l'instant (`départ + écoulé` → `getHours()` dans le fuseau du départ) plutôt que par addition d'heures.

### H2 — Outils du visualiseur LiDAR

#### H2-1 · P2 · Surface d'un polygone qui se recoupe : 0 m² (ou une valeur trop petite)

- **Où** : `src/features/lidar/viewer/tools/terrain/areaStats.ts:33-41, 115-120` : la surface en plan vient de la formule du lacet (aires signées : les deux lobes d'un « nœud papillon » s'annulent), alors que le remplissage par lignes de balayage (pente, exposition, part au-dessus de 30 / 35 / 40 / 45°) compte les deux lobes ; `surfaceAreaM2` est ensuite ramenée à cette surface en plan fausse. Rien n'empêche de cliquer un polygone qui se recoupe (`shared/lib/polygonClosing.ts` ne contrôle que la fermeture).
- **Scénario** : en délimitant une zone de départ d'avalanche, un sommet cliqué dans le mauvais ordre fait se croiser deux arêtes : « Surface 0 m² » avec pourtant des parts de pente calculées, ou une surface nettement sous-estimée pour un recoupement partiel.
- **Preuve** : `h2-area.test.ts` (scratchpad), vrai `computeAreaStats` sur terrain plat : carré de 100 m → plan 10 000, sol 10 000 ; mêmes sommets en nœud papillon (5 000 m² réels) → **plan 0, sol 0**.
- **Correctif proposé** : surface en plan = nombre d'échantillons du balayage × aire de cellule (même règle pair-impair que les statistiques), ou refuser / signaler un polygone qui se recoupe au moment du clic.

#### H2-2 · P2 · Édition à main levée dans le visualiseur sur un aller-retour : même défaut que G3-1

- **Où** : `src/features/itineraryPanel/components/ItineraryPanelContainer/lidarViewerRouteEdit.ts:104` appelle `insertWaypointAtRoutePosition` avec le point saisi, sans kilométrage (cf. G3-1, reproduit).
- **Scénario** : déplacer dans le visualiseur la descente d'un sommet en aller-retour insère le point de passage à la montée.
- **Correctif proposé** : celui de G3-1 (transmettre la distance le long du tracé du point saisi, que le visualiseur connaît par le tracé qu'il dessine).

## Zones vérifiées sans constat

- **H1** (lu) : profil d'altitude : points sans altitude ignorés (`series/routeProfile.ts:211`), interpolation seulement entre deux altitudes finies (`:401-404`) ; position du survol bornée au tracé (`clampDistanceM`) ; mode temps sans prédiction → `NaN` (pas de position inventée) ; curseurs distants : chaque observateur convertit la distance reçue dans **son** mode d'axe (`xValueFromDistance`), donc deux éditeurs sur des axes différents voient le même point du tracé.
- **H2** (lu) : outils actifs sur les deux moteurs, mesures recalculées sur le MNT de la scène ; statistiques de surface `null` quand aucun échantillon n'a de sol (zone sans données) plutôt qu'un zéro.
- **H3** (lu) : ensoleillement calculé dans le **fuseau du lieu** (`sunlight/hooks/useSunlight.ts:60-147` → `shared/lib/timeZoneAt`, fuseau du navigateur seulement en repli) — c'est la brique à réutiliser pour corriger B2-3 et E2-2 ; date du calendrier lue en date locale (`SunlightSection.tsx:45`), n'importe quelle date passée ou future acceptée (calcul astronomique). Neige : une seule analyse AROME courante, pas de date personnalisée ; sans AROME (hors domaine, Météo-France indisponible) → erreur explicite et arrêt des autres téléchargements ; stations / BRA / météo ou DEM lointain en échec → calcul quand même, avec l'état de chaque source rendu dans `sources` ; orographie du modèle gardée seulement si plus de la moitié des cellules est connue.
- **H4** (lu) : préférence d'affichage et langue sont des réglages de l'appareil (gardés à la déconnexion, `SIGN_OUT_PRESERVED_KEYS`), pas du compte : c'est un choix, pas une perte ; changer de langue retraduit le DOM (`AppI18nProvider`) et les composants qui appellent `t()` ; aucune couche Mapbox n'est créée avec un texte traduit une fois pour toutes (seul le menu contextuel en a, recréé à chaque ouverture) ; libellés créés dans le document (« Nouveau point », « Pause ») restent dans la langue de création mais sont retraduits à l'affichage par le traducteur du DOM. Pas d'unités impériales dans l'app.
