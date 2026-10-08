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

# BBOX : ouest=-6.5, est=11.5, sud=41.0, nord=52.5
# Dans DWD ICON-EU :
# les lats commencent à 29.5, finissent à 70.5, pas de 0.0625
# les lons commencent à 336.5 (-23.5), finissent à 422.5 (+62.5), pas de 0.0625
lat_step = (lats[-1] - lats[0]) / (len(lats) - 1)
lon_step = (lons[-1] - lons[0]) / (len(lons) - 1)

# Emprise visée
TARGET_BBOX = {"west": -6.5, "south": 41.0, "east": 11.5, "north": 52.5}
west_norm = 360.0 + TARGET_BBOX["west"]  # 353.5
east_norm = 360.0 + TARGET_BBOX["east"]  # 371.5

lat_min_idx = int(round((TARGET_BBOX["south"] - lats[0]) / lat_step))
lat_max_idx = int(round((TARGET_BBOX["north"] - lats[0]) / lat_step))

lon_min_idx = int(round((west_norm - lons[0]) / lon_step))
lon_max_idx = int(round((east_norm - lons[0]) / lon_step))

print(f"Lat slice: {lat_min_idx}:{lat_max_idx+1} ({lats[lat_min_idx]:.2f} to {lats[lat_max_idx]:.2f})")
print(f"Lon slice: {lon_min_idx}:{lon_max_idx+1} ({lons[lon_min_idx]-360:.2f} to {lons[lon_max_idx]-360:.2f})")

# Dans les images standard : la ligne 0 est au nord (haut), la ligne H-1 au sud (bas)
# les lats de raw_data vont du sud (29.5) au nord (70.5)
# On découpe donc les lats de lat_max_idx à lat_min_idx (retournement vertical pour les coordonnées d'image)
cropped = raw_data[lat_min_idx:lat_max_idx+1, lon_min_idx:lon_max_idx+1]
# Retournement vertical pour que la ligne 0 soit au nord
cropped = np.flipud(cropped)

print(f"Cropped shape: {cropped.shape}")
print(f"Cropped temp C min={np.nanmin(cropped) - 273.15:.1f}°C, max={np.nanmax(cropped) - 273.15:.1f}°C")

# Test de l'interpolation bilinéaire vers 640 x 420
H, W = 420, 640
orig_h, orig_w = cropped.shape

y_coords = np.linspace(0, orig_h - 1, H)
x_coords = np.linspace(0, orig_w - 1, W)

# Interpolation bilinéaire 2D rapide avec numpy
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
