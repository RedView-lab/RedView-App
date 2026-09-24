# -*- coding: utf-8 -*-
"""Enrichit l'extrait SIRENE avec les noms de StockUniteLegale et mesure le gain."""
import duckdb, os, time

GEOLOC = 'C:/Users/simon/AppData/Local/Temp/sirene/sirene_geoloc.parquet'
STOCK = ('https://static.data.gouv.fr/resources/base-sirene-des-entreprises-et-de-leurs-'
         'etablissements-siren-siret/20260901-090503/stock-stocketablissement-parquet.parquet')
UL = ('https://static.data.gouv.fr/resources/base-sirene-des-entreprises-et-de-leurs-'
      'etablissements-siren-siret/20260901-084858/stock-stockunitelegale-parquet.parquet')
OUT = 'C:/tmp/test/sirene2.ndjson'

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
  ),
  ul AS (
    SELECT siren,
      nullif(coalesce(nullif(trim(denominationUsuelle1UniteLegale),''),
                      nullif(trim(denominationUniteLegale),''),
                      nullif(trim(sigleUniteLegale),'')), '') AS nom_societe,
      nullif(trim(coalesce(nullif(trim(prenomUsuelUniteLegale),''),
                           nullif(trim(prenom1UniteLegale),''), '')
                  || ' ' ||
                  coalesce(nullif(trim(nomUsageUniteLegale),''),
                           nullif(trim(nomUniteLegale),''), '')), '') AS nom_personne
    FROM read_parquet('{UL}')
    WHERE etatAdministratifUniteLegale = 'A'
  )
  SELECT s.naf, g.siret, s.enseigne, s.denomination, u.nom_societe, u.nom_personne,
         s.num, s.typevoie, s.voie, s.cp, s.ville, s.effectif,
         g.y_latitude AS lat, g.x_longitude AS lon
  FROM read_parquet('{GEOLOC}') g
  JOIN stock s ON s.siret = g.siret
  LEFT JOIN ul u ON u.siren = substr(s.siret, 1, 9)
  WHERE g.y_latitude IS NOT NULL AND g.x_longitude IS NOT NULL
) TO '{OUT}' (FORMAT JSON, ARRAY false);
""")
print(f"Extrait enrichi en {time.time()-t:.0f}s -> {os.path.getsize(OUT)/1e6:.0f} Mo")

q = f"""
SELECT count(*) tot,
  count(*) FILTER (enseigne IS NOT NULL AND enseigne<>'') ens,
  count(*) FILTER ((enseigne IS NULL OR enseigne='') AND denomination IS NOT NULL AND denomination<>'') den,
  count(*) FILTER ((enseigne IS NULL OR enseigne='') AND (denomination IS NULL OR denomination='')
                   AND nom_societe IS NOT NULL) soc,
  count(*) FILTER ((enseigne IS NULL OR enseigne='') AND (denomination IS NULL OR denomination='')
                   AND nom_societe IS NULL AND nom_personne IS NOT NULL) per,
  count(*) FILTER ((enseigne IS NULL OR enseigne='') AND (denomination IS NULL OR denomination='')
                   AND nom_societe IS NULL AND nom_personne IS NULL) aucun
FROM read_ndjson('{OUT}')
"""
tot, ens, den, soc, per, aucun = con.execute(q).fetchone()
print(f"\nTotal                 : {tot:,}")
print(f"  enseigne            : {ens:,} ({100*ens/tot:.0f} %)")
print(f"  denomination        : {den:,} ({100*den/tot:.0f} %)")
print(f"  + nom societe (UL)  : {soc:,} ({100*soc/tot:.0f} %)   <- gain StockUniteLegale")
print(f"  + nom personne (UL) : {per:,} ({100*per/tot:.0f} %)   <- gain StockUniteLegale")
print(f"  toujours sans nom   : {aucun:,} ({100*aucun/tot:.0f} %)")
print(f"\nEntrees nommees : {(tot-aucun)/tot*100:.0f} %  (contre {100*(ens+den)/tot:.0f} % sans la jointure)")
