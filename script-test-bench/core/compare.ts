/**
 * Compares a run with the previous saved report of the same mode: the
 * metrics whose median moved by a quarter or more, slowest first. Timings
 * only compare on the same machine state, so the differences of environment
 * (power source, CPU, Node) are printed with them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { environmentDifferences, type BenchEnvironment } from './environment.ts';
import type { BenchmarkSuite } from './harness.ts';
import type { SavedBenchReport } from './reporter.ts';

const MIN_COMPARABLE_MS = 0.1;

export interface MetricChange {
  suite: string;
  name: string;
  beforeP50Ms: number;
  afterP50Ms: number;
  ratio: number;
}

/** Latest `<prefix>-*.json` of the same mode (and feature filter), or null. */
export function findPreviousReport(
  reportsDir: string,
  mode: 'quick' | 'full',
  feature: string | null,
  prefix = 'benchmarks',
): { file: string; report: SavedBenchReport } | null {
  let files: string[];
  try {
    files = fs.readdirSync(reportsDir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.json')).sort().reverse();
  } catch {
    return null;
  }
  for (const file of files) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf8')) as SavedBenchReport;
      if (report.mode === mode && (report.feature ?? null) === feature) return { file, report };
    } catch {
      // unreadable report: skip it
    }
  }
  return null;
}

export function compareWithReport(previous: SavedBenchReport, suites: readonly BenchmarkSuite[], threshold = 0.25): MetricChange[] {
  const before = new Map<string, number>();
  for (const suite of previous.suites) for (const r of suite.results) before.set(`${suite.title}\u0000${r.name}`, r.p50Ms);
  const changes: MetricChange[] = [];
  for (const suite of suites) {
    for (const r of suite.results) {
      const p50 = before.get(`${suite.title}\u0000${r.name}`);
      // Under 0.1 ms a median is a few timer ticks: its ratio means nothing.
      if (p50 === undefined || p50 <= 0 || r.p50Ms <= 0 || Math.max(p50, r.p50Ms) < MIN_COMPARABLE_MS) continue;
      const ratio = r.p50Ms / p50;
      if (ratio >= 1 + threshold || ratio <= 1 / (1 + threshold)) {
        changes.push({ suite: suite.title, name: r.name, beforeP50Ms: p50, afterP50Ms: r.p50Ms, ratio });
      }
    }
  }
  return changes.sort((a, b) => b.ratio - a.ratio);
}

export function printComparison(
  file: string,
  previous: SavedBenchReport,
  environment: BenchEnvironment,
  changes: readonly MetricChange[],
): void {
  console.log(`\x1b[1m  COMPARAISON AVEC ${file}\x1b[0m (${previous.timestamp})`);
  const differences = previous.environment ? environmentDifferences(previous.environment, environment) : ['environnement du rapport précédent inconnu'];
  if (differences.length > 0) console.log(`  \x1b[33m⚠ Chiffres peu comparables : ${differences.join(' · ')}\x1b[0m`);
  if (changes.length === 0) {
    console.log('  Aucune médiane n’a bougé de ±25 %.\n');
    return;
  }
  for (const c of changes) {
    const color = c.ratio > 1 ? '\x1b[31m' : '\x1b[32m';
    const label = c.ratio > 1 ? `×${c.ratio.toFixed(2)} plus lent` : `×${(1 / c.ratio).toFixed(2)} plus rapide`;
    console.log(`  ${color}${label.padEnd(18)}\x1b[0m ${c.beforeP50Ms.toFixed(2)} → ${c.afterP50Ms.toFixed(2)} ms  ${c.suite} · ${c.name}`);
  }
  console.log('');
}
