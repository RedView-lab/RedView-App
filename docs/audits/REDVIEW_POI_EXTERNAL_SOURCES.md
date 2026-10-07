# RedView — Complétion de la base POI par 4 sources externes

**Date** : 23 septembre 2026
**Objet** : analyse de la base POI RedView (France/Europe) et évaluation chiffrée de son enrichissement par Overture Maps, AllThePlaces, Foursquare OS Places et la base SIRENE géocodée.
**Méthode** : toutes les volumétries France sont **mesurées**, pas estimées — extraction réelle des jeux de données, comptage par catégorie de la taxonomie RedView, et **mesure du taux de doublons sur 20 zones témoin** avec les règles d'appariement réellement utilisées par le code.

> **Révision du 23/09.** Une première version de ce rapport projetait +55 %, en supposant 90 % de doublons SIRENE. La mesure a donné un tout autre résultat : SIRENE est **beaucoup plus additive** que modélisé. Après récupération des noms d'exploitants (§3.D, découverte 3), le taux se stabilise à 47 % — le même qu'Overture — et le total est de **+75 %**.

---

## 1. Résumé exécutif

| | Avant | Après | Écart |
| --- | ---: | ---: | ---: |
| POI indexés | **680 603** | **1 192 444** | **+511 841 (+75 %)** |
| Catégories | 46 | **46 (inchangé)** | 0 |
| Sources | OSM seule | OSM + Overture + SIRENE + AllThePlaces | +3 |

Avec Foursquare OS Places en complément marginal (facultatif, voir §3.C) : **≈ 1,21 M POI (+78 %)**.
Sans aucune restriction sur SIRENE, le plafond théorique est de **1 280 208 POI (+88 %)** — non recommandé, voir §6.2.

**Contrainte respectée** : aucune catégorie nouvelle. Tout est mappé dans les 46 clés existantes de `poi-taxonomy.json`.

> **En production.** Ce pipeline a été exécuté sur le VPS et la base est basculée : **1 309 445 POI** au lieu de 680 603. Voir le §10 pour les chiffres réels, qui diffèrent de la projection.

## 2. État des lieux — la base actuelle

**Base live** : `http://141.145.220.99/poi` (VPS Oracle, systemd `poi-server`, SQLite + R\*Tree).

- **680 603 POI**, **46 catégories**
- Périmètre : **France métropolitaine + Corse uniquement** (vérifié : 0 POI en Guadeloupe, Martinique, Guyane, Réunion)
- Source unique : extrait Geofabrik `europe/france-latest.osm.pbf` (nodes + ways)
- Schéma : `pois(id, osm_id, osm_type, lat, lon, category, name, tags)` + `poi_rtree(id, min_lon, max_lon, min_lat, max_lat)`
- Ids : `node = osm_id`, `way = 1e13 + osm_id`, `relation = 2e13 + osm_id`

**Ce qui est déjà bon** : sur les catégories commerciales, la couverture OSM mesurée contre taginfo France est de 92 à 100 %. Le problème n'est donc pas la complétude OSM, c'est **le volume absolu de POI qui existent dans le monde réel et ne sont pas cartographiés dans OSM**.

---

## 3. Analyse des 4 sources

### A. Overture Maps Foundation — le « game changer »

| | |
| --- | --- |
| Release analysée | `2026-08-19.0` (cadence **mensuelle**) |
| Volume monde | ≈ 74 M lieux |
| **Volume France mesuré** | **2 164 599 lieux** |
| Licence | CDLA-Permissive-2.0 / Apache-2.0 (**pas de share-alike**) |
| Accès | Parquet sur S3 / Azure Blob, requêtable directement en DuckDB |
| Identifiant stable | GERS ID |

**Ce que contient Overture France** (mesuré, champ `sources`) :

| Source interne | Lieux France |
| --- | ---: |
| Meta | 1 783 412 |
| Foursquare | 288 681 |
| AllThePlaces | 79 056 |
| PinMeTo | 11 989 |
| DAC | 1 461 |

**Point capital** : Overture est déjà un **conflate** de Meta, Microsoft, Foursquare et AllThePlaces. **Overture doit être ingéré en premier** ; les deux autres sources ne sont plus que du complément marginal.

**Apport sur nos 46 catégories** : 557 255 lieux mappables, **493 449** au seuil `confidence ≥ 0,5`, 424 313 à `≥ 0,7`.

**Qualité — à savoir** : la documentation Overture reconnaît des **doublons internes**, un **taux de déchets élevé** et une **faible complétude d'attributs**. Le champ `confidence` filtre le *déchet*, pas les doublons.

**Couverture géographique** : forte en ville, **très faible en zone rurale** — sur les zones témoin rurales, Overture ne ramenait que 0 à 15 lieux contre 6 à 40 dans notre base OSM.

**Accès** :
```sql
LOAD spatial; LOAD httpfs; SET s3_region='us-west-2';
COPY (SELECT * FROM read_parquet('s3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/*')
      WHERE addresses[1].country = 'FR') TO 'fr_places.parquet';
```

---

### B. AllThePlaces (alltheplaces.xyz)

| | |
| --- | --- |
| Run analysé | `2026-09-19-13-32-18` (cadence **hebdomadaire**) |
| Volume monde | 37 102 265 lignes / **5 262 spiders** |
| Téléchargement | 2,44 Go (`output.zip`), GeoJSON |
| Licence | **CC0** (domaine public) — la plus permissive des quatre |
| **Volume France mesuré** | **286 587 lieux** (dont 283 287 géolocalisés) |
| Marques distinctes | 612 — 507 spiders couvrent la France |

**Nature du jeu** : ce ne sont **que des chaînes et des marques**. Aucun commerce indépendant. 191 309 lieux sur 286 587 portent une marque.

**Atout technique majeur** : les catégories ATP sont exprimées **en tags OSM** directement sur les propriétés GeoJSON (`amenity=fast_food`, `shop=supermarket`…). Il n'y a **rien à mapper** : notre `poi-taxonomy.json` s'applique tel quel, exactement comme pour l'importeur OSM.

**Apport** : 97 511 lieux mappables, très concentrés (`atm` 35 514, `post_office` 13 877, `fuel` 11 283, `supermarket` 9 973). Seuls 18 spiders sur 507 produisent du mappable — le plus gros spider France (`enseignement_premier_second_degre_fr`, 63 550 lignes) ne tombe dans aucune de nos 46 catégories.

**Rendement net faible** : ces chaînes sont déjà massivement présentes dans OSM. Taux de doublons estimé **≈ 85 %** → gain net ≈ **15 000 POI**.

**Accès** : l'URL du run est dans `https://data.alltheplaces.xyz/runs/latest/info_embed.html`. **Le code pays est dans le nom de fichier** (`*_fr.geojson` = France, 210 fichiers). Ne pas parser les 5 000 autres : 24,6 Go d'adresses et d'arbres sans intérêt.

---

### C. Foursquare Open Source Places

| | |
| --- | --- |
| Volume monde | ≈ 100 M lieux |
| Licence | Apache-2.0 |
| **Volume France** | **288 681 lieux** — via sa contribution à Overture |
| Accès | **⚠️ désormais « gated » sur Hugging Face** |

**Deux constats qui changent la donne :**

1. **Foursquare est déjà dans Overture.** Ingérer Overture puis Foursquare séparément revient à réimporter le même contenu.
2. **L'accès est passé en « gated »** : compte Hugging Face, acceptation des conditions, nom de l'organisation. Ce n'est plus un simple `curl`.

**Schéma le plus riche des quatre** : `tel`, `website`, `email`, `socials`, `date_created`, `date_refreshed`, `date_closed`, `unresolved_flags` (dont `duplicate`, `closed`, `doesnt_exist`). Le champ `unresolved_flags` est un **signal de déduplication de première qualité** : Foursquare dit lui-même lesquels de ses POI sont des doublons ou n'existent pas.

**Recommandation** : **à traiter en dernier, en option**. Apport marginal estimé **+20 000 à +40 000 POI** après Overture, mais gain qualitatif réel sur les attributs.

---

### D. La base SIRENE géocodée (spécifique France)

C'est la source la plus volumineuse **et** la plus piégeuse. Quatre découvertes.

**Découverte 1 — le fichier géocodé ne contient ni nom ni catégorie.**

Le fichier INSEE « Géolocalisation des établissements du répertoire Sirene » (parquet, 810 Mo, septembre 2026) contient **37 901 783 lignes** mais seulement ces colonnes :

```
siret, x, y, qualite_xy, epsg, plg_qp24, plg_iris, plg_zus, plg_qp15, plg_qva,
plg_code_commune, distance_precision, y_latitude, x_longitude
```

**Aucun code NAF, aucun nom.** Il faut le joindre au `StockEtablissement` (parquet, 2,21 Go) qui porte `activitePrincipaleEtablissement`, `enseigne1Etablissement` et `etatAdministratifEtablissement`.

| | |
| --- | --- |
| `StockEtablissement` total | 44 064 115 lignes |
| dont **actifs** (`etatAdministratif = 'A'`) | **16 737 959** |
| Établissements géolocalisés | 37 901 783 |
| **Jointure NAF × géoloc** | **797 829** établissements mappables et localisés |
| Licence | Licence Ouverte 2.0 (Etalab) |

**Découverte 2 — le dataset Etalab « SIRENE géocodée BAN » est décommissionné** depuis avril 2026. Il faut utiliser la version INSEE ci-dessus.

**Découverte 3 — 59 % des entrées n'ont aucun nom, et c'est réparable.**

| | Entrées | Part |
| --- | ---: | ---: |
| avec `enseigne` (nom commercial) | 243 169 | 30 % |
| avec `denomination` seule | 82 747 | 10 % |
| **sans aucun nom** | **471 913** | **59 %** |

La répartition est très inégale : seuls **3 % des médecins généralistes** et **5 % des spécialistes** ont une enseigne. Un cabinet médical est enregistré au nom du praticien, pas sous un nom commercial.

**La solution est une jointure sur `StockUniteLegale`** (708 Mo, sur `siren` = 9 premiers chiffres du SIRET), qui porte `nomUniteLegale`, `prenomUsuelUniteLegale` et `denominationUniteLegale`. Mesuré :

| | Avant jointure | Après jointure |
| --- | ---: | ---: |
| Entrées nommées | 41 % | **100 %** |
| — dont `enseigne` | 30 % | 30 % |
| — dont `denomination` | 10 % | 10 % |
| — dont dénomination d'unité légale | 0 % | **40 %** (316 575) |
| — dont nom d'exploitant (prénom + nom) | 0 % | **19 %** (155 335) |
| — repli « catégorie — adresse » | 59 % | **0 %** (3 entrées) |

C'est l'amélioration la plus rentable du dispositif : elle rend exploitables 471 913 POI, et elle **fait passer le taux de doublons mesuré de 39 % à 47 %** (§4.4) — parce que les noms de praticiens et de sociétés matchent enfin les noms OSM.

**Découverte 4 — les pièges métier du registre.**

1. **Le NAF `55.20Z`** (« hébergement touristique et autre hébergement de courte durée », **137 750 établissements**) désigne très majoritairement des **meublés de tourisme déclarés en mairie**, c'est-à-dire des logements privés. Il est **exclu** de la table de correspondance : l'inclure ferait exploser `hotel` d'un facteur 4 avec des adresses résidentielles.
2. **Les adresses partagées.** Les 200 140 « médecins » exercent souvent à plusieurs à la même adresse. Le géocodage renvoie alors exactement le même point des dizaines de fois. Le regroupement par (catégorie, position arrondie à ~10 m) **écarte 159 597 entrées** — c'est le poste de nettoyage le plus important.
3. **Aucune donnée d'horaires d'ouverture.** Un POI SIRENE seul est un point de repère, pas une étape planifiable.

**Correspondance NAF → nos catégories** (comptes réels après jointure et regroupement) :

| Catégorie | Codes NAF | POI SIRENE |
| --- | --- | ---: |
| `fast_food` | 56.10C, 56.10B | 122 279 |
| `restaurant` | 56.10A | 106 917 |
| `doctors` | 86.21Z, 86.22A/B/C | 71 562 |
| `bakery` | 47.24Z, 10.71B/C/D | 52 463 |
| `convenience` | 47.11B, 47.11D | 45 364 |
| `bar` | 56.30Z | 43 313 |
| `hotel` | 55.10Z, 55.90Z | 35 013 |
| `atm` | 64.19Z | 24 471 |
| `pharmacy` | 47.73Z | 21 591 |
| `butcher` | 47.22Z, 10.13A/B | 19 457 |
| `laundry` | 96.01A, 96.01B | 13 476 |
| `outdoor_shop` | 47.64Z | 12 335 |
| `camp_site` | 55.30Z | 9 986 |
| `hospital` | 86.10Z | 8 955 |
| `post_office` | 53.10Z | 8 763 |
| `fuel` | 47.30Z | 6 692 |
| `supermarket` | 47.11C | 6 180 |
| `police` | 84.24Z | 1 469 |
| **TOTAL** | | **610 286** |

**Astuce de coût** : inutile de télécharger les 2,21 Go de `StockEtablissement`. DuckDB le lit **à distance en HTTP avec élagage de colonnes** :
```sql
SELECT activitePrincipaleEtablissement, count(*) FROM read_parquet(
  'https://static.data.gouv.fr/resources/.../stock-stocketablissement-parquet.parquet')
WHERE etatAdministratifEtablissement='A' GROUP BY 1;
```

---

## 4. Stratégie de fusion anti-doublons

### 4.1 Principe

**OSM reste la source canonique.** Chaque POI OSM existant est conservé tel quel. Les sources externes ne servent qu'à **ajouter** les POI absents et **enrichir** les POI existants (téléphone, site web, marque) — sans jamais écraser un tag OSM.

### 4.2 Ids non collisionnels

| Source | Base d'id | `osm_type` / `source` |
| --- | ---: | --- |
| OSM node / way / relation | `osm_id` / `1e13` / `2e13` | `node` / `way` / `relation` |
| **Overture** | `3e13 + hash42(GERS id)` | `overture` |
| **AllThePlaces** | `4e13 + hash42(ref)` | `atp` |
| **Foursquare** | `5e13 + hash42(fsq_place_id)` | `fsq` |
| **SIRENE** | `6e13 + int(siret)` | `sirene` |

Deux colonnes ajoutées à `pois` : `source TEXT` et `src_confidence REAL`, exposées par `server.js`.

### 4.3 Déduplication — blocage spatial + scoring

1. **Blocage** : grille spatiale de 200 m, voisinage 5×5. Un candidat n'est comparé qu'à ses voisins, jamais aux 680 000 POI de la base.
2. **Normalisation du nom** : minuscules, sans accents, sans forme juridique (SARL, SAS, EURL…), sans article (le, la, les, du, de, chez).
3. **Scoring** — première règle satisfaite gagne :

| Règle | Condition | Verdict |
| --- | --- | --- |
| `phone` | téléphone identique (E.164) **et** distance ≤ 300 m | doublon |
| `website` | même domaine **et** distance ≤ 150 m | doublon |
| `name-exact` | nom normalisé identique **et** distance ≤ 80 m | doublon |
| `name-strong` | Jaro-Winkler ≥ 0,90 **et** distance ≤ 50 m | doublon |
| `name-category` | Jaro-Winkler ≥ 0,80 **et** même catégorie **et** distance ≤ 30 m | doublon |
| `address` | même n° + voie normalisés **et** distance ≤ 50 m | doublon |

4. **Ordre d'ingestion** : **Overture → SIRENE → ATP → Foursquare**. Chaque source est dédupliquée contre l'état courant de la base, pas seulement contre OSM.

### 4.4 Taux de doublons mesurés

**Overture vs base OSM — 20 zones témoin, appariement nom + distance :**

| Zone | Base | Overture | Doublons | % |
| --- | ---: | ---: | ---: | ---: |
| Paris 1-2 | 1 991 | 2 570 | 1 318 | 51 % |
| Paris 11 | 1 355 | 1 538 | 762 | 50 % |
| Lyon Presqu'île | 1 411 | 1 504 | 746 | 50 % |
| Marseille | 907 | 1 253 | 474 | 38 % |
| Bordeaux | 1 019 | 1 374 | 611 | 44 % |
| Toulouse | 1 327 | 1 489 | 698 | 47 % |
| Nantes | 1 197 | 1 111 | 592 | 53 % |
| Lille | 878 | 1 097 | 522 | 48 % |
| Strasbourg | 1 071 | 1 187 | 617 | 52 % |
| Nice | 1 325 | 1 972 | 823 | 42 % |
| Rennes | 805 | 851 | 419 | 49 % |
| Montpellier | 1 139 | 1 218 | 555 | 46 % |
| Annecy | 593 | 603 | 280 | 46 % |
| Chamonix | 288 | 431 | 181 | 42 % |
| Clermont-Fd | 666 | 688 | 341 | 50 % |
| Rural Aveyron | 40 | 15 | 10 | 67 % |
| Rural Corrèze | 3 | 1 | 0 | — |
| Rural Lozère | 8 | 6 | 3 | 50 % |
| Alpes Briançon | 256 | 219 | 91 | 42 % |
| Pyrénées Luchon | 17 | 0 | 0 | — |
| **TOTAL** | **16 296** | **19 127** | **9 043** | **47 %** |

**SIRENE vs OSM + Overture — mêmes 20 zones, mêmes règles :**

Mesure faite **après** Overture dans l'index, puisque c'est l'ordre du pipeline. Le taux progresse par paliers, et chacun s'explique :

| Configuration | Taux de doublons | Ce qui change |
| --- | ---: | --- |
| SIRENE vs **OSM seul** | 19 % | OSM n'a que 35 % de POI adressés → la règle `address` ne peut pas jouer |
| SIRENE vs **OSM + Overture** | 39 % | Overture apporte les `addr:street` : la règle `address` se déclenche 3 848 fois |
| SIRENE (noms `StockUniteLegale`) vs **OSM + Overture** | **47 %** | 471 910 POI récupèrent un nom réel → `name-exact` passe de 4 831 à 6 692 détections |

Le dernier chiffre — **47 %** — est exactement le taux mesuré pour Overture. C'est cohérent : une fois les deux sources correctement nommées, elles se recouvrent autant l'une que l'autre.

**Contrôle de robustesse** : sur 14 621 candidats classés « nouveaux » (mesure à 39 %), **85 seulement** partagent une adresse avec un POI existant. Les « nouveaux » ne sont donc pas des doublons déguisés.

**Pourquoi SIRENE est moins redondant qu'Overture à noms égaux ?** Parce qu'Overture agrège des bases de lieux **grand public** (Meta, Foursquare) qui décrivent exactement les mêmes lieux qu'OSM, tandis que SIRENE est un **registre administratif exhaustif** : il contient des établissements qu'aucune base grand public ne référence. Les deux convergent à 47 % une fois la nomenclature alignée, mais SIRENE apporte un volume brut bien supérieur.

---

## 5. Mapping des catégories

**Règle absolue : aucune catégorie nouvelle.**

| Source | Méthode |
| --- | --- |
| **AllThePlaces** | **Aucun mapping** — tags déjà en syntaxe OSM, `resolveCategory()` s'applique tel quel |
| **SIRENE** | Table NAF rév. 2 → clé RedView (30 codes, §3.D) |
| **Overture** | `taxonomy.primary` (niveau fin, ~2 300 catégories) → 36 règles regex ordonnées. **Ne pas utiliser `basic_category`** : trop grossier, il range boulangerie, boucherie et supérette dans le même `food_and_beverage_store` |
| **Foursquare** | Via Overture |

**14 catégories que les sources externes n'alimentent PAS** (0 apport) :

`drinking_water`, `water_point`, `water_tap`, `spring`, `shelter`, `defibrillator`, `viewpoint`, `picnic_site`, `pass`, `shower`, `vending_machine`, `compressed_air`, `wilderness_hut`, `alpine_hut`

Ces catégories décrivent de l'**infrastructure de terrain sans propriétaire** : aucune base commerciale ne les couvre, et OSM les couvre déjà à 95-100 %. C'est la valeur propre de RedView.

---

## 6. Projection AVANT / APRÈS

### 6.1 Scénario recommandé

SIRENE est **restreinte** : `fast_food` (NAF 56.10C) et `bar` (56.30Z) en sont exclus. Le NAF 56.10C est **5× plus large** que `amenity=fast_food` — il inclut tous les petits comptoirs de vente à emporter, y compris des lieux déjà présents dans OSM sous une autre étiquette. Les importer noierait la carte sans valeur ajoutée.

Coefficients : Overture ×0,53 (47 % mesurés), SIRENE ×0,53 (47 % mesurés, noms `StockUniteLegale` inclus), ATP ×0,15 (estimé).

| Catégorie | Base | Overture ≥0,5 | ATP | SIRENE | Net Overture | Net ATP | Net SIRENE | **+Total** | **Après** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `restaurant` | 92 139 | 130 621 | 1 276 | 106 917 | 69 229 | 191 | 56 666 | **126 086** | **218 225** |
| `shelter` | 47 597 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **47 597** |
| `hotel` | 42 043 | 71 587 | 3 986 | 35 013 | 37 941 | 598 | 18 557 | **57 096** | **99 139** |
| `toilets` | 36 548 | 20 | 0 | 0 | 11 | 0 | 0 | **11** | **36 559** |
| `fast_food` | 30 298 | 17 276 | 3 122 | 0 | 9 156 | 468 | 0 | **9 624** | **39 922** |
| `bakery` | 29 491 | 27 083 | 1 939 | 52 463 | 14 354 | 291 | 27 805 | **42 450** | **71 941** |
| `atm` | 28 936 | 29 742 | 35 514 | 24 471 | 15 763 | 5 327 | 12 970 | **34 060** | **62 996** |
| `defibrillator` | 27 937 | 0 | 3 | 0 | 0 | 0 | 0 | **0** | **27 937** |
| `drinking_water` | 26 371 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **26 371** |
| `convenience` | 22 519 | 4 756 | 6 249 | 45 364 | 2 521 | 937 | 24 043 | **27 501** | **50 020** |
| `fountain` | 21 461 | 593 | 0 | 0 | 314 | 0 | 0 | **314** | **21 775** |
| `charging_station` | 21 396 | 190 | 883 | 0 | 101 | 132 | 0 | **233** | **21 629** |
| `bar` | 20 743 | 28 141 | 0 | 0 | 14 915 | 0 | 0 | **14 915** | **35 658** |
| `spring` | 19 427 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **19 427** |
| `pharmacy` | 19 133 | 17 472 | 1 908 | 21 591 | 9 260 | 286 | 11 443 | **20 989** | **40 122** |
| `viewpoint` | 18 727 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **18 727** |
| `post_office` | 17 458 | 8 436 | 13 877 | 8 763 | 4 471 | 2 082 | 4 644 | **11 197** | **28 655** |
| `cafe` | 17 129 | 15 262 | 701 | 0 | 8 089 | 105 | 0 | **8 194** | **25 323** |
| `supermarket` | 15 707 | 39 030 | 9 973 | 6 180 | 20 686 | 1 496 | 3 275 | **25 457** | **41 164** |
| `picnic_site` | 14 919 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **14 919** |
| `doctors` | 12 541 | 11 515 | 0 | 71 562 | 6 103 | 0 | 37 928 | **44 031** | **56 572** |
| `fuel` | 11 084 | 14 934 | 11 283 | 6 692 | 7 915 | 1 692 | 3 547 | **13 154** | **24 238** |
| `butcher` | 10 727 | 12 111 | 0 | 19 457 | 6 419 | 0 | 10 312 | **16 731** | **27 458** |
| `camp_site` | 9 153 | 8 191 | 0 | 9 986 | 4 341 | 0 | 5 293 | **9 634** | **18 787** |
| `pass` | 7 469 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **7 469** |
| `laundry` | 6 337 | 7 666 | 4 485 | 13 476 | 4 063 | 673 | 7 142 | **11 878** | **18 215** |
| `police` | 5 936 | 2 990 | 0 | 1 469 | 1 585 | 0 | 779 | **2 364** | **8 300** |
| `pub` | 4 422 | 3 831 | 0 | 0 | 2 030 | 0 | 0 | **2 030** | **6 452** |
| `outdoor_shop` | 4 036 | 6 975 | 1 312 | 12 335 | 3 697 | 197 | 6 538 | **10 432** | **14 468** |
| `train_station` | 4 022 | 5 187 | 0 | 0 | 2 749 | 0 | 0 | **2 749** | **6 771** |
| `marketplace` | 3 905 | 2 678 | 0 | 0 | 1 419 | 0 | 0 | **1 419** | **5 324** |
| `bicycle` | 3 837 | 1 033 | 82 | 0 | 547 | 12 | 0 | **559** | **4 396** |
| `caravan_site` | 3 598 | 1 332 | 752 | 0 | 706 | 113 | 0 | **819** | **4 417** |
| `water_tap` | 3 276 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **3 276** |
| `bicycle_repair` | 2 937 | 437 | 0 | 0 | 232 | 0 | 0 | **232** | **3 169** |
| `shower` | 2 717 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **2 717** |
| `hospital` | 2 383 | 6 397 | 0 | 8 955 | 3 390 | 0 | 4 746 | **8 136** | **10 519** |
| `clinic` | 1 993 | 15 895 | 0 | 0 | 8 424 | 0 | 0 | **8 424** | **10 417** |
| `water_point` | 1 966 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **1 966** |
| `ice_cream` | 1 803 | 1 705 | 166 | 0 | 904 | 25 | 0 | **929** | **2 732** |
| `vending_machine` | 1 684 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **1 684** |
| `compressed_air` | 1 588 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **1 588** |
| `wilderness_hut` | 1 135 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **1 135** |
| `bus_station` | 805 | 260 | 0 | 0 | 138 | 0 | 0 | **138** | **943** |
| `alpine_hut` | 654 | 0 | 0 | 0 | 0 | 0 | 0 | **0** | **654** |
| `ferry_terminal` | 616 | 103 | 0 | 0 | 55 | 0 | 0 | **55** | **671** |
| **TOTAL** | **680 603** | **493 449** | **97 511** | **444 694** | **261 528** | **14 625** | **235 690** | **511 841** | **1 192 444** |

### 6.2 Synthèse

| Scénario | Avant | Après | Δ |
| --- | ---: | ---: | ---: |
| **Recommandé** (SIRENE sans `fast_food`/`bar`) | 680 603 | **1 192 444** | **+511 841 (+75 %)** |
| + Foursquare (optionnel) | 680 603 | ≈ 1 212 000 | +78 % |
| Plafond (toutes catégories SIRENE) | 680 603 | 1 280 208 | +599 605 (+88 %) |

**Les 6 catégories qui gagnent le plus** : `restaurant` (+126 086), `hotel` (+57 096), `doctors` (+44 031), `bakery` (+42 450), `atm` (+34 060), `convenience` (+27 501).

**Incertitude** : ±12 %. Le taux de 47 % est désormais mesuré sur les deux sources avec la même méthode, ce qui rend la projection nettement plus solide que la version précédente.

### 6.3 Ce qui a changé depuis la première version

La première projection (+376 929, +55 %) reposait sur une hypothèse de **90 % de doublons SIRENE**, jamais mesurée. La mesure a donné 39 %, puis 47 % après récupération des noms d'exploitants. Trois raisons :

1. **Le registre est plus additif que supposé.** SIRENE référence des établissements qu'aucune base grand public ne liste.
2. **Le regroupement par adresse retire déjà 159 597 entrées** avant même la déduplication — l'effet « cabinets partagés » est traité en amont, pas compté comme doublon.
3. **La jointure `StockUniteLegale` débloque la déduplication par nom.** Sans elle, 59 % des POI arrivent anonymes et le taux mesuré plafonne à 39 %.

**La leçon méthodologique** : ne jamais projeter un gain net sur une hypothèse de doublons non mesurée. Un écart de 90 % à 47 % sur une seule source déplace le résultat final de 20 points.

---

## 7. Mise en œuvre

Les importeurs sont **écrits et testés** (`server/poi-ingest/`).

| Fichier | Rôle |
| --- | --- |
| `lib/common.mjs` | Taxonomie, normalisations, hachage d'ids, appel DuckDB, migration de schéma |
| `lib/dedupe.mjs` | Blocage spatial 200 m + 6 règles de scoring, statistiques par règle |
| `lib/mappings.mjs` | Overture `taxonomy.primary` → 46 clés ; NAF → 46 clés ; catégories OSM-only. `SIRENE_EXCLUDED_DEFAULT = ['fast_food','bar']` — définitions NAF trop divergentes de l'étiquette OSM (NAF 56.10C est 5× plus large que `amenity=fast_food`). Écart mesuré : 202 999 entrées |
| `lib/geo.mjs` | Rasterisation du polygone France (69 000 sommets) → test d'appartenance O(1) |
| `import-overture.mjs` | Extraction S3 → NDJSON → mapping → dédoublonnage → insertion |
| `import-sirene.mjs` | Jointure géoloc × StockEtablissement **× StockUniteLegale** → NAF → regroupement adresse → insertion. `--exclude-categories` / `--include-categories` |
| `import-atp.mjs` | Lecture ZIP sans dépendance ni chargement mémoire → mapping OSM direct |
| `rebuild-poi-db.sh` | `--with-external` enchaîne OSM → Overture → SIRENE → ATP |
| `server.js` | Expose `source` / `srcConfidence`, filtre `?sources=osm,overture` |

**Validations réelles effectuées** :

| Test | Résultat |
| --- | --- |
| Overture sur Lyon / Bordeaux / Drôme | 4 747 POI insérés · rtree synchronisé · `integrity_check` = `ok` · 0 orphelin |
| AllThePlaces, run complet | **96 772 POI** (l'analyse prévoyait 97 511) |
| SIRENE, jointure France entière | 797 829 lignes en 142 s (StockEtablissement lu à distance) |
| SIRENE + `StockUniteLegale` | **100 % des entrées nommées** (contre 41 %), 3 replis seulement |
| **Pipeline chaîné** OSM → Overture → SIRENE → ATP | 105 614 POI · rtree synchronisé · `integrity_check` = `ok` · ids dans les bonnes plages |
| **Idempotence** (rejeu de SIRENE) | 0 insertion, 8 246 doublons correctement détectés |
| Enrichissement croisé | 338 POI OSM complétés par AllThePlaces (téléphone, site, marque) |

**Commandes** :
```bash
# Pipeline complet (OSM + 3 sources externes)
./rebuild-poi-db.sh --with-external --swap

# Source par source
node import-overture.mjs --db data/pois.db --enrich
node import-sirene.mjs   --db data/pois.db
node import-atp.mjs --zip output.zip --db data/pois.db --enrich

# Toujours vérifier avant d'écrire
node import-overture.mjs --db data/pois.db --dry-run
```

**Prérequis** : binaire DuckDB (`curl -Ls https://install.duckdb.org | sh`). Aucune dépendance npm nouvelle — les importeurs réutilisent `better-sqlite3`, déjà déclaré par `server/poi-server/package.json`.**Disposition des fichiers.** Les importeurs sont écrits pour la disposition **plate** du déploiement (`/opt/poi-server/` : scripts, `lib/`, `poi-taxonomy.json` et `node_modules/` côte à côte). Dans le dépôt, ils tournent malgré tout grâce à deux mécanismes : `loadTaxonomy()` retombe sur `src/features/poi/poi-taxonomy.json`, et `requireFromServer()` résout `better-sqlite3` depuis `server/poi-server/` (qui n'est **pas** un dossier ancêtre de `poi-ingest/`, la résolution ESM standard échouerait). En local, `better-sqlite3` doit donc être installé dans `server/poi-server/`.

**Fréquence recommandée** : Overture mensuelle, ATP hebdomadaire, SIRENE mensuelle, OSM mensuelle. Rafraîchissement global trimestriel via `rebuild-poi-db.sh --with-external --swap`.

**Coûts** : ~2 Go de disque pour l'extrait Overture France, 810 Mo pour SIRENE géoloc (le StockEtablissement de 2,21 Go n'est **pas** téléchargé), 2,44 Go pour l'ATP. Ingestion complète : ~10 min de calcul (mesuré : ATP 18 s, SIRENE 142 s de jointure).

---

## 8. Risques et points de vigilance

1. **Licences.** OSM est en ODbL (share-alike) ; Overture en CDLA-Permissive-2.0 / Apache-2.0, ATP en CC0, SIRENE en Licence Ouverte 2.0. Le mélange est autorisé, mais **la partie dérivée d'OSM reste soumise à l'ODbL**. La colonne `source` par enregistrement est indispensable pour rester en conformité et pouvoir retirer une source.

2. **Volume côté client — mesuré, et le risque est plus étroit que prévu.**

   Mesure sur un itinéraire réel (Lyon → Briançon, ~269 km, corridor serveur 1 000 m) :

   | Régime | Marqueurs DOM avant | après | × |
   | --- | ---: | ---: | ---: |
   | **Nominal** — défaut 40 m, catégories actives par défaut | **103** | **195** | ×1,90 |
   | **Curseur poussé** — filtre latéral à 1 000 m, toutes catégories | **6 590** | **11 959** | ×1,81 |

   **Le cas nominal ne pose aucun problème** : 195 marqueurs DOM, c'est négligeable. Le défaut livré (`distanceM: 40` par catégorie dans `defaultState.ts`) protège efficacement l'application.

   Le risque est réel mais **concentré sur le cas « curseur poussé »**. `usePoi.ts` documente une politique « EXHAUSTIVE BY DESIGN » — *« no density cap, no top N per km shortlist, no zoom-based culling »* — et `PoiMarkerManager` crée **un `mapboxgl.Marker` (élément DOM) par POI**. À 11 959 marqueurs :
   - `map.on('zoom')` parcourt tous les marqueurs et écrit `--rv-poi-marker-scale` sur chacun → ~12 000 écritures DOM par frame (throttlé en rAF, mais non borné) ;
   - `map.on('idle')` re-projette tous les marqueurs.

   À noter : **6 590 marqueurs est déjà le régime actuel**, et le commentaire du code qualifie déjà ce volume d'« untenable ». L'enrichissement ne crée pas le problème, il le double.

   **Ce qui existe déjà mais n'est pas branché** : `src/features/poi/lib/refinePoiClustering.ts` fournit `buildPoiClusters()` et `capPoisPerCategory()` — exactement le « top N per km » qui a été retiré. Ces fonctions ne sont appelées **que par le benchmark** `script-test-bench/bench-poi.ts`, jamais par l'application. Les rebrancher (ou ajouter une mise en grappe à bas zoom) est la piste naturelle si le curseur 1 000 m devient un usage courant.

   **Coût incompressible** : le serveur renvoie 6 590 → 11 959 features sur cette route (+81 %), et le client déduplique et filtre latéralement sur l'ensemble — indépendamment de ce qui est finalement rendu.

3. **`--with-external` n'a jamais tourné sur la France entière.** Chaque importeur est validé individuellement et le pipeline chaîné l'est sur un banc d'essai (3 zones, 105 614 POI). Une tentative d'import France complète a été lancée puis **arrêtée au bout de 11 min** : la seule reconstruction OSM à partir du PBF Geofabrik (4,74 Go, `import-osm.mjs`) n'avait pas fini sa phase 1. Prévoir **plusieurs heures** au total sur une machine de bureau, pas « ~10 min » — les 10 min annoncées ne couvrent que les sources externes (ATP 18 s, jointure SIRENE 142 s). À lancer sur le VPS, pas en local, et en `--dry-run` d'abord.

   *Artefacts de test laissés sur disque (~8,5 Go, supprimables)* : `C:\tmp\france` (PBF 4,8 Go), `C:\tmp\test` (514 Mo), `%TEMP%\atp` (2,3 Go), `%TEMP%\sirene` (774 Mo), `C:\tmp\vps` (158 Mo).

4. **Qualité Overture.** Doublons internes et déchets assumés. Le filtre `confidence ≥ 0,5` est le minimum ; `≥ 0,7` réduit le volume mappable de ~14 % mais améliore nettement la précision.

5. **SIRENE et les horaires.** Aucune donnée d'ouverture. Les POI SIRENE doivent être présentés comme des points de repère. Ne pas les traiter comme des étapes planifiables au même titre qu'un POI OSM.

6. **Foursquare « gated ».** Blocage administratif (compte Hugging Face + acceptation). À anticiper si l'on veut cette source.

7. **Fusions à surveiller.** Le conflate Overture → SIRENE sur les chaînes est le point délicat : noms légèrement différents, points distants de quelques mètres. Le scoring par téléphone, site web et adresse est ce qui évite la duplication massive.

8. **Favoris existants.** Les POI OSM conservent leurs ids. Les nouveaux POI externes ont des ids dans de nouveaux namespaces (`3e13`…`6e13`) : aucun risque de collision, mais ils ne matcheront aucun favori existant — comportement attendu.

---

## 9. Annexe — reproduire les mesures

Tous les scripts de mesure sont versionnés dans **`script-test-bench/poi-external/`**, numérotés dans l'ordre d'exécution.

```bash
cd script-test-bench/poi-external
PY="C:/Users/simon/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe"   # duckdb + shapely
NODE="C:/Users/simon/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe"

# 1-2. Overture — extraction France, puis comptage par catégorie
"$PY" 01-overture-extract-fr.py && "$PY" 02-overture-count-by-category.py

# 3. AllThePlaces — analyse France (masque polygone, pas de bbox)
curl -o output.zip https://alltheplaces-data.openaddresses.io/runs/2026-09-19-13-32-18/output.zip
"$PY" 03-atp-analyze-fr.py

# 4. SIRENE — schéma, distribution NAF, correspondance, extraits
"$PY" 04-sirene-schema.py && "$PY" 05-sirene-naf-distribution.py && "$PY" 06-sirene-naf-to-categories.py
"$PY" 07-sirene-extract.py && "$PY" 08-sirene-extract-with-unite-legale.py

# 5. Taux de doublons (20 zones témoin, interroge la base live)
"$PY" 09-dedup-overture-vs-osm.py
"$NODE" 10-dedup-sirene-vs-osm-overture.mjs
"$NODE" 11-dedup-robustness-address.mjs

# 6. Projection et impact client
"$PY" 12-projection.py
"$NODE" 13-client-impact.mjs     # marqueurs DOM : nominal 40 m vs curseur 1000 m
```

Les trois `fixture-*.py|mjs` construisent le banc d'essai (base OSM de test sur 3 zones, extraits NDJSON restreints) utilisé pour valider les importeurs sans attendre un import France complet.

**Dépendances** : `duckdb` 1.5.5 et `shapely` 2.1.2 dans le venv isolé ; accès S3 `us-west-2` pour Overture ; `better-sqlite3` et `osm-pbf-parser` pour les importeurs. Les scripts Python utilisent des chemins absolus Windows — `/tmp` y désigne `C:\tmp`, pas le `/tmp` de Git Bash.

---

## 10. Résultat en production

Le pipeline a été exécuté sur le VPS le 23 septembre 2026, sur une **copie** de la base, puis basculé via `swap-db.sh` (qui a conservé une sauvegarde horodatée de l'ancienne base).

| | Base avant | Base après |
| --- | ---: | ---: |
| POI | 680 603 | **1 309 445** |
| POI sans nom | 223 966 | 223 966 (inchangé) |
| Catégories distinctes | 46 | 46 |

**Contrôles au moment de la bascule** : `integrity_check` = `ok` · `pois` = `poi_rtree` (1 309 445) · 0 orphelin · 0 manquant · 46 catégories · plages d'ids disjointes.

| Source | POI ajoutés | Projeté | Doublons écartés | Taux réel |
| --- | ---: | ---: | ---: | ---: |
| Overture | **297 612** | 261 528 | 196 363 | 40 % |
| SIRENE | **315 161** | 235 690 | 149 292 | 32 % |
| AllThePlaces | **16 069** | 14 625 | 84 300 | 84 % |
| **Total** | **628 842** | **511 841** | | |

**Le total réel (+92 %) dépasse la projection (+75 %)**, et de manière cohérente : les deux sources principales ont eu un taux de doublons réel **inférieur** à celui mesuré sur l'échantillon de 20 zones. L'échantillon était biaisé urbain — et c'est justement là qu'OSM et les bases commerciales se recouvrent le plus. En zone rurale, où OSM est peu dense, les sources externes sont nettement plus additives.

**Autre apport, non chiffré dans la projection** : **191 410 POI existants ont été enrichis** — 154 907 par Overture (téléphone, site, marque, quand le tag OSM était absent) et 36 503 par AllThePlaces.

**Détail des détections SIRENE** : `name-exact` 62 % · `address` 18 % · `name-strong` 10 % · `name-category` 10 %. La jointure `StockUniteLegale` est ce qui rend `name-exact` dominant — sans elle, 471 910 POI n'auraient pas de nom et seraient passés inaperçus.

**Durées mesurées sur le VPS (Oracle A1, ARM64, 4 Go)** : extraction Overture depuis S3 **17 min 37 s**, dédoublonnage + insertion Overture **2 min 07 s**, jointure SIRENE **45 s**, dédoublonnage + insertion SIRENE **~3 min**, analyse ATP (4 Go, 5 260 fichiers) **~2 min**. Total ~25 min.
