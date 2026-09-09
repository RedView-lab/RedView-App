#!/usr/bin/env python3
"""
RedView High-Resolution Weather Ingestion Daemon (Europe)
Powered by DWD ICON-EU (0.0625° ~6.5 km) with Conformal Web Mercator Reprojection.
Generates 48 hours of ultra-fast 2D raster tiles for 6 meteorological variables.
"""

import os
import sys
import json
import math
import time
import bz2
import urllib.request
import argparse
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Tuple, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import gribberish
from PIL import Image

# ─────────────────────────────────────────────────────────────────────────────
# Geographic & Grid Configuration: Europe
# ─────────────────────────────────────────────────────────────────────────────
BBOX = {
    "west": -18.0,
    "south": 34.0,
    "east": 32.0,
    "north": 62.0,
}

OUT_W = 1280
OUT_H = 720
FORECAST_HOURS = 48
DWD_BASE = "https://opendata.dwd.de/weather/nwp/icon-eu/grib"

# Variable scale ranges for 8-bit normalization [0..255]
VARIABLES = {
    "temperature": {"unit": "°C", "min": -40.0, "max": 50.0},
    "feelsLike": {"unit": "°C", "min": -40.0, "max": 50.0},
    "rain": {"unit": "mm", "min": 0.0, "max": 50.0},
    "cloudCover": {"unit": "%", "min": 0.0, "max": 100.0},
    "humidity": {"unit": "%", "min": 0.0, "max": 100.0},
    "windSpeed": {"unit": "km/h", "min": 0.0, "max": 150.0},
}

# DWD folder and variable name mapping
DWD_VAR_MAP = {
    "temperature": ("t_2m", "T_2M"),
    "rain": ("tot_prec", "TOT_PREC"),
    "cloudCover": ("clct", "CLCT"),
    "humidity": ("relhum_2m", "RELHUM_2M"),
    "windSpeed": ("vmax_10m", "VMAX_10M"),
}


def lat_to_mercator_y(lat_deg: float) -> float:
    lat_rad = math.radians(min(85.051129, max(-85.051129, lat_deg)))
    return 0.5 - (0.5 / math.pi) * math.log(math.tan(math.pi / 4.0 + lat_rad / 2.0))


def mercator_y_to_lat(y: float) -> float:
    return math.degrees(2.0 * math.atan(math.exp(math.pi * (1.0 - 2.0 * y))) - math.pi / 2.0)


# Precompute Web Mercator target coordinates
y_north = lat_to_mercator_y(BBOX["north"])
y_south = lat_to_mercator_y(BBOX["south"])
merc_y_steps = np.linspace(y_north, y_south, OUT_H)
TARGET_LATS = np.array([mercator_y_to_lat(y) for y in merc_y_steps], dtype=np.float32)
TARGET_LONS = np.linspace(BBOX["west"], BBOX["east"], OUT_W, dtype=np.float32)


def find_latest_dwd_run() -> Tuple[str, str, datetime]:
    """
    Finds the latest available DWD ICON-EU run (00, 03, 06, 09, 12, 15, 18, 21)
    that has completed step 048.
    """
    now = datetime.now(timezone.utc)
    base_hours = ["21", "18", "15", "12", "09", "06", "03", "00"]
    
    for day_offset in range(2):
        dt_day = now - timedelta(days=day_offset)
        date_str = dt_day.strftime("%Y%m%d")
        for h in base_hours:
            run_dt = dt_day.replace(hour=int(h), minute=0, second=0, microsecond=0)
            if run_dt > now:
                continue
            test_url = f"{DWD_BASE}/{h}/t_2m/icon-eu_europe_regular-lat-lon_single-level_{date_str}{h}_048_T_2M.grib2.bz2"
            try:
                req = urllib.request.Request(test_url, method="HEAD", headers={"User-Agent": "RedView-Weather/2.0"})
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status == 200:
                        print(f"[DWD ICON-EU] Found complete European run: {date_str} {h}z ({run_dt.isoformat()})")
                        return date_str, h, run_dt
            except Exception:
                continue

    # Fallback to run 00 of today
    today_str = now.strftime("%Y%m%d")
    fallback_dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
    print(f"[DWD ICON-EU] Fallback to run {today_str} 00z")
    return today_str, "00", fallback_dt


def fetch_and_decompress(url: str, retries: int = 3) -> Optional[bytes]:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "RedView-Weather/2.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                compressed = resp.read()
            return bz2.decompress(compressed)
        except Exception as e:
            if attempt == retries - 1:
                print(f"[Fetch Error] {url}: {e}")
            time.sleep(0.5)
    return None


def calculate_apparent_temperature(temp_c: np.ndarray, rh_pct: np.ndarray, wind_kmh: np.ndarray) -> np.ndarray:
    """
    Standard Australian BOM / NOAA Steadman Apparent Temperature Formula.
    Valid across all temperature and humidity ranges.
    """
    # Vapor pressure (hPa)
    e = (rh_pct / 100.0) * 6.105 * np.exp((17.27 * temp_c) / (237.7 + temp_c))
    wind_ms = np.maximum(0.0, wind_kmh / 3.6)
    at = temp_c + 0.33 * e - 0.70 * wind_ms - 4.00
    return np.clip(at, -40.0, 50.0)


def reproject_bilinear(raw_data: np.ndarray, lats: np.ndarray, lons: np.ndarray) -> np.ndarray:
    """
    Fast vectorised bilinear interpolation from regular lat/lon to Web Mercator grid.
    """
    lat_step = (lats[-1] - lats[0]) / (len(lats) - 1)
    lon_step = (lons[-1] - lons[0]) / (len(lons) - 1)

    row_indices = (TARGET_LATS - lats[0]) / lat_step
    col_indices = ((TARGET_LONS + 360.0) - lons[0]) / lon_step

    r_coords = np.clip(row_indices[:, None], 0, raw_data.shape[0] - 1.001)
    c_coords = np.clip(col_indices[None, :], 0, raw_data.shape[1] - 1.001)

    r0 = np.floor(r_coords).astype(np.int32)
    r1 = np.minimum(r0 + 1, raw_data.shape[0] - 1)
    c0 = np.floor(c_coords).astype(np.int32)
    c1 = np.minimum(c0 + 1, raw_data.shape[1] - 1)

    dr = (r_coords - r0).astype(np.float32)
    dc = (c_coords - c0).astype(np.float32)

    top = (1.0 - dc) * raw_data[r0, c0] + dc * raw_data[r0, c1]
    bot = (1.0 - dc) * raw_data[r1, c0] + dc * raw_data[r1, c1]
    return (1.0 - dr) * top + dr * bot


def encode_array_to_bytes(arr: np.ndarray, vmin: float, vmax: float) -> np.ndarray:
    clamped = np.clip(arr, vmin, vmax)
    ratio = (clamped - vmin) / max(1e-5, vmax - vmin)
    return np.round(ratio * 255.0).astype(np.uint8)


def process_step(
    step_idx: int,
    run_date_str: str,
    run_hour_str: str,
    hour_iso: str,
    tiles_dir: str,
    prev_rain_arr: Optional[np.ndarray],
    last_known: Dict[str, np.ndarray],
) -> Tuple[int, str, Dict[str, str], Optional[np.ndarray]]:
    fff = f"{step_idx:03d}"
    fields: Dict[str, np.ndarray] = {}
    lats_ref = last_known.get("lats_ref")
    lons_ref = last_known.get("lons_ref")

    # 1. Download base variables concurrently
    def dl_var(item):
        var_key, (folder, code) = item
        url = f"{DWD_BASE}/{run_hour_str}/{folder}/icon-eu_europe_regular-lat-lon_single-level_{run_date_str}{run_hour_str}_{fff}_{code}.grib2.bz2"
        raw_b = fetch_and_decompress(url)
        return var_key, raw_b

    with ThreadPoolExecutor(max_workers=5) as executor:
        dl_results = list(executor.map(dl_var, DWD_VAR_MAP.items()))

    for var_key, raw_b in dl_results:
        if raw_b:
            try:
                msg = gribberish.parse_grib_message(raw_b, 0)
                if lats_ref is None:
                    lats_ref, lons_ref = msg.metadata.latlng()
                    last_known["lats_ref"] = lats_ref
                    last_known["lons_ref"] = lons_ref
                data = msg.data().reshape(msg.metadata.grid_shape)
                if var_key == "temperature":
                    fields["temperature"] = data - 273.15
                    last_known["temperature"] = fields["temperature"]
                elif var_key == "windSpeed":
                    fields["windSpeed"] = np.maximum(0.0, data * 3.6)
                    last_known["windSpeed"] = fields["windSpeed"]
                elif var_key in ("cloudCover", "humidity"):
                    fields[var_key] = np.clip(data, 0.0, 100.0)
                    last_known[var_key] = fields[var_key]
                elif var_key == "rain":
                    fields["rain_raw"] = np.maximum(0.0, data)
                    last_known["rain_raw"] = fields["rain_raw"]
            except BaseException as e:
                print(f"[Parse Error] step {step_idx:03d} {var_key}: {e}")
                if var_key in last_known:
                    fields[var_key] = last_known[var_key]

    # Fill any missing variables from last_known
    for k, v in last_known.items():
        if k not in fields and k not in ("lats_ref", "lons_ref"):
            fields[k] = v

    if lats_ref is None or "temperature" not in fields:
        print(f"[Warning] Step {step_idx:03d} incomplete")
        return step_idx, hour_iso, {}, None

    # Compute hourly rain from cumulative TOT_PREC
    raw_tot_prec = fields.get("rain_raw")
    if raw_tot_prec is not None:
        if prev_rain_arr is not None:
            hourly_rain = np.maximum(0.0, raw_tot_prec - prev_rain_arr)
        else:
            hourly_rain = raw_tot_prec
        fields["rain"] = np.clip(hourly_rain, 0.0, 50.0)
    else:
        fields["rain"] = np.zeros_like(fields["temperature"])

    # Compute Apparent Temperature (feelsLike)
    fields["feelsLike"] = calculate_apparent_temperature(
        fields["temperature"],
        fields.get("humidity", np.full_like(fields["temperature"], 65.0)),
        fields.get("windSpeed", np.full_like(fields["temperature"], 10.0)),
    )

    # 2. Reproject each field to Web Mercator & Save PNG
    out_paths: Dict[str, str] = {}
    for var_key in VARIABLES:
        raw_arr = fields.get(var_key)
        if raw_arr is None:
            continue
        reprojected = reproject_bilinear(raw_arr, lats_ref, lons_ref)
        spec = VARIABLES[var_key]
        uint8_arr = encode_array_to_bytes(reprojected, spec["min"], spec["max"])
        img = Image.fromarray(uint8_arr)

        filename = f"{var_key}_{hour_iso}.png"
        filepath = os.path.join(tiles_dir, filename)
        img.save(filepath, format="PNG", compress_level=3)
        out_paths[var_key] = filename

    return step_idx, hour_iso, out_paths, raw_tot_prec


def run_europe_pipeline(output_dir: str, forecast_hours: int = FORECAST_HOURS) -> None:
    t_start = time.time()
    tiles_dir = os.path.join(output_dir, "tiles")
    os.makedirs(tiles_dir, exist_ok=True)

    run_date_str, run_hour_str, run_dt = find_latest_dwd_run()
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)

    # Calculate hours since run to match current UTC timeline
    hours_since_run = int((now_utc - run_dt).total_seconds() // 3600)
    start_step = max(0, min(hours_since_run, 24))

    step_indices: List[int] = []
    hours_iso: List[str] = []

    for h in range(forecast_hours):
        step_idx = start_step + h
        if step_idx > 78:
            break
        dt = run_dt + timedelta(hours=step_idx)
        hours_iso.append(dt.strftime("%Y-%m-%dT%H:00:00Z"))
        step_indices.append(step_idx)

    print(
        f"[Pipeline] Processing {len(step_indices)} European steps "
        f"from DWD ICON-EU run {run_date_str} {run_hour_str}z..."
    )

    # Process sequentially for rain accumulation tracking, or in small parallel batches
    valid_hours: List[str] = []
    prev_rain: Optional[np.ndarray] = None
    last_known: Dict[str, np.ndarray] = {}

    for i in range(len(step_indices)):
        s_idx = step_indices[i]
        h_iso = hours_iso[i]
        t0 = time.time()
        _, _, out_paths, prev_rain = process_step(
            step_idx=s_idx,
            run_date_str=run_date_str,
            run_hour_str=run_hour_str,
            hour_iso=h_iso,
            tiles_dir=tiles_dir,
            prev_rain_arr=prev_rain,
            last_known=last_known,
        )
        if out_paths:
            valid_hours.append(h_iso)
            print(f"   [Step +{i:02d}h] {h_iso} generated in {time.time()-t0:.2f}s")

    # 3. Write metadata.json
    meta = {
        "model": "DWD ICON-EU High-Resolution (0.0625° ~6.5 km)",
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runDate": run_date_str,
        "runHour": run_hour_str,
        "resolutionDeg": 0.0625,
        "gridSize": {
            "width": OUT_W,
            "height": OUT_H,
        },
        "bbox": BBOX,
        "tileFormat": "png",
        "variables": {
            k: {
                "unit": v["unit"],
                "min": v["min"],
                "max": v["max"],
                "tileTemplate": f"{k}_{{hour}}.png",
            }
            for k, v in VARIABLES.items()
        },
        "hours": valid_hours,
    }

    meta_path = os.path.join(output_dir, "meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    total_dur = time.time() - t_start
    print(
        f"[Pipeline Complete] Generated {len(valid_hours)} hours x 6 variables "
        f"({len(valid_hours)*6} tiles) in {total_dur:.1f}s!"
    )


def main():
    parser = argparse.ArgumentParser(description="RedView European Weather Daemon")
    parser.add_argument("--output-dir", default="/var/www/weather", help="Output directory")
    parser.add_argument("--hours", type=int, default=FORECAST_HOURS, help="Number of forecast hours")
    args = parser.parse_args()

    run_europe_pipeline(output_dir=args.output_dir, forecast_hours=args.hours)


if __name__ == "__main__":
    main()
