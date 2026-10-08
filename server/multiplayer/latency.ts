/**
 * Durées d'une étape du serveur, servies dans les mesures (`/metrics.json`) :
 *  - p50 / p95 / max des derniers échantillons (`samples`), pour un coup d'œil ;
 *  - un histogramme cumulé depuis le démarrage (`<nom>_count`, `<nom>_sum_ms`,
 *    `<nom>_le_<borne>`) : la différence entre deux relevés donne la
 *    répartition d'une fenêtre (banc de charge), sans qu'aucun lecteur ne
 *    remette rien à zéro pour les autres.
 */
const DEFAULT_BOUNDS_MS = [50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000] as const;
const DEFAULT_SAMPLES = 1_000;

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export class LatencyTrack {
  private readonly bounds: readonly number[];
  private readonly samples: number;
  private readonly recent: number[] = [];
  private readonly counts: number[];
  private count = 0;
  private sum = 0;

  constructor(bounds: readonly number[] = DEFAULT_BOUNDS_MS, samples = DEFAULT_SAMPLES) {
    this.bounds = bounds;
    this.samples = samples;
    this.counts = bounds.map(() => 0);
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.recent.push(ms);
    if (this.recent.length > this.samples) this.recent.shift();
    this.count += 1;
    this.sum += ms;
    for (let index = 0; index < this.bounds.length; index += 1) if (ms <= this.bounds[index]) this.counts[index] += 1;
  }

  percentile(q: number): number {
    return Math.round(percentile(this.recent, q));
  }

  /** p50 / p95 / max récents et histogramme cumulé, sous `<prefix>_…`. */
  metrics(prefix: string): Record<string, number> {
    const out: Record<string, number> = {
      [`${prefix}_p50_ms`]: this.percentile(0.5),
      [`${prefix}_p95_ms`]: this.percentile(0.95),
      [`${prefix}_max_ms`]: Math.round(this.recent.reduce((max, value) => Math.max(max, value), 0)),
      [`${prefix}_count`]: this.count,
      [`${prefix}_sum_ms`]: Math.round(this.sum),
    };
    this.bounds.forEach((bound, index) => {
      out[`${prefix}_le_${bound}`] = this.counts[index];
    });
    return out;
  }
}
