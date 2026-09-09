#!/usr/bin/env python3
import urllib.request
import bz2
import gribberish
import numpy as np
import time

RUN_DATE = "20260908"
RUN_HOUR = "00"
RUN_ID = f"{RUN_DATE}{RUN_HOUR}"
BASE_URL = f"https://opendata.dwd.de/weather/nwp/icon-eu/grib/{RUN_HOUR}"

TARGET_BBOX = {"west": -6.5, "south": 41.0, "east": 11.5, "north": 52.5}
OUT_W, OUT_H = 640, 420

def fetch_and_crop(var_folder: str, var_code: str, step: int):
    fff = f"{step:03d}"
    filename = f"icon-eu_europe_regular-lat-lon_single-level_{RUN_ID}_{fff}_{var_code}.grib2.bz2"
    url = f"{BASE_URL}/{var_folder}/{filename}"
    t0 = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": "RedView-Daemon/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        compressed = resp.read()
    t_dl = time.time() - t0
    
    decompressed = bz2.decompress(compressed)
    t_bz2 = time.time() - t0 - t_dl
    
    msg = gribberish.parse_grib_message(decompressed, 0)
    meta = msg.metadata
    lats, lons = meta.latlng()
    raw_data = msg.data().reshape(meta.grid_shape)
    t_parse = time.time() - t0 - t_dl - t_bz2
    
    lat_step = (lats[-1] - lats[0]) / (len(lats) - 1)
    lon_step = (lons[-1] - lons[0]) / (len(lons) - 1)
    west_norm = 360.0 + TARGET_BBOX["west"]
    east_norm = 360.0 + TARGET_BBOX["east"]
    
    lat_min_idx = int(round((TARGET_BBOX["south"] - lats[0]) / lat_step))
    lat_max_idx = int(round((TARGET_BBOX["north"] - lats[0]) / lat_step))
    lon_min_idx = int(round((west_norm - lons[0]) / lon_step))
    lon_max_idx = int(round((east_norm - lons[0]) / lon_step))
    
    cropped = np.flipud(raw_data[lat_min_idx:lat_max_idx+1, lon_min_idx:lon_max_idx+1])
    
    # Bilinear resize to OUT_W x OUT_H
    orig_h, orig_w = cropped.shape
    y_coords = np.linspace(0, orig_h - 1, OUT_H)
    x_coords = np.linspace(0, orig_w - 1, OUT_W)
    x0 = np.floor(x_coords).astype(int)
    x1 = np.minimum(x0 + 1, orig_w - 1)
    y0 = np.floor(y_coords).astype(int)
    y1 = np.minimum(y0 + 1, orig_h - 1)
    wx = (x_coords - x0)[None, :]
    wy = (y_coords - y0)[:, None]
    top = (1 - wx) * cropped[y0[:, None], x0[None, :]] + wx * cropped[y0[:, None], x1[None, :]]
    bottom = (1 - wx) * cropped[y1[:, None], x0[None, :]] + wx * cropped[y1[:, None], x1[None, :]]
    resampled = (1 - wy) * top + wy * bottom
    
    print(f"[{var_code} h={step}] dl={t_dl:.2f}s bz2={t_bz2:.2f}s parse={t_parse:.3f}s total={time.time()-t0:.2f}s min={np.nanmin(resampled):.1f} max={np.nanmax(resampled):.1f}")
    return resampled

print("Fetching test step 1...")
t_step = time.time()
t2m = fetch_and_crop("t_2m", "T_2M", 1) - 273.15
clct = fetch_and_crop("clct", "CLCT", 1)
prec = fetch_and_crop("tot_prec", "TOT_PREC", 1)
rh = fetch_and_crop("relhum_2m", "RELHUM_2M", 1)
wind = fetch_and_crop("vmax_10m", "VMAX_10M", 1) * 3.6

print(f"All 5 variables processed in {time.time() - t_step:.2f}s!")
print(f"Temperature C: min={np.nanmin(t2m):.1f}, max={np.nanmax(t2m):.1f}")
print(f"Cloud cover %: min={np.nanmin(clct):.1f}, max={np.nanmax(clct):.1f}")
print(f"Rain mm: min={np.nanmin(prec):.1f}, max={np.nanmax(prec):.1f}")
print(f"Humidity %: min={np.nanmin(rh):.1f}, max={np.nanmax(rh):.1f}")
print(f"Wind km/h: min={np.nanmin(wind):.1f}, max={np.nanmax(wind):.1f}")
