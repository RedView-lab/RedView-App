import type { RouteStats } from './config';
import { computeClimbEfficiency } from './detours';
import type { RunResult } from './runner';

// Critères attendus par groupe de scénarios.

type Metric = keyof Pick<RouteStats, 'distanceKm' | 'ascentM' | 'descentM' | 'durationMin' | 'tortuosity'>;
const METRIC_LABEL: Record<Metric, string> = {
  distanceKm: 'dist (km)',
  ascentM: 'd+ (m)',
  descentM: 'd- (m)',
  durationMin: 'dur (min)',
  tortuosity: 'tortuosity',
};

function fmtMetricValue(metric: Metric, value: number): string {
  return metric === 'tortuosity' ? value.toFixed(3) : value.toFixed(0);
}

interface AbsCheck {
  kind: 'abs';
  index: number;
  metric: Metric;
  cmp: '>=' | '<=';
  value: number;
}
interface DeltaCheck {
  kind: 'delta';
  low: number;
  high: number;
  metric: Metric;
  cmp: '>=' | '<=';
  value: number;
}
interface RatioCheck {
  kind: 'ratio';
  low: number;
  high: number;
  metric: Metric;
  ratio: number;
}
interface EfficiencyCheck {
  kind: 'efficiency';
  baseline: number;
  scenario: number;
  minGainPerAddedKm: number;
  minAddedAscentM?: number;
  maxAddedDistanceKm?: number;
}
type Check = AbsCheck | DeltaCheck | RatioCheck | EfficiencyCheck;

export let totalChecks = 0;
export let failedChecks = 0;

export function runChecks(label: string, results: RunResult[], checks: Check[]): void {
  console.log(`\n  Sanity checks for «${label}»:`);
  for (const c of checks) {
    totalChecks++;
    if (c.kind === 'abs') {
      const r = results[c.index];
      if (r.stats.error) {
        failedChecks++;
        console.log(`    ⚠ ${r.scenario.name} — route failed (${r.stats.error})`);
        continue;
      }
      const v = r.stats[c.metric] as number;
      const ok = c.cmp === '>=' ? v >= c.value : v <= c.value;
      if (!ok) failedChecks++;
      console.log(
        `    ${ok ? '✅' : '❌'} ${r.scenario.name}: ${METRIC_LABEL[c.metric]}=${fmtMetricValue(c.metric, v)} ${c.cmp} ${c.value}`,
      );
    } else if (c.kind === 'delta') {
      const lo = results[c.low];
      const hi = results[c.high];
      if (lo.stats.error || hi.stats.error) {
        failedChecks++;
        console.log(`    ⚠ skipping ${lo.scenario.name} ↔ ${hi.scenario.name}`);
        continue;
      }
      const dv = (hi.stats[c.metric] as number) - (lo.stats[c.metric] as number);
      const ok = c.cmp === '>=' ? dv >= c.value : dv <= c.value;
      if (!ok) failedChecks++;
      const arrow = dv > 0 ? '↑' : dv < 0 ? '↓' : '=';
      console.log(
        `    ${ok ? '✅' : '❌'} Δ${METRIC_LABEL[c.metric]} ${arrow} ${fmtMetricValue(c.metric, dv)} ` +
          `(${lo.scenario.name} → ${hi.scenario.name}, expect ${c.cmp} ${c.value})`,
      );
    } else if (c.kind === 'ratio') {
      const lo = results[c.low];
      const hi = results[c.high];
      if (lo.stats.error || hi.stats.error) {
        failedChecks++;
        console.log(`    ⚠ skipping ${lo.scenario.name} ↔ ${hi.scenario.name}`);
        continue;
      }
      const lov = lo.stats[c.metric] as number;
      const hiv = hi.stats[c.metric] as number;
      const ratio = lov > 0 ? hiv / lov : Infinity;
      const ok = ratio >= c.ratio;
      if (!ok) failedChecks++;
      console.log(
        `    ${ok ? '✅' : '❌'} ${METRIC_LABEL[c.metric]} ratio = ${fmtMetricValue(c.metric, hiv)}/${fmtMetricValue(c.metric, lov)} = ${ratio.toFixed(2)}× ` +
          `(${lo.scenario.name} → ${hi.scenario.name}, expect ≥ ${c.ratio}×)`,
      );
    } else {
      const baseline = results[c.baseline];
      const scenario = results[c.scenario];
      if (baseline.stats.error || scenario.stats.error) {
        failedChecks++;
        console.log(`    ⚠ skipping ${baseline.scenario.name} ↔ ${scenario.scenario.name}`);
        continue;
      }
      const efficiency = computeClimbEfficiency(scenario.stats, baseline.stats);
      const okGainPerKm = efficiency.gainPerAddedKm >= c.minGainPerAddedKm;
      const okAddedAscent = c.minAddedAscentM === undefined || efficiency.addedAscentM >= c.minAddedAscentM;
      const okAddedDistance = c.maxAddedDistanceKm === undefined || efficiency.addedDistanceKm <= c.maxAddedDistanceKm;
      const ok = okGainPerKm && okAddedAscent && okAddedDistance;
      if (!ok) failedChecks++;
      console.log(
        `    ${ok ? '✅' : '❌'} climb efficiency = ${efficiency.addedAscentM.toFixed(0)}m / ${efficiency.addedDistanceKm.toFixed(1)}km = ${efficiency.gainPerAddedKm.toFixed(1)} m/km ` +
          `(${baseline.scenario.name} → ${scenario.scenario.name}, expect gain/km ≥ ${c.minGainPerAddedKm}` +
          `${c.minAddedAscentM === undefined ? '' : `, Δd+ ≥ ${c.minAddedAscentM}`}` +
          `${c.maxAddedDistanceKm === undefined ? '' : `, Δdist ≤ ${c.maxAddedDistanceKm}`}` +
          `)`,
      );
    }
  }
}
