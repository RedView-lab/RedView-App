#!/usr/bin/env python3
import urllib.request
import json
import time
import sys

# Test 18 x 14 = 252 anchor points
lats = [round(41.0 + i * (52.5 - 41.0) / 13, 3) for i in range(14)]
lons = [round(-6.5 + j * (11.5 - (-6.5)) / 17, 3) for j in range(18)]

all_coords = [(lat, lon) for lat in lats for lon in lons]
print(f"Total grid points: {len(all_coords)}")

chunk_size = 70
results = []

for idx in range(0, len(all_coords), chunk_size):
    chunk = all_coords[idx:idx+chunk_size]
    chunk_lats = ",".join(str(c[0]) for c in chunk)
    chunk_lons = ",".join(str(c[1]) for c in chunk)
    url = f"https://api.open-meteo.com/v1/forecast?latitude={chunk_lats}&longitude={chunk_lons}&hourly=temperature_2m,apparent_temperature,precipitation,cloud_cover,relative_humidity_2m,wind_speed_10m&forecast_days=2"
    
    if idx > 0:
        time.sleep(1.2)  # Respect rate limit
        
    req = urllib.request.Request(url, headers={"User-Agent": "RedView-Weather-Daemon/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            batch = json.loads(resp.read().decode("utf-8"))
            if isinstance(batch, dict):
                batch = [batch]
            results.extend(batch)
            print(f"Batch {idx//chunk_size + 1}: got {len(batch)} locations (total {len(results)})")
    except Exception as e:
        print(f"Error on batch {idx//chunk_size + 1}: {e}")
        sys.exit(1)

print(f"Successfully fetched all {len(results)} locations!")
if results:
    loc = results[0]
    hourly = loc.get("hourly", {})
    print("Hours count:", len(hourly.get("time", [])))
    print("First 3 temps:", hourly.get("temperature_2m", [])[:3])
