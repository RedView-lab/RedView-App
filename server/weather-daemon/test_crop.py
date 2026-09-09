#!/usr/bin/env python3
import gribberish
import numpy as np
import time

with open("/tmp/sample.grib2", "rb") as f:
    raw = f.read()

msg = gribberish.parse_grib_message(raw, 0)
meta = msg.metadata
lats, lons = meta.latlng()
raw_data = msg.data().reshape(meta.grid_shape)

print("Original shape:", raw_data.shape)

# BBOX: West=-6.5, East=11.5, South=41.0, North=52.5
# In DWD ICON-EU:
# lats start at 29.5, end at 70.5, step 0.0625
# lons start at 336.5 (-23.5), end at 422.5 (+62.5), step 0.0625
lat_step = (lats[-1] - lats[0]) / (len(lats) - 1)
lon_step = (lons[-1] - lons[0]) / (len(lons) - 1)

# Target bbox
TARGET_BBOX = {"west": -6.5, "south": 41.0, "east": 11.5, "north": 52.5}
west_norm = 360.0 + TARGET_BBOX["west"]  # 353.5
east_norm = 360.0 + TARGET_BBOX["east"]  # 371.5

lat_min_idx = int(round((TARGET_BBOX["south"] - lats[0]) / lat_step))
lat_max_idx = int(round((TARGET_BBOX["north"] - lats[0]) / lat_step))

lon_min_idx = int(round((west_norm - lons[0]) / lon_step))
lon_max_idx = int(round((east_norm - lons[0]) / lon_step))

print(f"Lat slice: {lat_min_idx}:{lat_max_idx+1} ({lats[lat_min_idx]:.2f} to {lats[lat_max_idx]:.2f})")
print(f"Lon slice: {lon_min_idx}:{lon_max_idx+1} ({lons[lon_min_idx]-360:.2f} to {lons[lon_max_idx]-360:.2f})")

# In standard images: row 0 is North (top), row H-1 is South (bottom)
# lats in raw_data go from South (29.5) to North (70.5)
# So we slice lat from lat_max_idx down to lat_min_idx (flip upside down for image coordinates)
cropped = raw_data[lat_min_idx:lat_max_idx+1, lon_min_idx:lon_max_idx+1]
# Flip vertically so row 0 is North
cropped = np.flipud(cropped)

print(f"Cropped shape: {cropped.shape}")
print(f"Cropped temp C min={np.nanmin(cropped) - 273.15:.1f}°C, max={np.nanmax(cropped) - 273.15:.1f}°C")

# Test bilinear interpolation to 640 x 420
H, W = 420, 640
orig_h, orig_w = cropped.shape

y_coords = np.linspace(0, orig_h - 1, H)
x_coords = np.linspace(0, orig_w - 1, W)

# Fast 2D bilinear interpolation using numpy
x0 = np.floor(x_coords).astype(int)
x1 = np.minimum(x0 + 1, orig_w - 1)
y0 = np.floor(y_coords).astype(int)
y1 = np.minimum(y0 + 1, orig_h - 1)

wx = (x_coords - x0)[None, :]
wy = (y_coords - y0)[:, None]

top = (1 - wx) * cropped[y0[:, None], x0[None, :]] + wx * cropped[y0[:, None], x1[None, :]]
bottom = (1 - wx) * cropped[y1[:, None], x0[None, :]] + wx * cropped[y1[:, None], x1[None, :]]
resampled = (1 - wy) * top + wy * bottom

print(f"Resampled shape: {resampled.shape}")
print(f"Resampled temp C min={np.nanmin(resampled) - 273.15:.1f}°C, max={np.nanmax(resampled) - 273.15:.1f}°C")
