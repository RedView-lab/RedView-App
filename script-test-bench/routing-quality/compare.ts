/**
 * Comparaison avant/après du routing-quality bench.
 *
 *   npm run bench:routing:compare [-- --before before --after after]
 *
 * Écrit reports/routing-quality/ROUTING_QUALITY_REPORT.md et summary.json
 * (données de la page HTML), puis vérifie les garde-fous : code de sortie 1
 * si l'un d'eux échoue.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunFile, ScenarioResult } from './run.ts';
import type { SweepEntry } from './sweep.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPORT_DIR = path.join(ROOT, 'script-test-bench', 'reports', 'routing-quality');
const BANDS = ['<100', '100-200', '200-500', '>500'] as const;
/** Budget « Équilibré » : latence p95 par tranche (ms). */
const P95_BUDGET_MS: Record<(typeof BANDS)[number], number> = { '<100': 3000, '100-200': 4000, '200-500': 8000, '>500': 12000 };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}

function load(label: string): RunFile {
  return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${label}.json`), 'utf8')) as RunFile;
}

/** Ligne plate d'un résultat (km, %, etc.) — base des agrégats. */
export interface Flat {
  status: ScenarioResult['status'];
  latencyMs: number;
  km: number;
  dplus: number;
  dminus: number;
  durationMin: number;
  cost: number | null;
  asphaltKm: number;
  pavedKm: number;
  unpavedKm: number;
  unknownKm: number;
  majorKm: number;
  secondaryKm: number;
  tertiaryKm: number;
  minorKm: number;
  cyclewayKm: number;
  trackKm: number;
  pathKm: number;
  motorwayKm: number;
  ferryKm: number;
  cycleRouteKm: number;
  wrongWayKm: number;
  backtrackKm: number;
  aboveMaxSlopeKm: number;
  above10Km: number;
  maxGrade: number;
  clientDescentM: number;
  profileId: string | null;
}

function flat(r: ScenarioResult): Flat | null {
  const m = r.metrics;
  if (!m) return null;
  return {
    status: r.status,
    latencyMs: r.latencyMs,
    km: m.distanceKm,
    dplus: m.ascentM,
    dminus: m.descentM,
    durationMin: m.durationMin,
    cost: m.cost,
    asphaltKm: m.surfaceKm.asphalt,
    pavedKm: m.surfaceKm.paved,
    unpavedKm: m.surfaceKm.gravel + m.surfaceKm.dirt + m.surfaceKm.sand,
    unknownKm: m.surfaceKm.unknown,
    majorKm: m.roadKm.major,
    secondaryKm: m.roadKm.secondary,
    tertiaryKm: m.roadKm.tertiary,
    minorKm: m.roadKm.minor,
    cyclewayKm: m.roadKm.cycleway,
    trackKm: m.roadKm.track,
    pathKm: m.roadKm.path + m.roadKm.steps,
    motorwayKm: m.roadKm.motorway,
    ferryKm: m.roadKm.ferry,
    cycleRouteKm: m.cycleRouteKm,
    wrongWayKm: m.wrongWayKm,
    backtrackKm: m.backtrackKm,
    aboveMaxSlopeKm: m.kmAboveMaxSlope,
    above10Km: m.kmAbove10Pct,
    maxGrade: m.maxGrade200Pct,
    clientDescentM: m.clientDescentM,
    profileId: r.profileId,
  };
}

function quantile(values: number[], q: number): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const sum = (rows: Flat[], pick: (f: Flat) => number) => rows.reduce((t, f) => t + pick(f), 0);

export interface Aggregate {
  n: number;
  ok: number;
  fallback: number;
  error: number;
  km: number;
  dplus: number;
  dminus: number;
  durationH: number;
  pct: Record<string, number>;
  wrongWayKm: number;
  backtrackKm: number;
  aboveMaxSlopeKm: number;
  above10Km: number;
  motorwayKm: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  medianDetour: number;
}

/**
 * `results` : tous les scénarios du groupe (statuts, latence) ; `measured` :
 * ceux dont les métriques entrent dans les totaux — les paires où avant ET
 * après ont un tracé, sinon un échec d'un côté fausserait distances et parts.
 */
function aggregate(results: ScenarioResult[], beelineById: Map<string, number>, measured: ScenarioResult[] = results): Aggregate {
  const rows = measured.map(flat).filter((f): f is Flat => f != null);
  const km = sum(rows, (f) => f.km) || 1;
  const pct = (pick: (f: Flat) => number) => (sum(rows, pick) / km) * 100;
  const lat = results.filter((r) => r.status !== 'error').map((r) => r.latencyMs);
  return {
    n: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    fallback: results.filter((r) => r.status === 'fallback').length,
    error: results.filter((r) => r.status === 'error').length,
    km: sum(rows, (f) => f.km),
    dplus: sum(rows, (f) => f.dplus),
    dminus: sum(rows, (f) => f.dminus),
    durationH: sum(rows, (f) => f.durationMin) / 60,
    pct: {
      asphalt: pct((f) => f.asphaltKm),
      paved: pct((f) => f.pavedKm),
      unpaved: pct((f) => f.unpavedKm),
      unknown: pct((f) => f.unknownKm),
      major: pct((f) => f.majorKm),
      secondary: pct((f) => f.secondaryKm),
      tertiary: pct((f) => f.tertiaryKm),
      minor: pct((f) => f.minorKm),
      cycleway: pct((f) => f.cyclewayKm),
      track: pct((f) => f.trackKm),
      path: pct((f) => f.pathKm),
      cycleRoute: pct((f) => f.cycleRouteKm),
    },
    wrongWayKm: sum(rows, (f) => f.wrongWayKm),
    backtrackKm: sum(rows, (f) => f.backtrackKm),
    aboveMaxSlopeKm: sum(rows, (f) => f.aboveMaxSlopeKm),
    above10Km: sum(rows, (f) => f.above10Km),
    motorwayKm: sum(rows, (f) => f.motorwayKm),
    p50Ms: quantile(lat, 0.5),
    p95Ms: quantile(lat, 0.95),
    maxMs: lat.length ? Math.max(...lat) : Number.NaN,
    medianDetour: quantile(
      measured.filter((r) => r.metrics).map((r) => r.metrics!.distanceKm / (beelineById.get(r.id) || 1)),
      0.5,
    ),
  };
}

// ── Formatage ─────────────────────────────────────────────────────────

const f0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('fr-FR') : '—');
const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const s1 = (v: number) => (Number.isFinite(v) ? (v / 1000).toFixed(1) : '—');
function delta(before: number, after: number): string {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return '';
  const d = ((after - before) / before) * 100;
  return ` (${d > 0 ? '+' : ''}${d.toFixed(1)} %)`;
}
const arrow = (b: string, a: string) => (b === a ? b : `${b} → ${a}`);
const pp = (b: number, a: number) => arrow(f1(b), f1(a));

function table(headers: string[], rows: string[][]): string {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function aggRow(label: string, b: Aggregate, a: Aggregate, bike: boolean): string[] {
  return [
    label,
    String(a.n),
    `${f0(b.km)} → ${f0(a.km)}${delta(b.km, a.km)}`,
    `${f0(b.dplus)} → ${f0(a.dplus)}${delta(b.dplus, a.dplus)}`,
    `${f0(b.dminus)} → ${f0(a.dminus)}${delta(b.dminus, a.dminus)}`,
    pp(b.medianDetour, a.medianDetour).replace(/(\d\.\d)/g, '$1'),
    pp(b.pct.asphalt + b.pct.paved, a.pct.asphalt + a.pct.paved),
    pp(b.pct.unpaved, a.pct.unpaved),
    pp(b.pct.major, a.pct.major),
    pp(b.pct.cycleway, a.pct.cycleway),
    pp(b.pct.cycleRoute, a.pct.cycleRoute),
    bike ? pp(b.wrongWayKm, a.wrongWayKm) : '—',
    pp(b.aboveMaxSlopeKm, a.aboveMaxSlopeKm),
    `${s1(b.p50Ms)}/${s1(b.p95Ms)} → ${s1(a.p50Ms)}/${s1(a.p95Ms)}`,
    `${b.fallback}/${b.error} → ${a.fallback}/${a.error}`,
  ];
}

const AGG_HEADERS = [
  'Config', 'n', 'Distance km', 'D+ m', 'D− m', 'Détour méd.', 'Revêtu %', 'Non revêtu %',
  'Axes majeurs %', 'Pistes cyclables %', 'Véloroutes / balisés %', 'Contresens km', 'km > pente max',
  'Latence p50/p95 s', 'Replis/échecs',
];

function main() {
  const beforeLabel = arg('before', 'before');
  const afterLabel = arg('after', 'after');
  const before = load(beforeLabel);
  const after = load(afterLabel);
  const ids = Object.keys(after.results).filter((id) => before.results[id]);
  const B = (id: string) => before.results[id]!;
  const A = (id: string) => after.results[id]!;
  const beeline = new Map(ids.map((id) => [id, A(id).beelineKm]));

  const select = (pred: (r: ScenarioResult) => boolean) => ids.filter((id) => pred(A(id)));
  const both = (sel: string[]) => sel.filter((id) => B(id).metrics && A(id).metrics);
  const pair = (sel: string[]) => ({
    b: aggregate(sel.map(B), beeline, both(sel).map(B)),
    a: aggregate(sel.map(A), beeline, both(sel).map(A)),
  });

  const lines: string[] = [];
  lines.push('# Routage BRouter — rapport qualité avant / après');
  lines.push('');
  lines.push(`Avant : \`${before.gitHead}\` (${before.startedAt.slice(0, 16)}) · Après : \`${after.gitHead}\` (${after.startedAt.slice(0, 16)}) · ${ids.length} scénarios appariés, pipeline réel de l'app (client + proxy \`api/brouter.ts\`) contre le BRouter de prod.`);
  lines.push('');
  lines.push('Lecture : `avant → après`. Distances, D+ et D− sont des totaux sur les trajets de la ligne calculés des deux côtés (un échec d’un côté retire la paire des totaux, il est compté dans « Replis/échecs ») ; les parts (%) sont pondérées par la distance. D+/D− = méthode de l\'app (altitudes BRouter lissées). « Revêtu » = asphalte + pavés/béton ; « Non revêtu » = gravier + terre + sable. Latence = calcul du tracé (hors upload du profil, mis en cache). Repli = profil personnalisé abandonné au profit du profil stock (timeout client).');
  lines.push('');

  // 1. Synthèse vélo par tranche
  const bikePresets = (r: ScenarioResult) => r.family === 'vélo';
  lines.push('## 1. Vélo — synthèse par tranche de distance (9 presets route/gravel/VTT × 3 modes)');
  lines.push('');
  const bandRows = BANDS.map((band) => {
    const { b, a } = pair(select((r) => bikePresets(r) && r.band === band));
    return aggRow(band === '>500' ? '> 500 km' : band === '<100' ? '< 100 km' : `${band} km`, b, a, true);
  });
  const allBike = pair(select(bikePresets));
  bandRows.push(aggRow('**Tous**', allBike.b, allBike.a, true));
  lines.push(table(AGG_HEADERS, bandRows));
  lines.push('');

  // 2. Par preset vélo
  const configIds = [...new Set(ids.map((id) => A(id).configId))];
  const labelOf = (cid: string) => A(ids.find((id) => A(id).configId === cid)!).configLabel;
  const familyOf = (cid: string) => A(ids.find((id) => A(id).configId === cid)!).family;
  const section = (title: string, fam: string, bike: boolean) => {
    const cids = configIds.filter((c) => familyOf(c) === fam);
    if (!cids.length) return;
    lines.push(`## ${title}`);
    lines.push('');
    lines.push(table(AGG_HEADERS, cids.map((cid) => {
      const { b, a } = pair(select((r) => r.configId === cid));
      return aggRow(labelOf(cid), b, a, bike);
    })));
    lines.push('');
  };
  section('2. Vélo — par preset (toutes distances)', 'vélo', true);
  section('3. Vélo — variantes « Paramètres additionnels » (lot 100–200 km)', 'vélo-variante', true);
  section('4. Course à pied — Running', 'running', false);
  section('5. Course à pied — Trail', 'trail', false);

  // 6. Types de voies détaillés (vélo)
  lines.push('## 6. Vélo — répartition des types de voies et revêtements (% de la distance)');
  lines.push('');
  const roadHeaders = ['Config', 'Asphalte', 'Pavés/béton', 'Gravier/terre', 'Inconnu', 'Trunk/primary', 'Secondary', 'Tertiary', 'Petites routes', 'Cyclables', 'Chemins (track)', 'Sentiers (path)'];
  lines.push(table(roadHeaders, configIds.filter((c) => familyOf(c).startsWith('vélo')).map((cid) => {
    const { b, a } = pair(select((r) => r.configId === cid));
    return [labelOf(cid), ...(['asphalt', 'paved', 'unpaved', 'unknown', 'major', 'secondary', 'tertiary', 'minor', 'cycleway', 'track', 'path'] as const).map((k) => pp(b.pct[k]!, a.pct[k]!))];
  })));
  lines.push('');

  // 7. Sweep
  const sweepFile = path.join(REPORT_DIR, 'sweep.json');
  if (fs.existsSync(sweepFile)) {
    const sweep = Object.values(JSON.parse(fs.readFileSync(sweepFile, 'utf8')) as Record<string, SweepEntry>);
    lines.push('## 7. Calibration du coefficient A* (`pass1coefficient`, passe unique)');
    lines.push('');
    lines.push('Coefficient = poids × échelle de coût du profil (coût BRouter au mètre). Cellule : écart de coût à la meilleure solution trouvée (passe exacte quand elle a abouti), médiane / pire cas · latence médiane / max. « 3.5 » = réglage d’avant, identique pour tous les profils.');
    lines.push('');
    const columns: Array<{ label: string; match: (p: SweepEntry['points'][number]) => boolean }> = [
      { label: '3.5 (avant)', match: (p) => p.weight == null && !p.exact },
      ...[3.0, 2.2, 1.7, 1.4, 1.2, 1.05, 0.9].map((w) => ({ label: `w ${w}`, match: (p: SweepEntry['points'][number]) => p.weight === w })),
      { label: 'exacte', match: (p) => p.exact },
    ];
    const rows = BANDS.map((band) => {
      const entries = sweep.filter((e) => e.band === band);
      return [band, String(entries.length), ...columns.map((col) => {
        const gaps: number[] = [];
        const ms: number[] = [];
        for (const e of entries) {
          const okPts = e.points.filter((p) => p.ok);
          if (!okPts.length) continue;
          const best = Math.min(...okPts.map((p) => p.cost!));
          const p = e.points.find(col.match);
          if (!p?.ok) continue;
          gaps.push(((p.cost! - best) / best) * 100);
          ms.push(p.ms);
        }
        return gaps.length ? `${f1(quantile(gaps, 0.5))} / ${f1(Math.max(...gaps))} % · ${s1(quantile(ms, 0.5))} / ${s1(Math.max(...ms))} s` : '—';
      })];
    });
    lines.push(table(['Tranche', 'n', ...columns.map((c) => c.label)], rows));
    lines.push('');
  }

  // 8. Détail par trajet
  lines.push('## 8. Détail par trajet');
  lines.push('');
  const detailHeaders = ['Config', 'Trajet', 'Tranche', 'km', 'D+', 'D−', 'Non revêtu %', 'Axes majeurs %', 'Latence s', 'Statut'];
  lines.push(table(detailHeaders, ids.map((id) => {
    const b = flat(B(id));
    const a = flat(A(id));
    const pctOf = (f: Flat | null, k: 'unpavedKm' | 'majorKm') => (f ? (f[k] / (f.km || 1)) * 100 : Number.NaN);
    return [
      A(id).configLabel,
      A(id).routeLabel,
      A(id).band,
      `${f1(b?.km ?? Number.NaN)} → ${f1(a?.km ?? Number.NaN)}`,
      `${f0(b?.dplus ?? Number.NaN)} → ${f0(a?.dplus ?? Number.NaN)}`,
      `${f0(b?.dminus ?? Number.NaN)} → ${f0(a?.dminus ?? Number.NaN)}`,
      pp(pctOf(b, 'unpavedKm'), pctOf(a, 'unpavedKm')),
      pp(pctOf(b, 'majorKm'), pctOf(a, 'majorKm')),
      `${s1(B(id).latencyMs)} → ${s1(A(id).latencyMs)}`,
      arrow(B(id).status, A(id).status),
    ];
  })));
  lines.push('');

  // Garde-fous
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const allAfter = aggregate(ids.map(A), beeline);
  checks.push({ name: 'Aucune autoroute', ok: allAfter.motorwayKm < 0.05, detail: `${f1(allAfter.motorwayKm)} km` });
  const newErrors = ids.filter((id) => B(id).status !== 'error' && A(id).status === 'error');
  checks.push({ name: 'Aucun nouvel échec', ok: newErrors.length === 0, detail: newErrors.slice(0, 5).join(', ') || '0' });
  const fb = (run: (id: string) => ScenarioResult) => ids.filter((id) => run(id).status === 'fallback').length;
  checks.push({ name: 'Replis sur profil stock ≤ avant', ok: fb(A) <= fb(B), detail: `${fb(B)} → ${fb(A)}` });
  const roadIds = select((r) => r.family === 'vélo' && r.configId.startsWith('road-'));
  const roadAfter = aggregate(roadIds.map(A), beeline);
  const bikePairs = both(select((r) => r.family.startsWith('vélo')));
  checks.push({ name: 'Presets Route : non revêtu + chemins + sentiers ≤ 2 %', ok: roadAfter.pct.unpaved + roadAfter.pct.track + roadAfter.pct.path <= 2, detail: `${f1(roadAfter.pct.unpaved + roadAfter.pct.track + roadAfter.pct.path)} %` });
  const bikeIds = select((r) => r.family.startsWith('vélo'));
  void bikeIds;
  const ww = (run: (id: string) => ScenarioResult) => {
    const agg = aggregate(bikePairs.map(run), beeline);
    return (agg.wrongWayKm / Math.max(1, agg.km)) * 1000;
  };
  checks.push({ name: 'Vélo : contresens ≤ avant (km / 1 000 km, paires)', ok: ww(A) <= ww(B) * 1.05, detail: `${f1(ww(B))} → ${f1(ww(A))}` });
  const negDescent = ids.filter((id) => (A(id).metrics?.clientDescentM ?? 0) < 0).length;
  checks.push({ name: 'D− du client BRouter ≥ 0', ok: negDescent === 0, detail: `${negDescent} tracés négatifs` });
  for (const band of BANDS) {
    const agg = aggregate(select((r) => r.band === band).map(A), beeline);
    checks.push({ name: `Latence p95 ${band} km ≤ ${P95_BUDGET_MS[band] / 1000} s`, ok: !(agg.p95Ms > P95_BUDGET_MS[band]), detail: `${s1(agg.p95Ms)} s` });
  }
  lines.splice(6, 0, '## Garde-fous', '', table(['Contrôle', 'Résultat', 'Détail'], checks.map((c) => [c.name, c.ok ? 'OK' : '**ÉCHEC**', c.detail])), '');

  const mdFile = path.join(REPORT_DIR, 'ROUTING_QUALITY_REPORT.md');
  fs.writeFileSync(mdFile, `${lines.join('\n')}\n`);

  // Données de la page HTML
  const summary = {
    before: { label: beforeLabel, gitHead: before.gitHead, startedAt: before.startedAt },
    after: { label: afterLabel, gitHead: after.gitHead, startedAt: after.startedAt },
    checks,
    rows: ids.map((id) => ({ id, route: A(id).routeLabel, config: A(id).configLabel, configId: A(id).configId, family: A(id).family, band: A(id).band, terrain: A(id).terrain, beelineKm: A(id).beelineKm, maxSlopePct: A(id).maxSlopePct, before: { ...flat(B(id)), status: B(id).status, latencyMs: B(id).latencyMs }, after: { ...flat(A(id)), status: A(id).status, latencyMs: A(id).latencyMs } })),
  };
  fs.writeFileSync(path.join(REPORT_DIR, 'summary.json'), JSON.stringify(summary));

  console.log(lines.slice(0, 40).join('\n'));
  console.log(`\n→ ${path.relative(ROOT, mdFile)}`);
  for (const c of checks) console.log(`${c.ok ? 'OK   ' : 'ÉCHEC'} ${c.name} — ${c.detail}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main();
