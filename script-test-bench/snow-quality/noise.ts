// Bruit de gradient déterministe + fBm / fBm en crêtes pour le monde neigeux synthétique.

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number {
    // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export class GradientNoise {
  private readonly perm: Uint16Array;
  private readonly gx: Float32Array;
  private readonly gy: Float32Array;

  constructor(seed: number) {
    const rng = new Rng(seed);
    this.perm = new Uint16Array(512);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.gx = new Float32Array(256);
    this.gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const a = rng.next() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** Bruit de gradient façon Perlin, ~[-0.7, 0.7]. */
  at(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const p = this.perm;
    const h = (ix: number, iy: number) => p[(p[ix & 255] + iy) & 511] & 255;
    const dot = (ix: number, iy: number, dx: number, dy: number) => {
      const g = h(ix, iy);
      return this.gx[g] * dx + this.gy[g] * dy;
    };
    const n00 = dot(xi, yi, xf, yf);
    const n10 = dot(xi + 1, yi, xf - 1, yf);
    const n01 = dot(xi, yi + 1, xf, yf - 1);
    const n11 = dot(xi + 1, yi + 1, xf - 1, yf - 1);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return a + (b - a) * v;
  }

  fbm(x: number, y: number, octaves: number, gain = 0.5, lacunarity = 2): number {
    let sum = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.at(x * f + o * 17.3, y * f - o * 9.1);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Multifractal en crêtes dans [0, 1] : crêtes vives, vallées arrondies. */
  ridged(x: number, y: number, octaves: number, gain = 0.5, lacunarity = 2.1): number {
    let sum = 0;
    let amp = 1;
    let f = 1;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let r = 1 - Math.abs(this.at(x * f + o * 31.7, y * f + o * 7.7) * 1.4);
      r = Math.max(0, r);
      r *= r;
      r *= weight;
      weight = Math.min(1, Math.max(0, r * 1.6));
      sum += r * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
}
