# -*- coding: utf-8 -*-
"""Analyse SIRENE geocodee : volume, schema, mapping NAF -> 46 categories RedView."""
import duckdb, sys, json
from paths import SYSTEM_TEMP

P = sys.argv[1] if len(sys.argv) > 1 else (SYSTEM_TEMP / 'sirene' / 'sirene_geoloc.parquet').as_posix()
con = duckdb.connect()
print("=== SCHEMA SIRENE ===")
for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{P}')").fetchall():
    print(f"  {c[0]:<45} {c[1]}")
print("\n=== NB LIGNES ===")
print(con.execute(f"SELECT count(*) FROM read_parquet('{P}')").fetchone())
