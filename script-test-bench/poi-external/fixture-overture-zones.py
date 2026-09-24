# -*- coding: utf-8 -*-
"""Extrait Overture (categories RedView, conf>=0.5) sur les 20 zones temoin."""
import duckdb, json, os, re

OUT = 'C:/tmp/test/overture-zones.ndjson'
ZONES = {
 "Paris 1-2":(48.860,2.330,48.872,2.350),"Paris 11":(48.850,2.365,48.862,2.385),
 "Lyon Presqu'ile":(45.750,4.820,45.765,4.845),"Marseille Vieux":(43.288,5.360,43.300,5.380),
 "Bordeaux centre":(44.835,-0.585,44.848,-0.565),"Toulouse centre":(43.595,1.435,43.608,1.455),
 "Nantes centre":(47.208,-1.565,47.222,-1.545),"Lille centre":(50.630,3.050,50.642,3.070),
 "Strasbourg":(48.575,7.735,48.588,7.755),"Nice centre":(43.695,7.260,43.708,7.280),
 "Rennes":(48.105,-1.690,48.118,-1.670),"Montpellier":(43.605,3.870,43.618,3.890),
 "Annecy":(45.893,6.118,45.905,6.138),"Chamonix":(45.915,6.855,45.928,6.880),
 "Clermont-Fd":(45.772,3.075,45.785,3.095),"Rural Aveyron":(44.300,2.500,44.340,2.560),
 "Rural Correze":(45.200,1.600,45.240,1.660),"Rural Lozere":(44.500,3.400,44.540,3.460),
 "Alpes Briancon":(44.890,6.620,44.910,6.660),"Pyrenees Luchon":(42.680,0.580,42.710,0.620),
}
where = " OR ".join([f"(lat BETWEEN {s} AND {n} AND lon BETWEEN {w} AND {e})" for s,w,n,e in ZONES.values()])

MAP = [("fast_food",r"(fast_food|casual_eatery|food_truck|sandwich_shop|burger|fried_chicken|hot_dog)"),
("ice_cream",r"(ice_cream|gelato|frozen_yogurt|sorbet)"),
("cafe",r"(^cafe$|coffee_shop|coffee|tea_room|bubble_tea|juice_bar|smoothie|internet_cafe)"),
("pub",r"(^pub$|irish_pub|beer_garden|biergarten|taproom|gastropub)"),
("bar",r"(^bar$|_bar$|cocktail|wine_bar|sports_bar|gay_bar|hookah|nightlife_venue|^lounge$|karaoke)"),
("restaurant",r"(_restaurant$|^restaurant$|^bistro$|^brasserie$|^diner$|^cafeteria$|^eatery$|^food_court$)"),
("bakery",r"(^bakery$|patisserie|pastry_shop|cupcake|donut|bagel_shop|pie_shop)"),
("butcher",r"(butcher|meat_shop|charcuterie|delicatessen|fishmonger|seafood_market)"),
("supermarket",r"(^supermarket$|grocery_store|^superstore$|hypermarket|warehouse_club_store)"),
("convenience",r"(convenience_store|corner_store|mini_market)"),
("marketplace",r"(farmers_market|^market$|flea_market|public_market|food_bank)"),
("hotel",r"(^hotel$|^motel$|^hostel$|bed_and_breakfast|guest_house|^inn$|^lodging$|private_lodging|holiday_rental_home|service_apartment|^resort$|^chalet$|^apartment$|aparthotel|^condominium$|^cabin)"),
("camp_site",r"(^campground$|camp_site|^camping)"),
("caravan_site",r"(rv_park|caravan_site|trailer_park|mobile_home)"),
("bicycle",r"(bicycle_store|bike_shop|bicycle_shop|bike_rental)"),
("bicycle_repair",r"(bike_repair|bicycle_repair|bike_service)"),
("charging_station",r"(ev_charging_station|charging_station)"),
("outdoor_shop",r"(outdoor_store|sporting_goods_store|sportswear_store|ski_and_snowboard_store|surf_store|hunting_and_fishing_store|scuba|diving_|camping_store)"),
("pharmacy",r"(^pharmacy$|pharmacy_and_drug_store|^drugstore$|^chemist)"),
("hospital",r"(^hospital$|specialty_hospital)"),
("clinic",r"(_clinic$|^clinic$|outpatient_care_facility|^surgery$|urgent_care|medical_center|health_care)"),
("doctors",r"(family_practice|^doctor|^physician|general_practitioner|primary_care|medical_service|^dentist|dental_clinic|^podiatry|chiropractic|osteopath)"),
("police",r"(police_station|^police$)"),
("train_station",r"(train_station|railway_station|metro_station|transit_station|^tram_station)"),
("bus_station",r"(bus_station|bus_terminal)"),
("ferry_terminal",r"(ferry_terminal|ferry_service|ferry_boat)"),
("toilets",r"(public_restroom|^restroom|public_toilet)"),
("fuel",r"(gas_station|fueling_station|fuel_station|petrol_station|truck_gas_station)"),
("atm",r"(^atm$|^bank$|bank_or_credit_union|credit_union)"),
("post_office",r"(post_office|postal_service)"),
("laundry",r"(laundry_service|laundromat|dry_cleaner|^laundry)"),
("fountain",r"(public_fountain|^fountain)")]

con = duckdb.connect(); con.execute("LOAD spatial;"); con.execute("SET enable_progress_bar=false;")
rows = con.execute(f"""SELECT id, name, coalesce(tax_primary,basic_category) lab, confidence,
 street, city, postcode, phone, website, lat, lon FROM '/tmp/fr_overture.parquet'
 WHERE confidence>=0.5 AND ({where})""").fetchall()
n=0
with open(OUT,'w',encoding='utf-8') as f:
    for gid,name,lab,conf,street,city,cp,phone,web,lat,lon in rows:
        if not lab: continue
        cat=None
        for k,p in MAP:
            if re.search(p,lab,re.I): cat=k; break
        if not cat or not name: continue
        tags={}
        if street: tags['addr:street']=street
        if city: tags['addr:city']=city
        if cp: tags['addr:postcode']=cp
        if phone: tags['phone']=phone
        if web: tags['website']=web
        f.write(json.dumps({'id':gid,'name':name,'category':cat,'tags':tags,'lat':lat,'lon':lon},ensure_ascii=False)+"\n")
        n+=1
print(f"Overture zones : {n} lieux -> {OUT}")
