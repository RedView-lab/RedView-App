# RedView — audit de complétude de la base POI

Généré le 2026-09-22T13:09:25.550Z

- Serveur interrogé : `http://141.145.220.99/poi`
- POI indexés : **325 009**
- Catégories servies : **18**

## 1. Référence France entière (taginfo régional France) vs base RedView

| Catégorie | OSM France (total) | dont nodes | dont ways | dont relations | Base RedView | Couverture |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `drinking_water` | 26 371 | 26 333 | 38 | 0 | 87 753 | 332.8 % |
| `restaurant` | 92 362 | 79 835 | 12 455 | 72 | 59 580 | 64.5 % |
| `shelter` | 4 726 | 2 283 | 2 430 | 13 | 28 383 | 600.6 % |
| `toilets` | 36 589 | 27 408 | 9 175 | 6 | 21 239 | 58.0 % |
| `fast_food` | 30 449 | 26 656 | 3 774 | 19 | 19 698 | 64.7 % |
| `bakery` | 29 498 | 26 517 | 2 974 | 7 | 19 394 | 65.7 % |
| `hotel` | 37 844 | 22 242 | 15 367 | 235 | 17 091 | 45.2 % |
| `convenience` | 22 536 | 19 728 | 2 791 | 17 | 14 993 | 66.5 % |
| `bar` | 20 818 | 18 955 | 1 854 | 9 | 13 618 | 65.4 % |
| `pharmacy` | 19 142 | 17 109 | 2 025 | 8 | 12 250 | 64.0 % |
| `cafe` | 17 318 | 15 851 | 1 462 | 5 | 11 681 | 67.5 % |
| `supermarket` | 15 743 | 8 113 | 7 594 | 36 | 5 958 | 37.8 % |
| `fuel` | 12 138 | 7 916 | 4 213 | 9 | 5 107 | 42.1 % |
| `bicycle_repair` | 5 225 | 4 836 | 384 | 5 | 3 259 | 62.4 % |
| `alpine_hut` | 687 | 173 | 505 | 9 | 2 050 | 298.4 % |
| `bicycle` | 3 867 | 3 533 | 332 | 2 | 1 332 | 34.4 % |
| `camp_site` | 9 297 | 1 638 | 7 529 | 130 | 1 266 | 13.6 % |
| `hospital` | 2 513 | 488 | 1 895 | 130 | 357 | 14.2 % |
| **TOTAL** | **387 123** | **309 614** | **76 797** | **712** | **325 009** | **84.0 %** |

> Les compteurs base incluent des POI **hors France** (voir §3), la couverture réelle en France est donc encore plus faible.

## 2. Couverture par zone témoin (vérité Overpass `nwr`)

### Corse — Palasca (cas signalé)
`42.63,9.07,42.66,9.11`

| Catégorie | OSM (nwr) | Base RedView | Couverture |
| --- | ---: | ---: | ---: |
| `restaurant` | 1 | 0 | 0.0 % |
| `shelter` | 1 | 1 | 100.0 % |
| `hotel` | 3 | 1 | 33.3 % |
| `camp_site` | 1 | 0 | 0.0 % |
| **TOTAL** | **6** | **2** | **33.3 %** |

### Alpes — Chamonix (Rhône-Alpes)
`45.9,6.85,45.95,6.95`

| Catégorie | OSM (nwr) | Base RedView | Couverture |
| --- | ---: | ---: | ---: |
| `drinking_water` | 28 | 29 | 103.6 % |
| `restaurant` | 70 | 66 | 94.3 % |
| `shelter` | 1 | 4 | 400.0 % |
| `toilets` | 20 | 21 | 105.0 % |
| `fast_food` | 13 | 10 | 76.9 % |
| `bakery` | 6 | 6 | 100.0 % |
| `hotel` | 50 | 21 | 42.0 % |
| `convenience` | 6 | 6 | 100.0 % |
| `bar` | 19 | 17 | 89.5 % |
| `pharmacy` | 5 | 4 | 80.0 % |
| `cafe` | 12 | 12 | 100.0 % |
| `supermarket` | 8 | 7 | 87.5 % |
| `fuel` | 1 | 0 | 0.0 % |
| `bicycle_repair` | 1 | 1 | 100.0 % |
| `alpine_hut` | 2 | 1 | 50.0 % |
| `bicycle` | 0 | 1 | — |
| `camp_site` | 3 | 2 | 66.7 % |
| `hospital` | 1 | 0 | 0.0 % |
| **TOTAL** | **246** | **208** | **84.6 %** |

### Île-de-France — Paris centre
`48.85,2.33,48.87,2.37`

| Catégorie | OSM (nwr) | Base RedView | Couverture |
| --- | ---: | ---: | ---: |
| `drinking_water` | 0 | 103 | — |
| `restaurant` | 0 | 1772 | — |
| `shelter` | 0 | 1 | — |
| `toilets` | 0 | 90 | — |
| `fast_food` | 0 | 430 | — |
| `bakery` | 0 | 141 | — |
| `hotel` | 0 | 204 | — |
| `convenience` | 0 | 158 | — |
| `bar` | 0 | 436 | — |
| `pharmacy` | 0 | 88 | — |
| `cafe` | 0 | 645 | — |
| `supermarket` | 0 | 48 | — |
| `fuel` | 0 | 2 | — |
| `bicycle_repair` | 0 | 32 | — |
| `bicycle` | 0 | 15 | — |
| `hospital` | 0 | 2 | — |
| **TOTAL** | **0** | **4167** | **—** |

## 3. Cause racine — POI cartographiés en bâtiment (way) jamais indexés

| Zone | POI en node | POI en way/relation | Part non indexable par l'ingestion actuelle |
| --- | ---: | ---: | ---: |
| Corse — Palasca (cas signalé) | 0 | 6 | 100.0 % |
| Alpes — Chamonix (Rhône-Alpes) | 1 | 245 | 99.6 % |

## 4. Données hors France présentes dans la base

| Sonde | POI renvoyés par la base |
| --- | --- |
| Milan (IT) | {"drinking_water":68} |
| Genève (CH) | {"drinking_water":94,"shelter":4} |
| Barcelone (ES) | {"drinking_water":241,"shelter":29} |
| Bruxelles (BE) | {"drinking_water":40} |
