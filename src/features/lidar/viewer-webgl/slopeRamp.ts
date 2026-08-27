import type { SlopeBand, SlopeColorization } from '@/features/controlPanel/types';

export interface SlopeRampOptions {
  bands: SlopeBand[];
  colorization: SlopeColorization; // 'gradient' | 'stepped'
}

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
  }
  return { r: 0, g: 0, b: 0, a: 0 };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Builds a 256x1 RGBA Uint8Array representing the 1D slope LUT ramp.
 * Index 0 maps to 0 degrees (flat horizontal terrain).
 * Index 255 maps to 90 degrees (vertical wall / cliff).
 */
export function buildSlopeRampData(
  bands: SlopeBand[],
  colorization: SlopeColorization,
  lutSize = 256,
): Uint8Array {
  const data = new Uint8Array(lutSize * 4);
  if (!bands || bands.length === 0) {
    return data;
  }

  // Sort bands ascending by minDeg to be robust
  const sortedBands = [...bands].sort((a, b) => a.minDeg - b.minDeg);

  if (colorization === 'stepped') {
    for (let i = 0; i < lutSize; i++) {
      const deg = (i / (lutSize - 1)) * 90.0;
      let matchedBand: SlopeBand | undefined;

      for (let b = 0; b < sortedBands.length; b++) {
        const band = sortedBands[b];
        const isLast = b === sortedBands.length - 1;
        if (deg >= band.minDeg && (deg < band.maxDeg || (isLast && deg <= 90.0))) {
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

  // Gradient mode: Smooth linear interpolation between band stops
  interface Stop {
    deg: number;
    color: RgbaColor;
  }

  const stops: Stop[] = sortedBands.map((band) => ({
    deg: band.minDeg,
    color: parseHexColor(band.color, band.visible ? 255 : 0),
  }));

  // Append final anchor at 90 degrees using the last band's color
  const lastBand = sortedBands[sortedBands.length - 1];
  if (lastBand) {
    stops.push({
      deg: 90.0,
      color: parseHexColor(lastBand.color, lastBand.visible ? 255 : 0),
    });
  }

  for (let i = 0; i < lutSize; i++) {
    const deg = (i / (lutSize - 1)) * 90.0;
    const offset = i * 4;

    if (deg <= stops[0].deg) {
      const c = stops[0].color;
      data[offset] = c.r;
      data[offset + 1] = c.g;
      data[offset + 2] = c.b;
      data[offset + 3] = c.a;
      continue;
    }

    if (deg >= stops[stops.length - 1].deg) {
      const c = stops[stops.length - 1].color;
      data[offset] = c.r;
      data[offset + 1] = c.g;
      data[offset + 2] = c.b;
      data[offset + 3] = c.a;
      continue;
    }

    // Find the bounding stops
    let s0 = stops[0];
    let s1 = stops[1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (deg >= stops[s].deg && deg <= stops[s + 1].deg) {
        s0 = stops[s];
        s1 = stops[s + 1];
        break;
      }
    }

    const range = Math.max(0.0001, s1.deg - s0.deg);
    const t = Math.max(0, Math.min(1, (deg - s0.deg) / range));

    data[offset] = Math.round(lerp(s0.color.r, s1.color.r, t));
    data[offset + 1] = Math.round(lerp(s0.color.g, s1.color.g, t));
    data[offset + 2] = Math.round(lerp(s0.color.b, s1.color.b, t));
    data[offset + 3] = Math.round(lerp(s0.color.a, s1.color.a, t));
  }

  return data;
}

/**
 * Creates or updates a WebGL2 1D/2D LUT texture containing the slope color ramp.
 */
export function updateSlopeRampTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture | null,
  bands: SlopeBand[],
  colorization: SlopeColorization,
  lutSize = 256,
): WebGLTexture {
  const tex = texture ?? gl.createTexture()!;
  const data = buildSlopeRampData(bands, colorization, lutSize);

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    lutSize,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data,
  );

  const filter = colorization === 'stepped' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
