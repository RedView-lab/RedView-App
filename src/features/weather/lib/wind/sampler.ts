import { clamp, lerp, WIND_BLEND_DURATION } from './types';
import type { WindBounds, WindData, WindSample } from './types';

// ── Wind field bilinear sampler with temporal blending ──────────────────
// Encapsulates all texture lookups and prev→current data crossfade logic.

export class WindSampler {
  private windData: WindData | null = null;
  private bounds: WindBounds | null = null;

  private prevWindData: WindData | null = null;
  private prevBounds: WindBounds | null = null;
  private blendT = 1;        // 0→1 crossfade progress
  private blendStart = 0;    // performance.now() when blend started

  get hasData(): boolean {
    return this.windData !== null && this.bounds !== null;
  }

  get currentBounds(): WindBounds | null {
    return this.bounds;
  }

  /** Feed new wind data. Initiates smooth crossfade from previous data. */
  setWindData(windData: WindData, bounds: WindBounds): void {
    if (this.windData && this.bounds) {
      this.prevWindData = this.windData;
      this.prevBounds = { ...this.bounds };
      this.blendT = 0;
      this.blendStart = performance.now();
    }
    this.windData = windData;
    this.bounds = bounds;
  }

  /** Advance crossfade timer. Call once per frame. */
  advanceBlend(now: number): void {
    if (this.blendT >= 1) return;
    const elapsed = (now - this.blendStart) / 1000;
    this.blendT = clamp(elapsed / WIND_BLEND_DURATION, 0, 1);
    if (this.blendT >= 1) {
      this.prevWindData = null;
      this.prevBounds = null;
    }
  }

  /** Sample wind at a geographic position with bilinear interpolation + blending. */
  sample(lng: number, lat: number): WindSample {
    const current = this.sampleFrom(lng, lat, this.windData, this.bounds);

    if (this.blendT < 1 && this.prevWindData && this.prevBounds) {
      const prev = this.sampleFrom(lng, lat, this.prevWindData, this.prevBounds);
      const t = this.blendT;
      return {
        u: lerp(prev.u, current.u, t),
        v: lerp(prev.v, current.v, t),
        speed: lerp(prev.speed, current.speed, t),
      };
    }

    return current;
  }

  /** Release all references. */
  dispose(): void {
    this.windData = null;
    this.bounds = null;
    this.prevWindData = null;
    this.prevBounds = null;
  }

  // ── Private sampling ───────────────────────────────────────────────

  private sampleFrom(
    lng: number, lat: number,
    data: WindData | null, bounds: WindBounds | null,
  ): WindSample {
    if (!data || !bounds) return { u: 0, v: 0, speed: 0 };

    const { width, height } = data;
    const rangeLng = bounds.east - bounds.west;
    const rangeLat = bounds.north - bounds.south;
    if (rangeLng <= 0 || rangeLat <= 0) return { u: 0, v: 0, speed: 0 };

    const nx = clamp((lng - bounds.west) / rangeLng, 0, 1) * (width - 1);
    const ny = clamp((bounds.north - lat) / rangeLat, 0, 1) * (height - 1);
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = nx - x0;
    const ty = ny - y0;

    // Bilinear interpolation of U/V components
    const tl = this.readUV(x0, y0, data);
    const tr = this.readUV(x1, y0, data);
    const bl = this.readUV(x0, y1, data);
    const br = this.readUV(x1, y1, data);

    const u = lerp(lerp(tl.u, tr.u, tx), lerp(bl.u, br.u, tx), ty);
    const v = lerp(lerp(tl.v, tr.v, tx), lerp(bl.v, br.v, tx), ty);

    // Bilinear interpolation of scalar speed (B channel)
    const sTL = this.readSpeed(x0, y0, data);
    const sTR = this.readSpeed(x1, y0, data);
    const sBL = this.readSpeed(x0, y1, data);
    const sBR = this.readSpeed(x1, y1, data);
    const speed = lerp(lerp(sTL, sTR, tx), lerp(sBL, sBR, tx), ty);

    return { u, v, speed };
  }

  private readUV(x: number, y: number, data: WindData): { u: number; v: number } {
    const idx = (y * data.width + x) * 3;
    return {
      u: data.image[idx],
      v: data.image[idx + 1],
    };
  }

  private readSpeed(x: number, y: number, data: WindData): number {
    const idx = (y * data.width + x) * 3;
    return data.image[idx + 2];
  }
}
