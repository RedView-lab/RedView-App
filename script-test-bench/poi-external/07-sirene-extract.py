# -*- coding: utf-8 -*-
"""Reproduit l'extrait NDJSON de import-sirene.mjs (meme SQL) via DuckDB Python."""
import duckdb, os, time

OUT = 'C:/tmp/test/sirene.ndjson'
os.makedirs('C:/tmp/test', exist_ok=True)

GEOLOC = 'C:/Users/simon/AppData/Local/Temp/sirene/sirene_geoloc.parquet'
STOCK = ('https://static.data.gouv.fr/resources/base-sirene-des-entreprises-et-de-leurs-'
         'etablissements-siren-siret/20260901-090503/stock-stocketablissement-parquet.parquet')

NAF = ['56.10A','56.10B','56.10C','56.30Z','47.11B','47.11C','47.11D','47.22Z','10.13A','10.13B',
       '47.24Z','10.71B','10.71C','10.71D','47.30Z','47.64Z','47.73Z','53.10Z','55.10Z','55.90Z',
       '55.30Z','64.19Z','84.24Z','86.10Z','86.21Z','86.22A','86.22B','86.22C','96.01A','96.01B']
naf_list = ", ".join(f"'{c}'" for c in NAF)

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute("SET enable_progress_bar=false;")
t = time.time()
con.execute(f"""
COPY (
  WITH stock AS (
    SELECT siret, activitePrincipaleEtablissement AS naf,
           enseigne1Etablissement AS enseigne, denominationUsuelleEtablissement AS denomination,
           numeroVoieEtablissement AS num, typeVoieEtablissement AS typevoie,
           libelleVoieEtablissement AS voie, codePostalEtablissement AS cp,
           libelleCommuneEtablissement AS ville, trancheEffectifsEtablissement AS effectif
    FROM read_parquet('{STOCK}')
    WHERE etatAdministratifEtablissement = 'A'
      AND activitePrincipaleEtablissement IN ({naf_list})
  )
  SELECT s.naf, g.siret, s.enseigne, s.denomination, s.num, s.typevoie, s.voie, s.cp, s.ville,
         s.effectif, g.y_latitude AS lat, g.x_longitude AS lon
  FROM read_parquet('{GEOLOC}') g
  JOIN stock s ON s.siret = g.siret
  WHERE g.y_latitude IS NOT NULL AND g.x_longitude IS NOT NULL
) TO '{OUT}' (FORMAT JSON, ARRAY false);
""")
n = con.execute(f"SELECT count(*) FROM read_parquet('{GEOLOC}') WHERE 1=0").fetchone()  # noop
print(f"Extrait SIRENE ecrit en {time.time()-t:.0f}s -> {os.path.getsize(OUT)/1e6:.0f} Mo")
with open(OUT, 'r', encoding='utf-8') as f:
    print("lignes:", sum(1 for _ in f))
