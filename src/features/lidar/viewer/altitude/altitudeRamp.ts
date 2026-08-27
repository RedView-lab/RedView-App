import type { AltitudeBand, AltitudeColorization } from '@/features/controlPanel/types';

export const DEFAULT_MAX_ALTITUDE_M = 5000;

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseHexColor(hex: string, alpha = 255): RgbaColor {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 6) {
    const num = parseInt(clean, 16);
    if (!Number.isNaN(num)) {
      return {
        r: (num >> 16) & 0xff,
        g: (num >> 8) & 0xff,
        b: num & 0xff,
        a: alpha,
      };
    }
  } else if (clean.length === 8) {
    const num = parseInt(clean, 16);
    if (!Number.isNaN(num)) {
      return {
        r: (num >> 24) & 0xff,
        g: (num >> 16) & 0xff,
        b: (num >> 8) & 0xff,
        a: Math.round(((num & 0xff) / 255) * alpha),
      };
    }
  }
  return { r: 0, g: 0, b: 0, a: 0 };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Builds a 512x1 RGBA Uint8Array representing the 1D altitude LUT ramp.
 * Index 0 maps to 0 metres.
 * Index 511 maps to maxAltitude metres (default 5000m).
 */
export function buildAltitudeRampData(
  bands: AltitudeBand[],
  colorization: AltitudeColorization,
  maxAltitude = DEFAULT_MAX_ALTITUDE_M,
  lutSize = 512,
): Uint8Array {
  const data = new Uint8Array(lutSize * 4);
  if (!bands || bands.length === 0) {
    return data;
  }

  // Sort ascending by minMeters
  const sortedBands = [...bands].sort((a, b) => a.minMeters - b.minMeters);

  if (colorization === 'stepped') {
    for (let i = 0; i < lutSize; i++) {
      const altM = (i / (lutSize - 1)) * maxAltitude;
      let matchedBand: AltitudeBand | undefined;

      for (let b = 0; b < sortedBands.length; b++) {
        const band = sortedBands[b]!;
        const isLast = b === sortedBands.length - 1;
        if (altM >= band.minMeters && (altM < band.maxMeters || (isLast && altM <= maxAltitude))) {
          matchedBand = band;
          break;
        }
      }

      const offset = i * 4;
      if (matchedBand) {
        const rgba = parseHexColor(matchedBand.color, matchedBand.visible ? 255 : 0);
        data[offset] = rgba.r;
        data[offset + 1] = rgba.g;
        data[offset + 2] = rgba.b;
        data[offset + 3] = rgba.a;
      } else {
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        data[offset + 3] = 0;
      }
    }
    return data;
  }

  // Gradient mode: Smooth linear interpolation between altitude stops
  interface Stop {
    altM: number;
    color: RgbaColor;
  }

  const stops: Stop[] = sortedBands.map((band) => ({
    altM: band.minMeters,
    color: parseHexColor(band.color, band.visible ? 255 : 0),
  }));

  const lastBand = sortedBands[sortedBands.length - 1];
  if (lastBand) {
    stops.push({
      altM: maxAltitude,
      color: parseHexColor(lastBand.color, lastBand.visible ? 255 : 0),
    });
  }

  for (let i = 0; i < lutSize; i++) {
    const altM = (i / (lutSize - 1)) * maxAltitude;
    const offset = i * 4;

    if (altM <= stops[0]!.altM) {
      const c = stops[0]!.color;
      data[offset] = c.r;
      data[offset + 1] = c.g;
      data[offset + 2] = c.b;
      data[offset + 3] = c.a;
      continue;
    }

    if (altM >= stops[stops.length - 1]!.altM) {
      const c = stops[stops.length - 1]!.color;
      data[offset] = c.r;
      data[offset + 1] = c.g;
      data[offset + 2] = c.b;
      data[offset + 3] = c.a;
      continue;
    }

    // Find bounding stops
    let s0 = stops[0]!;
    let s1 = stops[1]!;
    for (let s = 0; s < stops.length - 1; s++) {
      if (altM >= stops[s]!.altM && altM <= stops[s + 1]!.altM) {
        s0 = stops[s]!;
        s1 = stops[s + 1]!;
        break;
      }
    }

    const range = Math.max(0.0001, s1.altM - s0.altM);
    const t = Math.max(0, Math.min(1, (altM - s0.altM) / range));

    data[offset] = Math.round(lerp(s0.color.r, s1.color.r, t));
    data[offset + 1] = Math.round(lerp(s0.color.g, s1.color.g, t));
    data[offset + 2] = Math.round(lerp(s0.color.b, s1.color.b, t));
    data[offset + 3] = Math.round(lerp(s0.color.a, s1.color.a, t));
  }

  return data;
}
