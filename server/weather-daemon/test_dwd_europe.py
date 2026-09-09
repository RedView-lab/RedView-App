#!/usr/bin/env python3
import urllib.request
import re
import datetime

today_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
url = "https://opendata.dwd.de/weather/nwp/icon-eu/grib/12/t_2m/"
req = urllib.request.Request(url, headers={"User-Agent": "RedView-Daemon/1.0"})
with urllib.request.urlopen(req, timeout=10) as resp:
    html = resp.read().decode()

pattern = rf"icon-eu_europe_regular-lat-lon_single-level_{today_str}12_([0-9]{{3}})_T_2M\.grib2\.bz2"
files = re.findall(pattern, html)
steps = sorted([int(s) for s in files])
print(f"Found {len(steps)} steps in 12z run. Min step: {min(steps)}, Max step: {max(steps)}")
print(f"Available steps: {steps}")
