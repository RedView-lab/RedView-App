/**
 * RedView — tables de correspondance des sources externes vers les 46
 * catégories de `poi-taxonomy.json`.
 *
 * Contrainte produit : **aucune catégorie nouvelle**. Tout lieu externe qui ne
 * tombe dans aucune des 46 clés est écarté, même s'il est pertinent par
 * ailleurs (cabinets de kiné, garages, écoles…). La base reste une base
 * d'itinéraire cycliste, pas un annuaire d'entreprises.
 *
 * Les règles sont ordonnées : la première qui correspond gagne. C'est
 * indispensable — `fast_food_restaurant` doit devenir `fast_food` et non
 * `restaurant`, `convenience_store` doit devenir `convenience` et non
 * `supermarket`.
 */

/**
 * Overture : correspondance sur `taxonomy.primary` (niveau fin, ~2 300
 * catégories). On n'utilise pas `basic_category`, trop grossier : il range
 * boulangerie, boucherie et supérette dans le même « food_and_beverage_store ».
 */
const OVERTURE_RULES = [
  ['fast_food', /(fast_food|casual_eatery|food_truck|sandwich_shop|burger|fried_chicken|hot_dog)/i],
  ['ice_cream', /(ice_cream|gelato|frozen_yogurt|sorbet)/i],
  ['cafe', /(^cafe$|coffee_shop|coffee|tea_room|bubble_tea|juice_bar|smoothie|internet_cafe)/i],
  ['pub', /(^pub$|irish_pub|beer_garden|biergarten|taproom|gastropub)/i],
  ['bar', /(^bar$|_bar$|cocktail|wine_bar|sports_bar|gay_bar|hookah|nightlife_venue|^lounge$|karaoke)/i],
  ['restaurant', /(_restaurant$|^restaurant$|^bistro$|^brasserie$|^diner$|^cafeteria$|^eatery$|^food_court$|^buffet)/i],
  ['bakery', /(^bakery$|patisserie|pastry_shop|cupcake|donut|bagel_shop|pie_shop|^baker)/i],
  ['butcher', /(butcher|meat_shop|charcuterie|delicatessen|fishmonger|seafood_market|meat_wholesaler|poultry)/i],
  ['supermarket', /(^supermarket$|grocery_store|^superstore$|hypermarket|warehouse_club_store|^grocery)/i],
  ['convenience', /(convenience_store|corner_store|mini_market|^convenience)/i],
  ['marketplace', /(farmers_market|^market$|^markets$|flea_market|public_market|street_market|food_bank)/i],
  ['hotel', /(^hotel$|^motel$|^hostel$|bed_and_breakfast|guest_house|^inn$|^lodging$|private_lodging|holiday_rental_home|service_apartment|^resort$|^chalet$|^apartment$|^apartments$|aparthotel|^condominium$|^cabin)/i],
  ['camp_site', /(^campground$|camp_site|^camping)/i],
  ['caravan_site', /(rv_park|caravan_site|trailer_park|mobile_home)/i],
  ['bicycle', /(bicycle_store|bike_shop|bicycle_shop|^bicycle$|bike_rental)/i],
  ['bicycle_repair', /(bike_repair|bicycle_repair|bike_service)/i],
  ['charging_station', /(ev_charging_station|charging_station|electric_vehicle_charging)/i],
  ['outdoor_shop', /(outdoor_store|sporting_goods_store|sportswear_store|ski_and_snowboard_store|surf_store|hunting_and_fishing_store|scuba|diving_|camping_store|^outdoor)/i],
  ['pharmacy', /(^pharmacy$|pharmacy_and_drug_store|^drugstore$|^chemist)/i],
  ['hospital', /(^hospital$|specialty_hospital|^hospitals$)/i],
  ['clinic', /(_clinic$|^clinic$|outpatient_care_facility|^surgery$|urgent_care|medical_center|health_care)/i],
  ['doctors', /(family_practice|^doctor|^physician|general_practitioner|primary_care|medical_service|^dentist|dental_clinic|^podiatry|chiropractic|osteopath)/i],
  ['police', /(police_station|^police$)/i],
  ['train_station', /(train_station|railway_station|metro_station|transit_station|^tram_station|light_rail)/i],
  ['bus_station', /(bus_station|bus_terminal|coach_station)/i],
  ['ferry_terminal', /(ferry_terminal|ferry_service|ferry_boat)/i],
  ['toilets', /(public_restroom|^restroom|public_toilet|^toilet)/i],
  ['fuel', /(gas_station|fueling_station|fuel_station|petrol_station|truck_gas_station|^fuel)/i],
  ['atm', /(^atm$|^bank$|bank_or_credit_union|credit_union|^banks$)/i],
  ['post_office', /(post_office|postal_service|^poste$)/i],
  ['laundry', /(laundry_service|laundromat|dry_cleaner|^laundry)/i],
  ['viewpoint', /(scenic_viewpoint|^lookout|viewpoint|observation_deck|^vista$|^belvedere)/i],
  ['picnic_site', /(picnic_area|picnic_site|picnic_ground|^picnic)/i],
  ['fountain', /(public_fountain|^fountain)/i],
  ['pass', /(mountain_pass|^saddle$)/i],
];

/**
 * @param {string|null} taxPrimary   `taxonomy.primary` Overture
 * @param {string|null} basicCategory repli sur `basic_category` si absent
 * @returns {string|null} clé RedView
 */
export function overtureCategory(taxPrimary, basicCategory) {
  const label = taxPrimary || basicCategory;
  if (!label) return null;
  for (const [key, re] of OVERTURE_RULES) {
    if (re.test(label)) return key;
  }
  return null;
}

export const OVERTURE_MAPPED_KEYS = OVERTURE_RULES.map(([k]) => k);

/**
 * SIRENE : correspondance sur `activitePrincipaleEtablissement` (NAF rév. 2).
 *
 * ⚠️ `55.20Z` (hébergement touristique et autre hébergement de courte durée,
 * 137 750 établissements en France) est **volontairement exclu** : il s'agit
 * très majoritairement de meublés de tourisme déclarés en mairie, c'est-à-dire
 * de logements privés, pas d'hôtels. L'inclure ferait exploser la catégorie
 * `hotel` d'un facteur 4 avec des adresses résidentielles.
 */
const SIRENE_NAF = {
  '56.10A': 'restaurant',
  '56.10B': 'fast_food',
  '56.10C': 'fast_food',
  '56.30Z': 'bar',
  '47.11B': 'convenience',
  '47.11C': 'supermarket',
  '47.11D': 'convenience',
  '47.22Z': 'butcher',
  '10.13A': 'butcher',
  '10.13B': 'butcher',
  '47.24Z': 'bakery',
  '10.71B': 'bakery',
  '10.71C': 'bakery',
  '10.71D': 'bakery',
  '47.30Z': 'fuel',
  '47.64Z': 'outdoor_shop',
  '47.73Z': 'pharmacy',
  '53.10Z': 'post_office',
  '55.10Z': 'hotel',
  '55.90Z': 'hotel',
  '55.30Z': 'camp_site',
  '64.19Z': 'atm',
  '84.24Z': 'police',
  '86.10Z': 'hospital',
  '86.21Z': 'doctors',
  '86.22A': 'doctors',
  '86.22B': 'doctors',
  '86.22C': 'doctors',
  '96.01A': 'laundry',
  '96.01B': 'laundry',
};

/** Codes NAF retenus, sous forme de liste SQL. */
export const SIRENE_NAF_CODES = Object.keys(SIRENE_NAF);

/** @returns {string|null} clé RedView */
export function sireneCategory(naf) {
  return naf ? (SIRENE_NAF[naf] ?? null) : null;
}

/**
 * Catégories SIRENE écartées par défaut.
 *
 * Ce ne sont pas des catégories « en trop », ce sont des **définitions qui
 * divergent** entre le NAF et OSM :
 *
 *   - `fast_food` (NAF 56.10C, 122 279 établissements après regroupement) est
 *     **5× plus large** que `amenity=fast_food`. Il englobe tous les petits
 *     comptoirs de vente à emporter, y compris des lieux qu'OSM cartographie
 *     déjà sous une autre étiquette (boulangerie avec comptoir snacking,
 *     épicerie avec vente de sandwichs). Les importer noierait la carte sans
 *     valeur ajoutée — c'est le poste le plus volumineux de SIRENE et le moins
 *     fiable pour un itinéraire.
 *   - `bar` (NAF 56.30Z, 43 313) souffre du même biais : la catégorie couvre
 *     toute « débit de boissons », y compris les établissements sans activité
 *     réelle de bar.
 *
 * Retirer une clé de cette liste suffit à la réintégrer (`--include-categories`).
 * Mesuré : les exclure fait passer SIRENE de +323 000 à +236 000 POI nets.
 */
export const SIRENE_EXCLUDED_DEFAULT = ['fast_food', 'bar'];

/** Catégories que SIRENE peut alimenter, après exclusions. */
export const SIRENE_CATEGORIES = [...new Set(Object.values(SIRENE_NAF))]
  .filter((k) => !SIRENE_EXCLUDED_DEFAULT.includes(k));

/**
 * Catégories qu'aucune source externe n'alimente. Elles décrivent de
 * l'infrastructure de terrain sans propriétaire : aucune base commerciale ne
 * les couvre, et OSM les couvre déjà à 95-100 %. C'est la valeur propre de
 * RedView — utile à rappeler quand on lit les gains par catégorie.
 */
export const OSM_ONLY_KEYS = [
  'drinking_water', 'water_point', 'water_tap', 'spring', 'shelter',
  'defibrillator', 'viewpoint', 'picnic_site', 'pass', 'shower',
  'vending_machine', 'compressed_air', 'wilderness_hut', 'alpine_hut',
];
