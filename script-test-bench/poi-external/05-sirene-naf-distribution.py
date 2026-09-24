import duckdb, json
con=duckdb.connect(); con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute("SET enable_progress_bar=false;")
U='https://static.data.gouv.fr/resources/base-sirene-des-entreprises-et-de-leurs-etablissements-siren-siret/20260901-090503/stock-stocketablissement-parquet.parquet'
print("total lignes:", con.execute(f"SELECT count(*) FROM read_parquet('{U}')").fetchone())
print("actifs:", con.execute(f"SELECT count(*) FROM read_parquet('{U}') WHERE etatAdministratifEtablissement='A'").fetchone())
rows=con.execute(f"""SELECT activitePrincipaleEtablissement naf, count(*) n FROM read_parquet('{U}')
 WHERE etatAdministratifEtablissement='A' GROUP BY 1 ORDER BY 2 DESC""").fetchall()
json.dump(rows, open('C:/tmp/naf_dist.json','w'))
print("distinct NAF:", len(rows))
print("--- top 60 ---")
for r in rows[:60]: print(f"{r[1]:>10}  {r[0]}")
