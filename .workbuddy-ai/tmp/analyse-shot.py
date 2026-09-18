"""Characterise the striping artefact in a RedView slope-overlay screenshot.

Reports:
  * image size
  * dominant vertical period of the luminance signal (screen space)
  * whether the stripes are perfectly horizontal or follow the terrain
  * the vertical/horizontal autocorrelation profile
"""
import sys
import numpy as np
from PIL import Image

path = sys.argv[1]
img = Image.open(path).convert("RGB")
a = np.asarray(img).astype(np.float32)
h, w, _ = a.shape
print(f"image: {w}x{h}  ({path})")

lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]

# Sample a few clean interior windows and average their vertical profiles.
windows = []
for (x0, y0, bw, bh) in [
    (int(w * 0.30), int(h * 0.25), 120, 200),
    (int(w * 0.55), int(h * 0.35), 120, 200),
    (int(w * 0.70), int(h * 0.55), 120, 160),
    (int(w * 0.20), int(h * 0.55), 120, 160),
]:
    if x0 + bw <= w and y0 + bh <= h:
        windows.append(lum[y0:y0 + bh, x0:x0 + bw])


def vertical_spectrum(win):
    """Mean luminance per screen row, then its autocorrelation / spectrum."""
    prof = win.mean(axis=1)
    prof = prof - prof.mean()
    if prof.std() < 1e-6:
        return None
    n = len(prof)
    # autocorrelation
    ac = np.correlate(prof, prof, mode="full")[n - 1:]
    ac = ac / ac[0]
    # dominant period from the first strong peak after lag 1
    peaks = []
    for lag in range(2, min(n // 2, 24)):
        if ac[lag] > ac[lag - 1] and ac[lag] >= ac[lag + 1] and ac[lag] > 0.15:
            peaks.append((lag, ac[lag]))
    peaks.sort(key=lambda p: -p[1])
    # amplitude of the row-to-row alternation
    even = prof[0::2].mean()
    odd = prof[1::2].mean()
    amp2 = abs(even - odd) / (prof.std() + 1e-6)
    return prof, ac, peaks[:4], amp2


print("\n--- vertical (row) profile analysis per window ---")
for i, win in enumerate(windows):
    res = vertical_spectrum(win)
    if res is None:
        print(f"  win{i}: flat")
        continue
    prof, ac, peaks, amp2 = res
    print(f"  win{i}: row-profile std={prof.std():.2f}  "
          f"lag1={ac[1]:+.3f} lag2={ac[2]:+.3f} lag3={ac[3]:+.3f} lag4={ac[4]:+.3f} "
          f"| even/odd alternation={amp2:.2f} | peaks(lag,ac)={[(l, round(v,3)) for l, v in peaks]}")

# Global: how much of the vertical variance is a pure 2-row alternation?
prof_all = lum.mean(axis=1)
prof_all = prof_all - prof_all.mean()
even = prof_all[0::2].mean()
odd = prof_all[1::2].mean()
print(f"\nglobal row profile: std={prof_all.std():.2f}  even-odd={abs(even - odd):.3f}")

# Horizontal check: is there any comparable horizontal striping?
prof_h = lum.mean(axis=0)
prof_h = prof_h - prof_h.mean()
print(f"global col profile: std={prof_h.std():.2f}")

# Per-column row-difference: a raster-space comb shows as high |d/dy| everywhere
d = np.abs(np.diff(lum, axis=0))
print(f"\nmean |row-to-row diff| = {d.mean():.2f}   mean |col-to-col diff| = {np.abs(np.diff(lum, axis=1)).mean():.2f}")

# Where is the striping strongest? Map mean |d/dy| in a coarse grid
print("\nmean |d/dy| by region (rows=8, cols=8):")
gh, gw = h // 8, w // 8
for r in range(8):
    line = []
    for c in range(8):
        blk = d[r * gh:(r + 1) * gh, c * gw:(c + 1) * gw]
        line.append(f"{blk.mean():5.1f}")
    print("   " + " ".join(line))
