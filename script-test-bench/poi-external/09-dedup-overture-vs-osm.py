# -*- coding: utf-8 -*-
"""Mesure du taux de doublons OSM(base RedView) <-> Overture, sur 20 zones representatives."""
import duckdb, re, json, math, unicodedata, urllib.request, collections

con = duckdb.connect(); con.execute("LOAD spatial;")
F = "C:/tmp/fr_overture.parquet"
BASE = "http://141.145.220.99/poi/bbox"

TAXO = json.load(open('C:/Users/simon/Documents/REDVIEWproduction/redview-app/src/features/poi/poi-taxonomy.json', encoding='utf-8'))
ALL = [c['key'] for c in TAXO['categories']]

MAP = [("fast_food", r"(fast_food|casual_eatery|food_truck|sandwich_shop|burger|fried_chicken|hot_dog)"),
 ("ice_cream", r"(ice_cream|gelato|frozen_yogurt|sorbet)"),
 ("cafe", r"(^cafe$|coffee_shop|coffee|tea_room|bubble_tea|juice_bar|smoothie|internet_cafe)"),
 ("pub", r"(^pub$|irish_pub|beer_garden|biergarten|taproom|gastropub)"),
 ("bar", r"(^bar$|_bar$|cocktail|wine_bar|sports_bar|gay_bar|hookah|nightlife_venue|^lounge$|karaoke)"),
 ("restaurant", r"(_restaurant$|^restaurant$|^bistro$|^brasserie$|^diner$|^cafeteria$|^eatery$|^food_court$)"),
 ("bakery", r"(^bakery$|patisserie|pastry_shop|cupcake|donut|bagel_shop|pie_shop)"),
 ("butcher", r"(butcher|meat_shop|charcuterie|delicatessen|fishmonger|seafood_market)"),
 ("supermarket", r"(^supermarket$|grocery_store|^superstore$|hypermarket|warehouse_club_store)"),
 ("convenience", r"(convenience_store|corner_store|mini_market)"),
 ("marketplace", r"(farmers_market|^market$|flea_market|public_market|food_bank)"),
 ("hotel", r"(^hotel$|^motel$|^hostel$|bed_and_breakfast|guest_house|^inn$|^lodging$|private_lodging|holiday_rental_home|service_apartment|^resort$|^chalet$|^apartment$|aparthotel|^condominium$|^cabin)"),
 ("camp_site", r"(^campground$|camp_site|^camping)"),
 ("caravan_site", r"(rv_park|caravan_site|trailer_park|mobile_home)"),
 ("bicycle", r"(bicycle_store|bike_shop|bicycle_shop|bike_rental)"),
 ("bicycle_repair", r"(bike_repair|bicycle_repair|bike_service)"),
 ("charging_station", r"(ev_charging_station|charging_station)"),
 ("outdoor_shop", r"(outdoor_store|sporting_goods_store|sportswear_store|ski_and_snowboard_store|surf_store|hunting_and_fishing_store|scuba|diving_|camping_store)"),
 ("pharmacy", r"(^pharmacy$|pharmacy_and_drug_store|^drugstore$|^chemist)"),
 ("hospital", r"(^hospital$|specialty_hospital)"),
 ("clinic", r"(_clinic$|^clinic$|outpatient_care_facility|^surgery$|urgent_care|medical_center|health_care)"),
 ("doctors", r"(family_practice|^doctor|^physician|general_practitioner|primary_care|medical_service|^dentist|dental_clinic|^podiatry|chiropractic|osteopath)"),
 ("police", r"(police_station|^police$)"),
 ("train_station", r"(train_station|railway_station|metro_station|transit_station|^tram_station)"),
 ("bus_station", r"(bus_station|bus_terminal)"),
 ("ferry_terminal", r"(ferry_terminal|ferry_service|ferry_boat)"),
 ("toilets", r"(public_restroom|^restroom|public_toilet)"),
 ("fuel", r"(gas_station|fueling_station|fuel_station|petrol_station|truck_gas_station)"),
 ("atm", r"(^atm$|^bank$|bank_or_credit_union|credit_union)"),
 ("post_office", r"(post_office|postal_service)"),
 ("laundry", r"(laundry_service|laundromat|dry_cleaner|^laundry)"),
 ("fountain", r"(public_fountain|^fountain)")]

def norm(s):
    if not s: return ''
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\b(sarl|sas|sasu|sa|eurl|snc|sci|scp|ets|etablissements?|restaurant|hotel|le|la|les|du|de|des|l|d|chez)\b', ' ', s)
    return re.sub(r'[^a-z0-9]', '', s)

def phone(s):
    if not s: return ''
    d = re.sub(r'\D', '', s)
    if d.startswith('33'): d = '0' + d[2:]
    return d if len(d) >= 9 else ''

def domain(s):
    if not s: return ''
    m = re.search(r'https?://([^/]+)', s) or re.search(r'^([a-z0-9.-]+\.[a-z]{2,})', s, re.I)
    return (m.group(1).lower().replace('www.', '') if m else '')

def hav(a, b, c, d):
    R = 6371000; p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))

def fetch(s, w, n, e):
    q = f"{BASE}?south={s}&west={w}&north={n}&east={e}&limit=2000&categories={','.join(ALL)}"
    try:
        with urllib.request.urlopen(q, timeout=45) as r: return json.load(r)['features']
    except Exception as ex: print("   ERR", ex); return []

ZONES = {
 "Paris 1-2":       (48.860, 2.330, 48.872, 2.350),
 "Paris 11":        (48.850, 2.365, 48.862, 2.385),
 "Lyon Presqu'ile": (45.750, 4.820, 45.765, 4.845),
 "Marseille Vieux": (43.288, 5.360, 43.300, 5.380),
 "Bordeaux centre": (44.835, -0.585, 44.848, -0.565),
 "Toulouse centre": (43.595, 1.435, 43.608, 1.455),
 "Nantes centre":   (47.208, -1.565, 47.222, -1.545),
 "Lille centre":    (50.630, 3.050, 50.642, 3.070),
 "Strasbourg":      (48.575, 7.735, 48.588, 7.755),
 "Nice centre":     (43.695, 7.260, 43.708, 7.280),
 "Rennes":          (48.105, -1.690, 48.118, -1.670),
 "Montpellier":     (43.605, 3.870, 43.618, 3.890),
 "Annecy":          (45.893, 6.118, 45.905, 6.138),
 "Chamonix":        (45.915, 6.855, 45.928, 6.880),
 "Clermont-Fd":     (45.772, 3.075, 45.785, 3.095),
 "Rural Aveyron":   (44.300, 2.500, 44.340, 2.560),
 "Rural Correze":   (45.200, 1.600, 45.240, 1.660),
 "Rural Lozere":    (44.500, 3.400, 44.540, 3.460),
 "Alpes Briancon":  (44.890, 6.620, 44.910, 6.660),
 "Pyrenees Luchon": (42.680, 0.580, 42.710, 0.620),
}

print(f"{'ZONE':<20}{'BASE':>6}{'CAP':>5}{'OVERT':>7}{'DUP':>6}{'NEW':>6}{'%dup':>7}")
g = collections.Counter()
for name, (s, w, n, e) in ZONES.items():
    b = fetch(s, w, n, e)
    capped = 'OUI' if len(b) >= 2000 else ''
    ov = con.execute(f"""SELECT name,lat,lon,coalesce(tax_primary,basic_category) FROM '{F}'
        WHERE country='FR' AND lat>={s} AND lat<={n} AND lon>={w} AND lon<={e}""").fetchall()
    ovm = []
    for nm, la, lo, lab in ov:
        if not lab: continue
        for k, p in MAP:
            if re.search(p, lab, re.I): ovm.append((nm, la, lo)); break
    idx = []
    for f in b:
        t = f.get('tags') or {}
        idx.append((norm(f.get('name')), hav, f['lat'], f['lon'],
                    phone(t.get('phone') or t.get('contact:phone')),
                    domain(t.get('website') or t.get('contact:website'))))
    dup = 0
    for nm, la, lo in ovm:
        n2 = norm(nm); hit = False
        for bn, _, bla, blo, bp, bd in idx:
            d = hav(la, lo, bla, blo)
            if d > 400: continue
            if n2 and bn and (n2 == bn or (len(n2) >= 5 and (n2 in bn or bn in n2))) and d <= 200: hit = True; break
        if hit: dup += 1
    new = len(ovm) - dup
    print(f"{name:<20}{len(b):>6}{capped:>5}{len(ovm):>7}{dup:>6}{new:>6}{(100*dup/max(len(ovm),1)):>6.0f}%")
    g['base'] += len(b); g['ov'] += len(ovm); g['dup'] += dup
print("-" * 57)
print(f"{'TOTAL':<20}{g['base']:>6}{'':>5}{g['ov']:>7}{g['dup']:>6}{g['ov']-g['dup']:>6}{(100*g['dup']/max(g['ov'],1)):>6.0f}%")
