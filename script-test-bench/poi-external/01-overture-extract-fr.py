import duckdb, time
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")
con.execute("SET s3_region='us-west-2';")
con.execute("SET enable_progress_bar=false;")
P = "s3://overturemaps-us-west-2/release/2026-08-19.0/theme=places/type=place/*"
t=time.time()
con.execute(f"""
COPY (
  SELECT id, names.primary AS name, brand.names.primary AS brand,
         basic_category, taxonomy.primary AS tax_primary, taxonomy.hierarchy AS tax_hierarchy,
         categories.primary AS cat_primary, categories.alternate AS cat_alt,
         confidence, operating_status,
         addresses[1].country AS country, addresses[1].locality AS city,
         addresses[1].postcode AS postcode, addresses[1].freeform AS street,
         websites[1] AS website, phones[1] AS phone, emails[1] AS email,
         ST_X(geometry) AS lon, ST_Y(geometry) AS lat,
         list_distinct(list_transform(sources, x -> x.dataset)) AS src_datasets
  FROM read_parquet('{P}')
  WHERE bbox.xmin >= -5.6 AND bbox.xmax <= 9.9 AND bbox.ymin >= 41.2 AND bbox.ymax <= 51.4
) TO '/tmp/fr_overture.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
""")
print(f"extract done {time.time()-t:.0f}s")
print(con.execute("SELECT count(*) FROM '/tmp/fr_overture.parquet'").fetchone())
print("=== by country ===")
for r in con.execute("SELECT coalesce(country,'(none)') c, count(*) n FROM '/tmp/fr_overture.parquet' GROUP BY 1 ORDER BY 2 DESC LIMIT 15").fetchall(): print(" ", r)
print("=== by source dataset ===")
for r in con.execute("SELECT unnest(src_datasets) d, count(*) n FROM '/tmp/fr_overture.parquet' GROUP BY 1 ORDER BY 2 DESC LIMIT 15").fetchall(): print(" ", r)
