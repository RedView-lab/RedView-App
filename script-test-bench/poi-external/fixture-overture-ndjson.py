# -*- coding: utf-8 -*-
"""Banc d'essai : extrait Overture NDJSON (comme le produira import-overture.mjs)."""
import duckdb, json, os

OUT = 'C:/tmp/test/overture-fr.ndjson'
os.makedirs('C:/tmp/test', exist_ok=True)
# Lyon + Bordeaux + un bout de rural : melange urbain/rural representatif
BOXES = [
    (45.740, 4.820, 45.780, 4.870),
    (44.830, -0.590, 44.860, -0.550),
    (44.500, 5.500, 44.560, 5.600),
]
where = " OR ".join([f"(lat BETWEEN {s} AND {n} AND lon BETWEEN {w} AND {e})" for s, w, n, e in BOXES])

con = duckdb.connect()
con.execute("LOAD spatial;")
con.execute("SET enable_progress_bar=false;")
q = f"""
SELECT id AS gers_id, name, brand,
       tax_primary, basic_category, confidence, operating_status,
       street, city, postcode, website, phone, email, lon, lat
FROM '/tmp/fr_overture.parquet'
WHERE ({where})
"""
rows = con.execute(q).fetchall()
cols = [d[0] for d in con.description]
with open(OUT, 'w', encoding='utf-8') as f:
    for r in rows:
        f.write(json.dumps(dict(zip(cols, r)), ensure_ascii=False, default=str) + "\n")
print(f"NDJSON ecrit : {len(rows)} lignes -> {OUT} ({os.path.getsize(OUT)/1e6:.1f} Mo)")
