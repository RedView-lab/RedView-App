#!/usr/bin/env python3
import urllib.request, bz2, gribberish

today_str = "20260908"
run_hour = "12"
step = 8

for var_key, (folder, code) in [
    ("temp", ("t_2m", "T_2M")),
    ("wind", ("vmax_10m", "VMAX_10M")),
    ("hum", ("relhum_2m", "RELHUM_2M")),
    ("clct", ("clct", "CLCT")),
    ("rain", ("tot_prec", "TOT_PREC")),
]:
    url = f"https://opendata.dwd.de/weather/nwp/icon-eu/grib/{run_hour}/{folder}/icon-eu_europe_regular-lat-lon_single-level_{today_str}{run_hour}_{step:03d}_{code}.grib2.bz2"
    req = urllib.request.Request(url, headers={"User-Agent": "Test/1.0"})
    with urllib.request.urlopen(req) as resp:
        b = bz2.decompress(resp.read())
    try:
        msg = gribberish.parse_grib_message(b, 0)
        d = msg.data()
        print(f"{var_key}: OK, shape={d.shape}")
    except Exception as e:
        print(f"{var_key}: FAILED with {e}")
