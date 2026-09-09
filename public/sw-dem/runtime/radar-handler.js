// ---------------------------------------------------------------------------
// Radar Tile Handler (Service Worker)
// Intercepts /radar-tiles/{z}/{x}/{y} requests, fetches live Doppler radar
// frames, and recolors precipitation intensity to match the user's custom palette.
// ---------------------------------------------------------------------------

/**
 * Converts RainViewer Scheme 2 (Universal Blue) pixel RGB into an estimated rain rate (mm/h).
 * Monotonically maps from light drizzle (0.1 mm/h) up to severe thunderstorm cores (> 20 mm/h).
 */
function rainviewerRgbToMm(r, g, b) {
  // 1. Warm core: Yellow -> Orange -> Red -> Dark Red (Convective / Heavy / Storm)
  if (r >= 200 && b < 40) {
    // g ranges from ~238 (yellow ~6 mm/h) down to ~27 (dark red ~23 mm/h)
    return 5.0 + ((255 - g) / 255.0) * 20.0;
  }
  // 2. Magenta / Purple / Extreme Hail (> 25 mm/h)
  if (r >= 180 && b >= 150 && g < 100) {
    return 25.0 + (r / 255.0) * 15.0;
  }
  // 3. Sand / Pale beige fringe (Light drizzle: 0.1 to 0.8 mm/h)
  if (r > 140 && g > 130 && b > 80 && Math.abs(r - g) < 45 && r > b) {
    return 0.1 + (1.0 - Math.min(r, g) / 255.0) * 0.7;
  }
  // 4. Cyan / Blue spectrum (0.8 to 5.0 mm/h)
  if (b >= 70) {
    // Dark blue / deep navy: r < 30, g < 150 -> 3.5 to 5.0 mm/h
    if (r < 30 && g < 150) {
      return 3.5 + (1.0 - g / 150.0) * 1.5;
    }
    // Medium blue: g in [140..190] -> 2.0 to 3.5 mm/h
    if (g < 190) {
      return 2.0 + (1.0 - (g - 140) / 50.0) * 1.5;
    }
    // Light cyan: g >= 190 -> 0.8 to 2.0 mm/h
    return 0.8 + ((255 - r) / 255.0) * 1.2;
  }
  return 0.5;
}

function hexToRgb(hex) {
  const safe = hex.replace('#', '').trim();
  const expanded = safe.length === 3
    ? safe.split('').map((c) => c + c).join('')
    : safe.padEnd(6, '0').slice(0, 6);
  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16),
  ];
}

function parseRadarPaletteParam(pStr) {
  if (!pStr) return { mode: 'gradient', bands: [] };
  const parts = pStr.split(':');
  const mode = parts[0] === 'fill' ? 'fill' : 'gradient';
  const bands = [];
  for (let i = 1; i < parts.length; i++) {
    const bandParts = parts[i].split('_');
    if (bandParts.length >= 3) {
      bands.push({
        color: '#' + bandParts[0].replace('#', ''),
        minValue: parseFloat(bandParts[1]) || 0,
        maxValue: parseFloat(bandParts[2]) || 20,
        visible: true,
      });
    }
  }
  return { mode, bands };
}

function buildRadarLookup(bands, mode, valMin = 0, valMax = 20) {
  const lookup = new Uint32Array(256);
  const span = Math.max(1e-5, valMax - valMin);

  if (!bands || bands.length === 0) {
    for (let b = 0; b < 256; b++) {
      if (b === 0) { lookup[b] = 0; continue; }
      const t = b / 255.0;
      const r = Math.round(223 + (18 - 223) * t);
      const g = Math.round(246 + (71 - 246) * t);
      const bl = Math.round(255 + (185 - 255) * t);
      lookup[b] = (255 << 24) | (bl << 16) | (g << 8) | r;
    }
    return lookup;
  }

  for (let b = 0; b < 256; b++) {
    const realVal = valMin + (b / 255.0) * span;
    let matchedIndex = bands.length - 1;
    for (let i = 0; i < bands.length; i++) {
      const maxV = Number.isFinite(bands[i].maxValue) ? bands[i].maxValue : Infinity;
      if (realVal < maxV || i === bands.length - 1) {
        matchedIndex = i;
        break;
      }
    }
    const matchedBand = bands[matchedIndex];
    if (matchedBand.visible === false) {
      lookup[b] = 0;
      continue;
    }
    if (mode === 'fill') {
      const [r, g, bl] = hexToRgb(matchedBand.color);
      lookup[b] = (255 << 24) | (bl << 16) | (g << 8) | r;
    } else {
      const bMin = Number.isFinite(matchedBand.minValue) ? matchedBand.minValue : valMin;
      const bMax = Number.isFinite(matchedBand.maxValue) ? matchedBand.maxValue : valMax;
      const bSpan = Math.max(1e-5, bMax - bMin);
      const t = Math.max(0, Math.min(1, (realVal - bMin) / bSpan));
      const curRgb = hexToRgb(matchedBand.color);
      const nextBand = bands[Math.min(bands.length - 1, matchedIndex + 1)];
      const nextRgb = hexToRgb(nextBand.color);
      const r = Math.round(curRgb[0] + (nextRgb[0] - curRgb[0]) * t);
      const g = Math.round(curRgb[1] + (nextRgb[1] - curRgb[1]) * t);
      const bl = Math.round(curRgb[2] + (nextRgb[2] - curRgb[2]) * t);
      lookup[b] = (255 << 24) | (bl << 16) | (g << 8) | r;
    }
  }
  return lookup;
}

const radarLookupCache = new Map();

function getOrCreateRadarLookup(pStr) {
  if (radarLookupCache.has(pStr)) {
    return radarLookupCache.get(pStr);
  }
  const { mode, bands } = parseRadarPaletteParam(pStr);
  const lookup = buildRadarLookup(bands, mode, 0, 20);
  radarLookupCache.set(pStr, lookup);
  return lookup;
}

/**
 * Intercepts /radar-tiles/{z}/{x}/{y}, fetches the raw RainViewer Doppler tile,
 * recolors it in ~0.7 ms, and returns a PNG response matching the user's custom palette.
 */
async function handleRadarTileRequest(url, z, x, y) {
  const host = (url.searchParams.get('host') || 'https://tilecache.rainviewer.com').replace(/\/+$/, '');
  const path = url.searchParams.get('path') || '';
  const pStr = url.searchParams.get('p') || '';

  if (!path) {
    return new Response(null, { status: 204 });
  }

  const cleanPath = path.startsWith('/') ? path : '/' + path;
  const upstreamUrl = `${host}${cleanPath}/512/${z}/${x}/${y}/2/1_1.png`;

  try {
    const res = await fetch(upstreamUrl);
    if (!res.ok) {
      return new Response(null, { status: 204 });
    }

    const blob = await res.blob();
    const imgBitmap = await createImageBitmap(blob);
    const w = imgBitmap.width;
    const h = imgBitmap.height;

    const lookup = getOrCreateRadarLookup(pStr);
    let recoloredBlob = null;

    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imgBitmap, 0, 0);
      imgBitmap.close();

      const imgData = ctx.getImageData(0, 0, w, h);
      const pixels = new Uint32Array(imgData.data.buffer);
      const len = pixels.length;

      for (let i = 0; i < len; i++) {
        const val = pixels[i];
        const a = (val >> 24) & 0xff;
        if (a < 15) {
          pixels[i] = 0;
          continue;
        }
        const r = val & 0xff;
        const g = (val >> 8) & 0xff;
        const b = (val >> 16) & 0xff;
        const mm = rainviewerRgbToMm(r, g, b);
        const idx = Math.round(Math.max(0, Math.min(1, mm / 20.0)) * 255.0);
        const recolored = lookup[idx];
        if (recolored === 0) {
          pixels[i] = 0;
        } else {
          pixels[i] = (recolored & 0x00ffffff) | (a << 24);
        }
      }

      ctx.putImageData(imgData, 0, 0);
      recoloredBlob = await canvas.convertToBlob({ type: 'image/png' });
    } else if (typeof buildRawPng === 'function') {
      imgBitmap.close();
      return new Response(null, { status: 204 });
    }

    if (!recoloredBlob) {
      return new Response(null, { status: 204 });
    }

    return new Response(recoloredBlob, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=300',
        'X-Weather-Source': 'radar-recolor',
      },
    });
  } catch (err) {
    console.warn('[radar-handler] recolor failed:', err);
    return new Response(null, { status: 204 });
  }
}
