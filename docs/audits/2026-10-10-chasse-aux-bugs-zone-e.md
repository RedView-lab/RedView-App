# Chasse aux bugs — 2026-10-10 — zone E (POI et feuille de route, météo de route, commentaires et présence)

Suite de `2026-10-10-chasse-aux-bugs.md` (zones A à D), même méthode. Rien n'est corrigé ici (consigne de l'utilisateur : audit seulement). Flyover et export vidéo hors périmètre (travail en cours d'une autre session).

Sévérités : **P0** faille / perte de données / panne · **P1** bug fonctionnel visible · **P2** cas limite, robustesse · **P3** qualité, dette.

Preuves : tests Vitest et scripts jetables gardés hors du dépôt (scratchpad de la session) ; « lu » = établi à la lecture seulement.

## Zones

| # | Zone | État |
|---|------|------|
| E1 | POI côté app et feuille de route | fait : 1 constat (P1) |
| E2 | Météo de route | fait : 2 constats (1 P1) |
| E3 | Commentaires et présence en direct | fait : 2 constats (P3) |

## Synthèse par sévérité

| Sévérité | Constat | Preuve |
|---|---|---|
| P1 | E1-1 Recherche POI relancée : favoris non retrouvés effacés avec leur pause et leur nom | test |
| P1 | E2-1 Météo de route au-delà de la dernière heure de prévision : dernière valeur recopiée | test |
| P2 | E2-2 Heures de prévision lues dans le fuseau du navigateur | lu |
| P3 | E3-1 Fil supprimé pendant une réponse : texte perdu sans message | lu |
| P3 | E3-2 État lu / non lu écrasé entre deux appareils | lu |

## Constats

### E1 — POI et feuille de route

#### E1-1 · P1 · Une recherche POI relancée efface les favoris qu'elle ne retrouve pas : pauses (nuits), noms saisis et étoiles disparaissent sans prévenir

- **Où** : `src/features/itineraryPanel/components/ItineraryPanelContainer/poiCorridorMutations.ts:19-70` : toutes les lignes POI de la feuille de route sont retirées (`stripped`) puis remplacées par les seuls résultats de la nouvelle recherche ; favori, pause et nom saisi ne sont reportés que sur un POI **retrouvé** (`existingPoiRows.get(row.osmId)`). `mergePoiFeatureFavorites` (`poiFeatureUtils.ts:47-60`) ne garde lui aussi que les POI renvoyés, et une recherche vide rend `[]` tel quel. La recherche est relancée dès que l'empreinte change (`buildPoiSearchSignature`, `lib/schedule/poiAutoSort.ts:40-47` : catégories cochées **et** largeur du couloir), ou que le tracé change.
- **Scénario** : l'utilisateur a mis en favori l'hôtel de la première nuit (pause de 6 h, nom « Nuit ici (réservé) »), puis décoche « Hôtels » pour alléger la carte, ou réduit le couloir de 500 à 200 m, ou l'hôtel sort de la base POI (taxonomie v4, commerce fermé dans OSM), ou un correctif de tracé l'éloigne du couloir. La nouvelle recherche ne le renvoie pas : la ligne disparaît avec ses 6 h de pause, l'agenda, la synthèse, les horaires et l'export GPS sont recalculés sans la nuit. Recocher la catégorie le ramène, **sans** étoile, sans pause et sans le nom saisi.
- **Preuve** : `e1-poi-refresh.test.ts` (scratchpad), vrai `applyCorridorComplete` : favori hôtel (360 min, nom saisi) + nouvelle recherche qui ne renvoie qu'une boulangerie → lignes POI `[["Boulangerie", null]]` ; recherche vide → `[]`.
- **Correctif proposé** : garder toute ligne POI marquée par l'utilisateur (favori, `durationMin` posé, `labelEdited`, ligne masquée à la main) même absente des résultats, avec sa position et un signal discret (« plus trouvé par la recherche ») ; ne retirer que les lignes automatiques. Le décocher d'une catégorie masque ses POI non favoris au lieu de les effacer.

### E2 — Météo de route

#### E2-1 · P1 · Au-delà de la dernière heure de prévision, la météo de route affiche la dernière valeur connue, figée

- **Où** : `src/features/weather/lib/routeWeather.ts:465-476` : quand l'heure de passage dépasse la dernière heure reçue, `interpolateStationAtTime` renvoie les valeurs de **cette dernière heure** au lieu de rien (même chose avant la première, `:453-463`). Or `resolveRouteWeatherDateRange` (`:118-134`) borne volontairement la plage demandée au dernier jour de l'horizon (`OPENMETEO_FORECAST_DAYS` = 4) quand l'arrivée est plus loin : sur un parcours de plusieurs jours, toute la fin du trajet est hors des heures reçues. Le commentaire du module promet l'inverse (« aucune valeur n'est inventée », `:226-229`, `:526`).
- **Scénario** : départ après-demain pour un ultra de 60 h. La plage demandée s'arrête au 13 à 23:00 ; pour tout le 14 (arrivée à 20:00), le graphique et les valeurs de passage montrent la température, la pluie et le vent du 13 à 23:00, recopiés pendant 20 h : une nuit froide affichée toute la journée suivante, une pluie de fin de soirée étendue à tout le lendemain.
- **Preuve** : `e2-weather.test.ts` (scratchpad, `TZ=Europe/Paris`) : départ J+2 avec 60 h de trajet → plage `2026-10-12 → 2026-10-13` ; prévision de 48 h où la température monte de 1 °C par heure : +10 h → 18, dernière heure → 47, **+60 h → 47, +200 h → 47** (au lieu de `null`).
- **Correctif proposé** : hors de `[première heure, dernière heure]` (avec une tolérance d'une heure), renvoyer `null` comme pour une valeur manquante ; le graphique laisse alors le trou et la légende dit « au-delà de l'horizon de prévision (J+4) ».

#### E2-2 · P2 · Heures de prévision lues dans le fuseau du navigateur, pas dans celui de chaque station

- **Où** : la requête demande `timezone=auto` (`routeWeather.ts:263-269`) : Open-Meteo renvoie l'heure **murale du lieu de chaque station**, sans décalage (`"2026-10-12T14:00"`). `parseHourTimeMs` (`:396-399`) la lit avec `new Date(…)`, c'est-à-dire dans le fuseau **du navigateur**, comme le départ (`departureTimestamp` → `localDateTimeMs`).
- **Scénario** (lu) : même famille que B2-3. Un parcours qui traverse deux fuseaux (France → Portugal, ou toute la Transcontinental) mélange des stations décalées d'une heure entre elles (l'interpolation spatiale entre deux stations de part et d'autre de la frontière moyenne deux heures différentes). Le jour du changement d'heure, l'heure répétée (02:00) est lue deux fois au même instant (suite d'instants non croissante), et une station consultée depuis un navigateur réglé sur un autre fuseau est décalée en bloc.
- **Correctif proposé** : demander `timezone=GMT` (ou lire `utc_offset_seconds` de chaque réponse) et travailler en instants UTC, avec le départ exprimé dans le fuseau du lieu de départ (cf. B2-3).

### E3 — Commentaires et présence en direct

#### E3-1 · P3 · Fil supprimé par son auteur pendant qu'on y répond : la réponse en cours de saisie disparaît sans message

- **Où** : `src/features/comments/lib/commentActions.ts:164-173` (`reply` sur un fil absent → `null`, rien n'est fait) ; `components/MapCommentsLayer.tsx:204` (la carte du fil se ferme dès que le fil n'existe plus) ; côté serveur, une réponse arrivée après la suppression est un lot rejeté (`collab/model/commentRules.ts`), retiré en silence de l'état visible.
- **Scénario** (lu) : B écrit une longue réponse dans un fil ; A supprime le fil (son premier message). La carte de B se ferme sous ses doigts avec le texte saisi ; s'il avait déjà envoyé, sa réponse apparaît puis disparaît au rejet.
- **Correctif proposé** : garder le brouillon (comme `draftTextRef` du visualiseur) et afficher « Ce fil a été supprimé » avec la possibilité de copier le texte ou d'en faire un nouveau fil au même endroit.

#### E3-2 · P3 · État lu / non lu des commentaires écrasé entre deux appareils

- **Où** : l'état de lecture est dans la vue de l'utilisateur (`commentsView.reads`), enregistrée **en bloc** dans `project_views`, la dernière écriture gagnant (`shared/services/projects/projectViews.ts:1-15`).
- **Scénario** (lu) : sur le portable, l'utilisateur lit trois fils ; le fixe, resté ouvert sur le projet avec une vue plus ancienne, enregistre sa vue au moindre déplacement de carte : à la prochaine ouverture, les trois fils sont de nouveau « non lus » (pastille rouge sur l'outil Commenter), sur les deux appareils.
- **Correctif proposé** : fusionner `reads` à l'écriture (par fil, garder l'identifiant du message le plus récent lu) au lieu de remplacer la vue entière, ou stocker l'état de lecture à part.

## Zones vérifiées sans constat

- **E1** : règle favori ⇒ pause (`poiFavoritePause.ts`) : retirer l'étoile retire la pause, décocher la pause pose `0` (et la recherche suivante le garde : `durationMin` reporté y compris 0), une pause activée met le POI en favori, la durée par défaut vient de la grille Rythme ; recherche relancée : pause et nom saisi gardés sur les POI retrouvés ; test de clic au pixel (`queryKeyAt` → `pickPoiHit`) : candidats dédoublonnés entre tuiles, POI survolé testé à ses deux positions, sprite pas encore chargé = pas de candidat (il n'est pas dessiné non plus), erreur → `null` (aucun clic ne casse la carte).
- **E2** : départ au-delà de l'horizon → `null` (« prévisions indisponibles »), jamais une extrapolation ; plage calculée en jours de calendrier (changement d'heure dans l'horizon) ; valeur nulle du modèle → `NaN` → point omis ; tracé hors du domaine du modèle (réponse vide) → `null` mis en cache 30 min ; erreur HTTP (429 compris) ou réseau → `null` mis en cache 1 min (pas de rafale vers un service en panne) ; requêtes en vol partagées par clé, pas annulées par un nouveau rendu ; au plus 26 stations par tracé (le serveur en accepte 200) ; correction d'altitude de −6,5 °C/km entre la station et le point.
- **E3** : zones : 3 sommets alignés ou polygone qui se recoupe acceptés sans dommage (la bulle se pose sur un sommet, jamais sur un centre calculé qui pourrait être `NaN`), nombre de sommets borné (`MIN/MAX_COMMENT_ZONE_VERTICES`) et coordonnées vérifiées à la lecture (`sanitize.ts:46-52`) ; réducteur unique avec les droits de Figma, appliqués aussi par le serveur ; suivi : chaîne A→B→A résolue sans boucle (`followChain.ts`, chacun voit l'autre), éditeur parti → suivi arrêté, onglet suivi rechargé repris par l'onglet le plus récent du même utilisateur, deux Spotlight simultanés → le plus récent gagne (numéro strictement croissant, documenté et testé).
