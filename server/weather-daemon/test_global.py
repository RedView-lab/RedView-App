#!/usr/bin/env python3
import gribberish

with open("/tmp/sample_global.grib2", "rb") as f:
    raw = f.read()

msg = gribberish.parse_grib_message(raw, 0)
meta = msg.metadata
print("Global metadata:")
print("  grid_shape:", meta.grid_shape)
print("  is_regular_grid:", meta.is_regular_grid)
print("  dims:", meta.spatial_dims)
try:
    lats, lons = meta.latlng()
    print("  latlng len:", len(lats), len(lons))
except Exception as e:
    print("  latlng error:", e)

try:
    data = msg.data()
    print("  data shape:", data.shape, "min:", data.min(), "max:", data.max())
except Exception as e:
    print("  data error:", e)
