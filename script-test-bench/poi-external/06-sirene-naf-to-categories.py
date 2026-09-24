# -*- coding: utf-8 -*-
import json
rows = json.load(open('C:/tmp/naf_dist.json'))
dist = {r[0]: r[1] for r in rows}
# NAF rev2 -> nos 46 categories (seules celles qui ont un equivalent economique)
MAP = {
 'restaurant':      ['56.10A'],
 'fast_food':       ['56.10C','56.10B'],
 'bar':             ['56.30Z'],
 'bakery':          ['47.24Z','10.71C','10.71D','10.71B'],
 'butcher':         ['47.22Z','10.13A','10.13B'],
 'supermarket':     ['47.11C'],
 'convenience':     ['47.11B','47.11D'],
 'marketplace':     ['47.81Z'],
 'hotel':           ['55.10Z','55.20Z','55.90Z'],
 'camp_site':       ['55.30Z'],
 'outdoor_shop':    ['47.64Z'],
 'pharmacy':        ['47.73Z'],
 'hospital':        ['86.10Z'],
 'doctors':         ['86.21Z','86.22A','86.22B','86.22C'],
 'fuel':            ['47.30Z'],
 'atm':             ['64.19Z'],
 'post_office':     ['53.10Z'],
 'laundry':         ['96.01Z'],
 'police':          ['84.24Z'],
 'caravan_site':    [],
 'bicycle':         [],
}
print(f"{'CATEGORIE':<16}{'NAF':<28}{'ETABLISSEMENTS ACTIFS':>22}")
tot=0
for cat, codes in MAP.items():
    if not codes: continue
    s = sum(dist.get(c,0) for c in codes)
    tot += s
    det = ", ".join(f"{c}={dist.get(c,0):,}" for c in codes if dist.get(c,0))
    print(f"{cat:<16}{det:<28}{s:>22,}")
print("-"*66)
print(f"{'TOTAL':<16}{'':<28}{tot:>22,}")
print(f"\nRappel: base RedView actuelle = 680,603 POI (46 categories, France metro, OSM)")
print(f"Rapport SIRENE-mappable / base OSM = {tot/680603:.2f}x")
print(f"\n--- codes NAF 47.11x et 56.1x presents ---")
for c in sorted(dist):
    if c.startswith(('47.11','56.1','55.','47.2','47.3','47.6','47.7','86.1','86.2','53.1','96.0','84.2','64.1','10.7','10.1')):
        print(f"  {c}  {dist[c]:>9,}")
