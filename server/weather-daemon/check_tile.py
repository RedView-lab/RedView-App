from PIL import Image
import numpy as np

img = Image.open("/var/www/weather/tiles/temperature_2026-09-08T16:00:00Z.png")
arr = np.array(img)
print("Image size:", img.size, "Shape:", arr.shape)
print("Min byte:", arr.min(), "Max byte:", arr.max())

vmin, vmax = -40.0, 50.0
temp = vmin + (arr.astype(np.float32) / 255.0) * (vmax - vmin)

for r in [0, 100, 300, 500, 700, 960, 1200, 1500, 1919]:
    lat = 90.0 - (r / 1919.0) * 180.0
    row_vals = temp[r, :]
    print(f"Row {r:4d} (lat {lat:6.1f}): min={row_vals.min():5.1f}C, mean={row_vals.mean():5.1f}C, max={row_vals.max():5.1f}C")

# Check France specifically:
# Lat: 42 to 51 N -> rows approx:
# r = (90 - lat) / 180 * 1920
# For lat 48.8 (Paris): r = (90 - 48.8) / 180 * 1920 = 439
# Lon: -5 to +8 E -> cols approx:
# c = (lon - (-180)) / 360 * 3840
# For lon 2.3 (Paris): c = (2.3 + 180) / 360 * 3840 = 1944
r_paris = int(round((90.0 - 48.85) / 180.0 * 1920))
c_paris = int(round((2.35 + 180.0) / 360.0 * 3840))
print(f"Paris (48.85N, 2.35E): row={r_paris}, col={c_paris}, temp={temp[r_paris, c_paris]:.1f}C")

r_marseille = int(round((90.0 - 43.3) / 180.0 * 1920))
c_marseille = int(round((5.37 + 180.0) / 360.0 * 3840))
print(f"Marseille (43.3N, 5.37E): row={r_marseille}, col={c_marseille}, temp={temp[r_marseille, c_marseille]:.1f}C")

r_brest = int(round((90.0 - 48.39) / 180.0 * 1920))
c_brest = int(round((-4.48 + 180.0) / 360.0 * 3840))
print(f"Brest (48.39N, -4.48E): row={r_brest}, col={c_brest}, temp={temp[r_brest, c_brest]:.1f}C")

r_alps = int(round((90.0 - 45.92) / 180.0 * 1920))
c_alps = int(round((6.86 + 180.0) / 360.0 * 3840))
print(f"Chamonix/Alps (45.92N, 6.86E): row={r_alps}, col={c_alps}, temp={temp[r_alps, c_alps]:.1f}C")
