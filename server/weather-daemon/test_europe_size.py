#!/usr/bin/env python3
import gribberish
import numpy as np
from PIL import Image
import os
import time

with open("/tmp/sample.grib2", "rb") as f:
    raw = f.read()

msg = gribberish.parse_grib_message(raw, 0)
meta = msg.metadata
raw_data = msg.data().reshape(meta.grid_shape)
# Row 0 is North (top)
full_europe = np.flipud(raw_data) - 273.15

print("Full Europe shape:", full_europe.shape)
print("Temp range:", round(full_europe.min(), 1), "to", round(full_europe.max(), 1), "C")

# Encode to 8-bit PNG
clamped = np.clip(full_europe, -40.0, 50.0)
ratio = (clamped - (-40.0)) / (90.0)
uint8_arr = np.round(ratio * 255.0).astype(np.uint8)

t0 = time.time()
img = Image.fromarray(uint8_arr)
test_png = "/tmp/test_full_europe.png"
img.save(test_png, format="PNG", optimize=True)
t_save = time.time() - t0

size_bytes = os.path.getsize(test_png)
print(f"Saved native {full_europe.shape[1]}x{full_europe.shape[0]} PNG in {t_save*1000:.1f}ms: {size_bytes/1024:.1f} KB")
total_48h_mb = (size_bytes * 48 * 6) / (1024 * 1024)
print(f"Estimated total storage for ALL 48h x 6 variables: {total_48h_mb:.1f} MB")
