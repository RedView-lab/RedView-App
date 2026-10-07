# RedView — audit de la base POI et reconstruction

**Date** : 22 septembre 2026
**Déclencheur** : POI manquants en Corse (restaurant/hôtel *Pietra Monetta*, à Palasca) présents sur Mapbox mais absents de RedView.
**Serveur** : `http://141.145.220.99/poi` (VPS Oracle, systemd `poi-server`, SQLite + R*Tree).

---

## 1. Résultat

| | Avant | Après |
| --- | ---: | ---: |
| POI indexés | **325 009** | **680 603** (+109 %) |
| Catégories | 18 | **46** |
| POI en *node* | ~325 000 (dont ~60 000 hors France) | 541 456 |
| POI en *way* (bâtiment) | **0** | **139 147** |
| POI en *relation* | 0 | 0 (étape optionnelle non lancée) |
| Couverture France | 0 → 67 % selon la catégorie | **92 → 100 %** |
| Pietra Monetta (Palasca) | absent | restaurant + hôtel détectés |

Vérifications passées sur la base mise en production : `integrity_check` = `ok`, `count(pois)` = `count(poi_rtree)` = 680 603, requête de corridor 200 km / rayon 1 000 m / 10 catégories = **214 ms**.

Ancienne base conservée sur le VPS : `data/backup-pois-20260922-143604.db`.

---

## 2. Couverture mesurée contre OpenStreetMap France

Référence : instance taginfo régionale France (`taginfo.openstreetmap.fr`, base « data only for France »), qui donne aussi le découpage nodes / ways / relations.

| Catégorie | OSM France | Avant | Après |
| --- | ---: | ---: | ---: |
| `restaurant` | 92 362 | 59 580 (64,5 %) | 92 139 (**99,8 %**) |
| `toilets` | 36 589 | 21 239 (58,0 %) | 36 548 (**99,9 %**) |
| `fast_food` | 30 449 | 19 698 (64,7 %) | 30 298 (99,5 %) |
| `bakery` | 29 498 | 19 394 (65,7 %) | 29 491 (**99,98 %**) |
| `drinking_water` | 26 371 | 87 753 (333 %, hors France) | 26 371 (**100 %**) |
| `convenience` | 22 536 | 14 993 (66,5 %) | 22 519 (99,9 %) |
| `bar` | 20 818 | 13 618 (65,4 %) | 20 743 (99,6 %) |
| `pharmacy` | 19 142 | 12 250 (64,0 %) | 19 133 (99,95 %) |
| `cafe` | 17 318 | 11 681 (67,5 %) | 17 129 (98,9 %) |
| `supermarket` | 15 743 | 5 958 (37,8 %) | 15 707 (**99,8 %**) |
| `fuel` | 12 138 | 5 107 (42,1 %) | 11 084 (91,3 %) |
| `camp_site` | 9 297 | 1 266 (**13,6 %**) | 9 153 (**98,5 %**) |
| `bicycle` | 3 867 | 1 332 (34,4 %) | 3 837 (99,2 %) |
| `hospital` | 2 513 | 357 (**14,2 %**) | 2 383 (94,8 %) |
| `alpine_hut` | 687 | 2 050 (298 %, hors France) | 654 (95,2 %) |

Les écarts résiduels (`fuel` 91 %, `hospital` 95 %) viennent des objets cartographiés en *relation* (multipolygones) — voir §6.

Catégories **absentes** avant et désormais indexées : `defibrillator` 27 937, `atm` 28 936, `charging_station` 21 396, `fountain` 21 461, `spring` 19 427, `viewpoint` 18 727, `post_office` 17 458, `picnic_site` 14 919, `pass` (cols) 7 469, `shower` 2 717, `clinic` 1 993, `water_point` 1 966, `ice_cream` 1 803, `vending_machine` 1 684, `compressed_air` 1 588, `wilderness_hut` 1 135, `bus_station` 805, `ferry_terminal` 616, etc.

---

## 3. Cause racine n°1 — seuls les *nodes* étaient indexés

`parse-pbf.js` (l'importeur d'origine) contenait :

```js
if (item.type !== 'node') continue;
```

Tout POI cartographié en **bâtiment (way)** ou en **relation** était jeté. Or en France, la majorité des POI surfaciques sont des ways :

| Catégorie | dont ways en France | Conséquence |
| --- | ---: | --- |
| `hotel` | 15 367 | 45 % de couverture |
| `supermarket` | 7 594 | 38 % |
| `camp_site` | 7 529 | **14 %** |
| `toilets` | 9 175 | 58 % |
| `hospital` | 1 895 | **14 %** |
| `restaurant` | 12 455 | 64 % |

C'est exactement le cas signalé : à Palasca, *Pietra Monetta* est cartographié en **deux ways** (bâtiment restaurant + bâtiment hôtel), donc invisible pour un importeur « nodes only ». Sur une boîte de test en Corse, **100 %** des POI OSM de la zone étaient des ways.

## 4. Cause racine n°2 — des régions entières jamais ingérées, silencieusement

`ingest-all-france.sh` téléchargeait 14 extraits régionaux Geofabrik. Or il en existe 22 :

- **Rhône-Alpes** (Lyon, Grenoble, Chamonix, Annecy, Vercors…) — absent ;
- **Île-de-France** (Paris) — absent ;
- Nord-Pas-de-Calais, Picardie, Champagne-Ardenne, Limousin, Poitou-Charentes — absents ;
- `normandie-latest.osm.pbf` **n'existe pas** (Geofabrik fournit `basse-normandie` et `haute-normandie`) → `curl -s` sans `-f` a téléchargé une page HTML d'erreur, l'importeur l'a traitée, et le journal a affiché `0 POI` sans lever d'erreur.

Le script terminait pourtant par « TOUTES LES RÉGIONS DE FRANCE SONT INDEXÉES DANS SQLITE R*TREE ».

## 5. Cause racine n°3 — données hors France et fusion d'identifiants

`import-pois.js` interrogeait Overpass sur la boîte `41.3,-5.2,51.1,9.6`, qui déborde largement sur l'Italie, la Suisse, l'Espagne, la Belgique, le Luxembourg et l'Allemagne. D'où des POI étrangers en base (sondes : Milan, Genève, Barcelone, Bruxelles renvoient tous des résultats), et des compteurs aberrants (87 753 points d'eau pour 26 371 en France).

Ce script sautait par ailleurs toute catégorie déjà peuplée (`if (existing.count > 0) continue`), et utilisait `INSERT OR REPLACE` sur `id` : les namespaces *node* et *way* d'OSM étant distincts, un way pouvait écraser un node homonyme.

## 6. Ce qui n'est pas encore couvert

- **Relations (multipolygones)** : campings, hôpitaux et supermarchés parfois cartographiés en multipolygone. `import-relations.mjs` est écrit et prêt (rejouable, idempotent) mais l'étape n'a pas été lancée — les instances Overpass publiques étaient saturées. Gain attendu : ~5 000 à 10 000 POI, surtout sur `camp_site` / `hospital` / `supermarket`. Commande : `node import-relations.mjs --db data/pois.db`.
- **Pays frontaliers** : la base est France seule. `rebuild-poi-db.sh --with-neighbours` ajoute Belgique, Luxembourg, Allemagne, Suisse, Italie, Espagne, Andorre et Monaco (~8 extraits Geofabrik supplémentaires).

---

## 7. Correctifs livrés

| Fichier | Rôle |
| --- | --- |
| `server/poi-ingest/import-osm.mjs` | **Nouvel importeur** : nodes + ways, 2 passes sur le PBF, staging SQLite, mémoire bornée (~200 Mo pour la France). Ids non collisionnels (`way = +1e13`, `relation = +2e13`), tags filtrés par liste blanche, `--append` pour enchaîner plusieurs pays. |
| `server/poi-ingest/import-relations.mjs` | Multipolygones via Overpass `out center`, idempotent. |
| `server/poi-ingest/rebuild-poi-db.sh` | Pipeline complet depuis `france-latest.osm.pbf` (un seul extrait : plus de découpe aux frontières régionales), contrôle de taille et d'en-tête PBF après téléchargement, `--with-neighbours`, `--relations`, `--swap`. |
| `server/poi-ingest/swap-db.sh` | Bascule atomique : contrôle d'intégrité, sauvegarde horodatée, arrêt/redémarrage du service, vérification HTTP. |
| `server/poi-server/{server.js,db.js,package.json}` | Copie de référence du serveur (il n'existait qu'en production). `/corridor` passe d'un balayage O(candidats × points) à une **grille spatiale** — validé A/B : résultats strictement identiques (0 manquant, 0 en trop) sur 4 scénarios. `osm_type` exposé, détection de schéma pour rester compatible avec une base historique. |
| `src/features/poi/poi-taxonomy.json` | **Source de vérité unique** de la taxonomie : 46 catégories, règles de tags OSM (OR de AND), icônes, liste blanche de tags conservés. Déployée telle quelle sur le VPS. |
| `src/features/poi/poi-taxonomy.ts` | Chargement typé de la taxonomie côté client. |
| `src/features/poi/types.ts`, `lib/poi-icons.ts` | 46 catégories, libellés dérivés du JSON, vocabulaire d'icônes logiques. |
| `src/features/itineraryPanel/hooks/useItineraryPoiMap.ts`, `lib/schedule/poi-to-timeline.ts`, `sections/PoiSection.tsx`, `types.ts`, `lib/project/defaultState.ts`, `components/ItineraryPanelContainer/useItineraryGpxImport.ts`, `sections/timeline/KindBadge.tsx` | Câblage complet : chaque ligne du panneau agrège désormais toute sa famille (ex. *Fontaines* → `drinking_water`, `water_point`, `water_tap`, `spring`, `fountain`) ; deux nouvelles lignes **Santé** et **Transport** ; la ligne *Cols* qui ne pointait sur rien est branchée. |
| `script-test-bench/audit-poi-db.mjs` | Harnais d'audit réutilisable (taginfo France + Overpass `out count` + base live), avec `--taxonomy`. |
| `script-test-bench/reports/poi-db-audit.{md,json}` | Rapport d'audit brut (état « avant »). |

Scripts dépréciés sur le VPS (`*.deprecated`) pour qu'ils ne puissent plus être relancés par erreur : `parse-pbf.js`, `import-pois.js`, `ingest-all-france.sh`.

---

## 8. Points de vigilance

- **Volume côté client.** La base est ~2× plus dense et 46 catégories sont désormais activables. Un corridor large (rayon ≥ 1 000 m sur un long itinéraire) peut renvoyer plusieurs milliers de POI, et le client crée un marqueur DOM par POI. Le défaut livré reste `distanceM: 40` par catégorie, donc l'usage courant est léger — mais si un utilisateur monte à 1 000 m, il faut envisager un clustering à bas zoom côté client. À mesurer en usage réel.
- **Levier n°1 restant : la distance X.** Les 12 catégories historiques sont livrées à **40 m** (`defaultState.ts`) : le corridor ne fait donc que 40 m de large. Monter à 200-1 000 m est le vrai réglage pour « tout voir ».
- **Favoris existants.** Les POI en *node* conservent leur id (rétrocompatible). Les POI nouvellement indexés en *way* ont un id préfixé (`+1e13`) : les favoris enregistrés sur ces POI avant reconstruction ne matcheront plus après une nouvelle recherche.
- **Fréquence de mise à jour.** La base est un instantané Geofabrik. Un rafraîchissement mensuel via `rebuild-poi-db.sh --swap` est recommandé.
