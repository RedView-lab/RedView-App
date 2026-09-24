# -*- coding: utf-8 -*-
import duckdb, re, json
con=duckdb.connect(); con.execute("LOAD spatial;")
F="'/tmp/fr_overture.parquet'"
MAP=[("fast_food",r"(fast_food|casual_eatery|food_truck|sandwich_shop|burger|fried_chicken|hot_dog)"),("ice_cream",r"(ice_cream|gelato|frozen_yogurt|sorbet)"),("cafe",r"(^cafe$|coffee_shop|coffee|tea_room|bubble_tea|juice_bar|smoothie|internet_cafe)"),("pub",r"(^pub$|irish_pub|beer_garden|biergarten|taproom|gastropub)"),("bar",r"(^bar$|_bar$|cocktail|wine_bar|sports_bar|gay_bar|hookah|nightlife_venue|^lounge$|karaoke)"),("restaurant",r"(_restaurant$|^restaurant$|^bistro$|^brasserie$|^diner$|^cafeteria$|^eatery$|^food_court$)"),("bakery",r"(^bakery$|patisserie|pastry_shop|cupcake|donut|bagel_shop|pie_shop)"),("butcher",r"(butcher|meat_shop|charcuterie|delicatessen|fishmonger|seafood_market)"),("supermarket",r"(^supermarket$|grocery_store|^superstore$|hypermarket|warehouse_club_store)"),("convenience",r"(convenience_store|corner_store|mini_market)"),("marketplace",r"(farmers_market|^market$|flea_market|public_market|food_bank)"),("hotel",r"(^hotel$|^motel$|^hostel$|bed_and_breakfast|guest_house|^inn$|^lodging$|private_lodging|holiday_rental_home|service_apartment|^resort$|^chalet$|^apartment$|aparthotel|^condominium$|^cabin)"),("camp_site",r"(^campground$|camp_site|^camping)"),("caravan_site",r"(rv_park|caravan_site|trailer_park|mobile_home)"),("bicycle",r"(bicycle_store|bike_shop|bicycle_shop|bike_rental)"),("bicycle_repair",r"(bike_repair|bicycle_repair|bike_service)"),("charging_station",r"(ev_charging_station|charging_station)"),("outdoor_shop",r"(outdoor_store|sporting_goods_store|sportswear_store|ski_and_snowboard_store|surf_store|hunting_and_fishing_store|scuba|diving_|camping_store)"),("pharmacy",r"(^pharmacy$|pharmacy_and_drug_store|^drugstore$|^chemist)"),("hospital",r"(^hospital$|specialty_hospital)"),("clinic",r"(_clinic$|^clinic$|outpatient_care_facility|^surgery$|urgent_care|medical_center|health_care)"),("doctors",r"(family_practice|^doctor|^physician|general_practitioner|primary_care|medical_service|^dentist|dental_clinic|^podiatry|chiropractic|osteopath)"),("police",r"(police_station|^police$)"),("train_station",r"(train_station|railway_station|metro_station|transit_station|^tram_station)"),("bus_station",r"(bus_station|bus_terminal)"),("ferry_terminal",r"(ferry_terminal|ferry_service|ferry_boat)"),("toilets",r"(public_restroom|^restroom|public_toilet)"),("fuel",r"(gas_station|fueling_station|fuel_station|petrol_station|truck_gas_station)"),("atm",r"(^atm$|^bank$|bank_or_credit_union|credit_union)"),("post_office",r"(post_office|postal_service)"),("laundry",r"(laundry_service|laundromat|dry_cleaner|^laundry)"),("fountain",r"(public_fountain|^fountain)")]
CASE=" ".join([f"WHEN regexp_matches(coalesce(tax_primary,basic_category,''),'{p}','i') THEN '{k}'" for k,p in MAP])
Q=f"""SELECT cat, confidence, count(*) AS n FROM (
 SELECT CASE {CASE} ELSE NULL END AS cat, confidence FROM {F} WHERE country='FR')
 WHERE cat IS NOT NULL GROUP BY 1,2"""
rows=con.execute(Q).fetchall()
agg={}
for cat,conf,n in rows:
    d=agg.setdefault(cat,{'all':0,'c05':0,'c07':0})
    d['all']+=n
    if conf is not None and conf>=0.5: d['c05']+=n
    if conf is not None and conf>=0.7: d['c07']+=n
json.dump(agg,open('/tmp/ov_bycat.json','w'),indent=1)
print(f"{'CATEGORIE':<18}{'ALL':>8}{'>=0.5':>8}{'>=0.7':>8}")
ta=t5=t7=0
for k in sorted(agg,key=lambda x:-agg[x]['all']):
    d=agg[k]; ta+=d['all']; t5+=d['c05']; t7+=d['c07']
    print(f"{k:<18}{d['all']:>8}{d['c05']:>8}{d['c07']:>8}")
print(f"{'TOTAL':<18}{ta:>8}{t5:>8}{t7:>8}")
