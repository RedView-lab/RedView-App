# -*- coding: utf-8 -*-
"""AllThePlaces -> France (polygone strict, robuste aux fichiers tronques)."""
import json, io, zipfile, collections
import shapely
from shapely.geometry import shape

ZIP = 'C:/Users/simon/AppData/Local/Temp/atp/output.zip'
TAXO = json.load(open('C:/Users/simon/Documents/REDVIEWproduction/redview-app/src/features/poi/poi-taxonomy.json', encoding='utf-8'))
FRANCE = shape(json.load(open('C:/Users/simon/Documents/REDVIEWproduction/redview-app/public/france-border.json', encoding='utf-8')))

def cond_ok(tags, cond):
    v = tags.get(cond['k'])
    if v is None: return False
    if cond.get('v') is not None: return v == cond['v']
    if 'in' in cond: return v in cond['in']
    return False

def resolve(tags):
    for cat in TAXO['categories']:
        for rule in cat['rules']:
            if all(cond_ok(tags, c) for c in rule): return cat['key']
    return None

z = zipfile.ZipFile(ZIP)
names = [x for x in z.namelist() if x.endswith('.geojson')]
fr_files = [x for x in names if x.endswith('_fr.geojson')]
no_suffix = [x for x in names if not x.endswith('_fr.geojson') and z.getinfo(x).file_size <= 20e6]
no_suffix += [x for x in names if not x.endswith('_fr.geojson') and x.endswith(('shell.geojson', 'moneygram.geojson'))]
print(f"fichiers _fr: {len(fr_files)}   no-suffix: {len(no_suffix)}", flush=True)

BB = (-5.7, 41.1, 9.9, 51.5)
cand = []  # (lon,lat,props,forced) deja pre-filtres bbox
skipped = 0

def ingest(feat, forced):
    p = feat.get('properties') or {}
    g = feat.get('geometry') or {}
    co = g.get('coordinates') if g else None
    if not (isinstance(co, list) and len(co) >= 2 and isinstance(co[0], (int, float)) and isinstance(co[1], (int, float))):
        if forced: cand.append((None, None, p, True))
        return
    lon, lat = co[0], co[1]
    if forced or (BB[0] <= lon <= BB[2] and BB[1] <= lat <= BB[3]) or p.get('addr:country') == 'FR':
        cand.append((lon, lat, p, forced))

for i, n in enumerate(fr_files + no_suffix):
    forced = n.endswith('_fr.geojson')
    try:
        with z.open(n) as fh:
            raw = fh.read()
        try:
            data = json.loads(raw)
            for feat in data.get('features') or []: ingest(feat, forced)
        except Exception:
            # fichier tronque / ndjson : parse ligne a ligne
            okc = 0
            for line in raw.decode('utf-8', 'ignore').splitlines():
                line = line.strip().rstrip(',')
                if not line.startswith('{'): continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get('type') == 'Feature': ingest(o, forced); okc += 1
            if okc == 0: skipped += 1
    except Exception as e:
        skipped += 1
    if i % 700 == 0: print(f"   lu {i}/{len(fr_files)+len(no_suffix)} — cand={len(cand):,}", flush=True)

vi = [i for i, c in enumerate(cand) if c[0] is not None]
vx = [cand[i][0] for i in vi]; vy = [cand[i][1] for i in vi]
inside = shapely.contains_xy(FRANCE, vx, vy)
ins = {i: bool(v) for i, v in zip(vi, inside)}

per_cat = collections.Counter(); per_spider = collections.Counter(); brands = collections.Counter()
fr = geo = wb = wp = ww = 0
for i, (lon, lat, p, forced) in enumerate(cand):
    if not (forced or ins.get(i, False) or p.get('addr:country') == 'FR'): continue
    fr += 1
    if lon is not None: geo += 1
    if p.get('brand'): wb += 1; brands[p['brand']] += 1
    if p.get('phone'): wp += 1
    if p.get('website'): ww += 1
    per_spider[p.get('@spider')] += 1
    k = resolve(p)
    if k: per_cat[k] += 1

print(f"\n(fichiers illisibles: {skipped})")
print("=== ALLTHEPLACES / FRANCE (polygone strict) ===")
print(f"features France      : {fr:,}")
print(f"  geolocalisees      : {geo:,}")
print(f"  avec marque        : {wb:,}")
print(f"  avec telephone     : {wp:,}")
print(f"  avec site web      : {ww:,}")
print(f"spiders FR distincts : {len(per_spider)}")
print(f"marques distinctes   : {len(brands)}")
print(f"mappables sur les 46 : {sum(per_cat.values()):,}")
print("--- categories ---")
for k, v in per_cat.most_common(40): print(f"{v:>8}  {k}")
print("--- top 30 spiders ---")
for k, v in per_spider.most_common(30): print(f"{v:>8}  {k}")
print("--- top 20 marques ---")
for k, v in brands.most_common(20): print(f"{v:>8}  {k}")
json.dump({'fr': fr, 'geo': geo, 'mapped': sum(per_cat.values()), 'per_cat': dict(per_cat),
           'brands': len(brands), 'spiders': len(per_spider)}, open('C:/tmp/atp_result.json', 'w'), indent=1)
