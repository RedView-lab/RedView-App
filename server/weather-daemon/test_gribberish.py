#!/usr/bin/env python3
import gribberish
import numpy as np

with open("/tmp/sample.grib2", "rb") as f:
    raw = f.read()

msg = gribberish.parse_grib_message(raw, 0)
meta = msg.metadata
lats, lons = meta.latlng()
raw_data = msg.data().reshape(meta.grid_shape)

print(f"Data shape: {raw_data.shape}")
print(f"Lats[0]={lats[0]}, Lats[-1]={lats[-1]}")
print(f"Lons[0]={lons[0]}, Lons[-1]={lons[-1]}")

# Let's check Paris (lat ~48.85, lon ~2.35 -> 362.35)
lat_idx = int(round((48.85 - lats[0]) / (lats[1] - lats[0]))) if lats[1] > lats[0] else int(round((48.85 - lats[0]) / (lats[-1] - lats[0]) * len(lats)))
# Find nearest lon
lon_norm = 362.35
lon_idx = int(round((lon_norm - lons[0]) / (lons[1] - lons[0])))

paris_k = raw_data[lat_idx, lon_idx]
print(f"Paris coords lat={lats[lat_idx]:.2f}, lon={lons[lon_idx]:.2f}")
print(f"Paris temperature: {paris_k - 273.15:.2f} °C")

# Let's check Nice (lat ~43.70, lon ~7.26 -> 367.26)
lat_idx_nice = int(round((43.70 - lats[0]) / (lats[1] - lats[0])))
lon_idx_nice = int(round((367.26 - lons[0]) / (lons[1] - lons[0])))
nice_k = raw_data[lat_idx_nice, lon_idx_nice]
print(f"Nice coords lat={lats[lat_idx_nice]:.2f}, lon={lons[lon_idx_nice]:.2f}")
print(f"Nice temperature: {nice_k - 273.15:.2f} °C")
