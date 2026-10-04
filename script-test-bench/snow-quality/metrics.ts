// Skill metrics of a snow-depth map against the reference.

export interface SkillMetrics {
  rmseCm: number;
  maeCm: number;
  biasCm: number;
  /** Pearson correlation. */
  r: number;
  /** Nash–Sutcliffe efficiency. */
  nse: number;
  /** Model σ / reference σ. */
  sigmaRatio: number;
  /** Mass ratio model / reference. */
  massRatio: number;
  /** Snow / no-snow agreement (threshold 5 cm): Cohen's kappa. */
  kappa: number;
  /** Mean structural similarity on 30 m blocks (Wang et al. 2004), as used by Quéno et al. (2024). */
  ssim: number;
  /** Mean absolute bias per 100 m altitude band, cm. */
  bandBiasCm: number;
}

function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

function blockMean(a: Float32Array, w: number, h: number, b: number): { data: Float32Array; w: number; h: number } {
  const bw = Math.floor(w / b);
  const bh = Math.floor(h / b);
  const out = new Float32Array(bw * bh);
  for (let y = 0; y < bh * b; y++) for (let x = 0; x < bw * b; x++) out[Math.floor(y / b) * bw + Math.floor(x / b)] += a[y * w + x];
  for (let i = 0; i < out.length; i++) out[i] /= b * b;
  return { data: out, w: bw, h: bh };
}

function ssim(a: Float32Array, b: Float32Array, w: number, h: number): number {
  // 7×7 windows on the block maps, dynamic range from the reference.
  let range = 0;
  for (let i = 0; i < b.length; i++) range = Math.max(range, b[i]);
  const c1 = (0.01 * range) ** 2;
  const c2 = (0.03 * range) ** 2;
  const r = 3;
  let sum = 0, count = 0;
  for (let y = r; y < h - r; y += 2) {
    for (let x = r; x < w - r; x += 2) {
      let ma = 0, mb = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { ma += a[(y + dy) * w + x + dx]; mb += b[(y + dy) * w + x + dx]; n++; }
      ma /= n; mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const da = a[(y + dy) * w + x + dx] - ma;
          const db = b[(y + dy) * w + x + dx] - mb;
          va += da * da; vb += db * db; cov += da * db;
        }
      }
      va /= n - 1; vb /= n - 1; cov /= n - 1;
      sum += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

export function skill(model: Float32Array, ref: Float32Array, z: Float32Array, w: number, h: number, cellM: number): SkillMetrics {
  const n = ref.length;
  const mm = mean(model);
  const mr = mean(ref);
  let se = 0, ae = 0, cov = 0, vm = 0, vr = 0;
  for (let i = 0; i < n; i++) {
    const d = model[i] - ref[i];
    se += d * d;
    ae += Math.abs(d);
    cov += (model[i] - mm) * (ref[i] - mr);
    vm += (model[i] - mm) ** 2;
    vr += (ref[i] - mr) ** 2;
  }
  // Kappa on snow / no snow.
  let a = 0, b = 0, c = 0, d = 0;
  for (let i = 0; i < n; i++) {
    const ms = model[i] > 5, rs = ref[i] > 5;
    if (ms && rs) a++; else if (ms && !rs) b++; else if (!ms && rs) c++; else d++;
  }
  const po = (a + d) / n;
  const pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n);
  const kappa = pe < 1 ? (po - pe) / (1 - pe) : 1;
  // Altitude bands.
  const bands = new Map<number, { m: number; r: number; k: number }>();
  for (let i = 0; i < n; i++) {
    const key = Math.floor(z[i] / 100);
    const e = bands.get(key) ?? { m: 0, r: 0, k: 0 };
    e.m += model[i]; e.r += ref[i]; e.k++;
    bands.set(key, e);
  }
  let bandBias = 0, bandW = 0;
  for (const e of bands.values()) { bandBias += Math.abs(e.m - e.r); bandW += e.k; }
  const blocks = Math.max(1, Math.round(30 / cellM));
  const bm = blockMean(model, w, h, blocks);
  const br = blockMean(ref, w, h, blocks);
  return {
    rmseCm: Math.sqrt(se / n),
    maeCm: ae / n,
    biasCm: mm - mr,
    r: vm > 0 && vr > 0 ? cov / Math.sqrt(vm * vr) : 0,
    nse: vr > 0 ? 1 - se / vr : 0,
    sigmaRatio: vr > 0 ? Math.sqrt(vm / vr) : 0,
    massRatio: mr > 0 ? mm / mr : 0,
    kappa,
    ssim: ssim(bm.data, br.data, bm.w, bm.h),
    bandBiasCm: bandBias / bandW,
  };
}
