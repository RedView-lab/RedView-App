# -*- coding: utf-8 -*-
"""Projection AVANT/APRES revisee apres MESURE du taux de doublons SIRENE."""
import json

BASE = {"restaurant":92139,"shelter":47597,"hotel":42043,"toilets":36548,"fast_food":30298,
"bakery":29491,"atm":28936,"defibrillator":27937,"drinking_water":26371,"convenience":22519,
"fountain":21461,"charging_station":21396,"bar":20743,"spring":19427,"pharmacy":19133,
"viewpoint":18727,"post_office":17458,"cafe":17129,"supermarket":15707,"picnic_site":14919,
"doctors":12541,"fuel":11084,"butcher":10727,"camp_site":9153,"pass":7469,"laundry":6337,
"police":5936,"pub":4422,"outdoor_shop":4036,"train_station":4022,"marketplace":3905,
"bicycle":3837,"caravan_site":3598,"water_tap":3276,"bicycle_repair":2937,"shower":2717,
"hospital":2383,"clinic":1993,"water_point":1966,"ice_cream":1803,"vending_machine":1684,
"compressed_air":1588,"wilderness_hut":1135,"bus_station":805,"alpine_hut":654,"ferry_terminal":616}

OV = json.load(open('C:/tmp/ov_bycat.json'))
ATP = json.load(open('C:/tmp/atp_result.json'))['per_cat']

# SIRENE : comptes REELS produits par import-sirene.mjs (apres regroupement
# par adresse), et non plus les comptes NAF bruts.
SIR = {"fast_food":122279,"restaurant":106917,"doctors":71562,"bakery":52463,
"convenience":45364,"bar":43313,"hotel":35013,"atm":24471,"pharmacy":21591,
"butcher":19457,"laundry":13476,"outdoor_shop":12335,"camp_site":9986,"hospital":8955,
"post_office":8763,"fuel":6692,"supermarket":6180,"police":1469}

# Taux de doublons MESURES (20 zones temoin, memes regles d'appariement) :
#   Overture vs OSM                      : 47 %
#   SIRENE   vs OSM + Overture           : 40 %
# ATP : estime (chaines deja presentes dans OSM).
DUP_OV, DUP_SIR, DUP_ATP = 0.47, 0.47, 0.85

# Categories SIRENE ecartees du scenario recommande : NAF plus large que la
# definition OSM, OSM deja dense, risque de noyer la carte.
SIR_EXCLU = {'fast_food', 'bar'}

def build(exclude_sirene):
    rows, tot = [], {'base':0,'ov':0,'atp':0,'sir':0,'new':0}
    for cat in sorted(BASE, key=lambda c: -BASE[c]):
        b = BASE[cat]
        ov = OV.get(cat, {}).get('c05', 0)
        at = ATP.get(cat, 0)
        si = 0 if (exclude_sirene and cat in SIR_EXCLU) else SIR.get(cat, 0)
        n_ov = round(ov * (1 - DUP_OV)); n_at = round(at * (1 - DUP_ATP)); n_si = round(si * (1 - DUP_SIR))
        new = n_ov + n_at + n_si
        rows.append((cat, b, ov, at, si, n_ov, n_at, n_si, new, b + new))
        tot['base'] += b; tot['ov'] += ov; tot['atp'] += at; tot['sir'] += si; tot['new'] += new
    return rows, tot

def table(rows, tot, title):
    print(f"\n### {title}\n")
    print("| Catégorie | Base | Overture ≥0,5 | ATP | SIRENE | Net Overture | Net ATP | Net SIRENE | +Total | Après |")
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for r in rows:
        f = lambda v: f"{v:,}".replace(',', ' ')
        print(f"| `{r[0]}` | {f(r[1])} | {f(r[2])} | {f(r[3])} | {f(r[4])} | {f(r[5])} | {f(r[6])} | {f(r[7])} | **{f(r[8])}** | **{f(r[9])}** |")
    f = lambda v: f"{v:,}".replace(',', ' ')
    print(f"| **TOTAL** | **{f(tot['base'])}** | **{f(tot['ov'])}** | **{f(tot['atp'])}** | **{f(tot['sir'])}** | | | | **{f(tot['new'])}** | **{f(tot['base']+tot['new'])}** |")
    print(f"\nAVANT {f(tot['base'])} → APRES {f(tot['base']+tot['new'])} (+{f(tot['new'])}, +{(tot['base']+tot['new'])/tot['base']*100-100:.0f} %)")

rows_g, tot_g = build(True)
rows_f, tot_f = build(False)
table(rows_g, tot_g, "Scénario recommandé — SIRENE limitée (sans fast_food ni bar)")
print()
table(rows_f, tot_f, "Scénario complet — toutes catégories SIRENE")
