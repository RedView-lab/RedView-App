/**
 * RedView DevOps Test-Bench Core Harness
 * 
 * Provides high-precision measurement, memory tracking, statistical analysis
 * (p50, p95, p99, stddev), regression thresholds and assertion validation.
 */
import { performance } from 'node:perf_hooks';

export interface BenchMetricOptions {
  name: string;
  category: string;
  iterations?: number;
  warmupIterations?: number;
  maxDurationMs?: number;
  regressionThresholdP95Ms?: number;
  unit?: string;
  itemsProcessedPerOp?: number;
}

export interface MetricStatistics {
  name: string;
  category: string;
  iterations: number;
  totalDurationMs: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  stdDevMs: number;
  opsPerSec: number;
  throughputItemsPerSec?: number;
  memoryDeltaMb: number;
  heapUsedFinalMb: number;
  status: 'PASS' | 'WARN' | 'REGRESSION' | 'FAIL';
  warningMessage?: string;
}

export class BenchmarkSuite {
  readonly title: string;
  readonly results: MetricStatistics[] = [];
  readonly recommendations: string[] = [];
  readonly regressionRisks: string[] = [];

  constructor(title: string) {
    this.title = title;
  }

  addRecommendation(rec: string): void {
    this.recommendations.push(rec);
  }

  addRegressionRisk(risk: string): void {
    this.regressionRisks.push(risk);
  }

  /**
   * Run a synchronous benchmark function
   */
  measureSync<T>(
    options: BenchMetricOptions,
    fn: (iteration: number) => T,
  ): MetricStatistics {
    const warmup = options.warmupIterations ?? 2;
    const iterations = options.iterations ?? 10;

    // Warmup phase (allows JIT optimization and inline caching)
    for (let i = 0; i < warmup; i++) {
      fn(i);
    }

    if (global.gc) {
      try {
        global.gc();
      } catch {
        // GC not exposed via --expose-gc, ignore
      }
    }

    const memBefore = process.memoryUsage().heapUsed;
    const samples: number[] = new Array(iterations);
    const startSuite = performance.now();

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      fn(i);
      const t1 = performance.now();
      samples[i] = t1 - t0;
    }

    const endSuite = performance.now();
    const memAfter = process.memoryUsage().heapUsed;

    const stats = calculateStats(
      options,
      samples,
      endSuite - startSuite,
      (memAfter - memBefore) / (1024 * 1024),
      memAfter / (1024 * 1024),
    );

    this.results.push(stats);
    return stats;
  }

  /**
   * Run an asynchronous benchmark function
   */
  async measureAsync<T>(
    options: BenchMetricOptions,
    fn: (iteration: number) => Promise<T>,
  ): Promise<MetricStatistics> {
    const warmup = options.warmupIterations ?? 2;
    const iterations = options.iterations ?? 10;

    for (let i = 0; i < warmup; i++) {
      await fn(i);
    }

    if (global.gc) {
      try {
        global.gc();
      } catch {
        // GC not exposed
      }
    }

    const memBefore = process.memoryUsage().heapUsed;
    const samples: number[] = new Array(iterations);
    const startSuite = performance.now();

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      await fn(i);
      const t1 = performance.now();
      samples[i] = t1 - t0;
    }

    const endSuite = performance.now();
    const memAfter = process.memoryUsage().heapUsed;

    const stats = calculateStats(
      options,
      samples,
      endSuite - startSuite,
      (memAfter - memBefore) / (1024 * 1024),
      memAfter / (1024 * 1024),
    );

    this.results.push(stats);
    return stats;
  }
}

function calculateStats(
  options: BenchMetricOptions,
  samples: number[],
  totalDurationMs: number,
  memoryDeltaMb: number,
  heapUsedFinalMb: number,
): MetricStatistics {
  const n = samples.length;
  if (n === 0) {
    throw new Error('Cannot calculate statistics for 0 samples');
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const minMs = sorted[0];
  const maxMs = sorted[n - 1];

  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const meanMs = sum / n;

  // Percentiles
  const p50Ms = getPercentile(sorted, 50);
  const p95Ms = getPercentile(sorted, 95);
  const p99Ms = getPercentile(sorted, 99);

  // Standard deviation
  let varianceSum = 0;
  for (let i = 0; i < n; i++) {
    const diff = sorted[i] - meanMs;
    varianceSum += diff * diff;
  }
  const stdDevMs = Math.sqrt(varianceSum / n);

  // Ops per second
  const opsPerSec = meanMs > 0 ? 1000 / meanMs : 0;
  const throughputItemsPerSec = options.itemsProcessedPerOp
    ? options.itemsProcessedPerOp * opsPerSec
    : undefined;

  // Status & Regression detection
  let status: 'PASS' | 'WARN' | 'REGRESSION' | 'FAIL' = 'PASS';
  let warningMessage: string | undefined;

  if (options.regressionThresholdP95Ms && p95Ms > options.regressionThresholdP95Ms) {
    status = 'REGRESSION';
    warningMessage = `p95 (${p95Ms.toFixed(2)}ms) exceeded threshold (${options.regressionThresholdP95Ms.toFixed(2)}ms)`;
  } else if (p99Ms > meanMs * 3.5 && meanMs > 5) {
    status = 'WARN';
    warningMessage = `High latency jitter: p99 is ${((p99Ms / meanMs) * 100).toFixed(0)}% of mean`;
  }

  return {
    name: options.name,
    category: options.category,
    iterations: n,
    totalDurationMs,
    minMs,
    maxMs,
    meanMs,
    p50Ms,
    p95Ms,
    p99Ms,
    stdDevMs,
    opsPerSec,
    throughputItemsPerSec,
    memoryDeltaMb,
    heapUsedFinalMb,
    status,
    warningMessage,
  };
}

function getPercentile(sorted: number[], p: number): number {
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
