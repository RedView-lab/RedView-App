/**
 * C5 — Moteur WASM réel (même API que engine/worker.ts : predict(fitArrays, gpx, config, onProgress))
 * alimenté par les vrais .fit + entrées dégradées.
 *
 * Usage : npx tsx script-test-bench/audit/c-fit-engine.ts
 * Code de sortie != 0 si : NaN/valeurs absurdes, entrée dégradée acceptée en
 * silence, panic WASM au lieu d'une erreur propre, ou instance WASM
 * inutilisable après une erreur (le worker garde la même instance à vie).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultItinerary } from '../../src/features/itineraryPanel/lib/project/defaultState.ts';
import {
  buildPredictionConfigFromRhythm,
  buildRouteGpxFile,
} from '../../src/features/itineraryPanel/lib/schedule/container-prediction.ts';
import { DL, FIT_DIR, GT20, TDF, loadWasm, mb, readGpxPoints, silenceConsole } from './c-lib.ts';

const failures: string[] = [];
const rows: string[] = [];
const QUICK = process.argv.includes('--quick');

const fitFiles = [
  ...fs.readdirSync(FIT_DIR).filter((f) => f.toLowerCase().endsWith('.fit')).map((f) => path.join(FIT_DIR, f)),
  path.join(DL, 'Les 6 Puys 16 km.fit'),
];
const fits = fitFiles.map((f) => ({ name: path.basename(f), bytes: new Uint8Array(fs.readFileSync(f)) }));

async function buildGpx(file: string) {
  const it = createDefaultItinerary(1);
  const points = readGpxPoints(file);
  it.name = path.basename(file, '.gpx');
  it.gpxRoute = { name: it.name, points } as never;
  it.rhythm = { ...it.rhythm, rhythmProfile: 'custom', usePastActivities: true, ftp: null } as never;
  const cfg = buildPredictionConfigFromRhythm(it.rhythm, points as never);
  const gpx = new Uint8Array(await buildRouteGpxFile(it).arrayBuffer());
  return { cfg, gpx, nPts: points.length };
}

function scanNonFinite(v: unknown, acc = { n: 0, paths: new Set<string>() }, p = ''): { n: number; paths: Set<string> } {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) { acc.n++; acc.paths.add(p.replace(/\[\d+\]/g, '[]')); }
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => scanNonFinite(x, acc, `${p}[${i}]`));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) scanNonFinite(x, acc, p ? `${p}.${k}` : k);
  }
  return acc;
}

type Outcome = { ok: boolean; ms: number; rssMB: number; result?: any; error?: string; trap?: boolean };

function run(glue: any, fitArrays: Uint8Array[], gpx: Uint8Array, cfg: unknown): Outcome {
  const t0 = performance.now();
  try {
    const result = silenceConsole(() => glue.predict(fitArrays, gpx, cfg ?? {}, () => {}));
    return { ok: true, ms: performance.now() - t0, rssMB: process.memoryUsage().rss / 1048576, result };
  } catch (e) {
    const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    return {
      ok: false, ms: performance.now() - t0, rssMB: process.memoryUsage().rss / 1048576,
      error: msg, trap: e instanceof WebAssembly.RuntimeError,
    };
  }
}

function sanity(label: string, o: Outcome) {
  if (!o.ok) {
    const line = `${label.padEnd(46)} ${o.ms.toFixed(0).padStart(6)} ms  ERREUR ${o.error}`;
    rows.push(line); console.log(line);
    failures.push(`${label}: prédiction en échec (${o.error})`);
    return;
  }
  const r = o.result;
  const nf = scanNonFinite(r);
  const p = r.rider_profile ?? {};
  const line = `${label.padEnd(46)} ${o.ms.toFixed(0).padStart(6)} ms  rss ${o.rssMB.toFixed(0)} MB  `
    + `t=${(r.total_time_s / 3600).toFixed(2)} h  v=${r.avg_speed_kmh?.toFixed(1)} km/h  d=${(r.total_distance_m / 1000).toFixed(0)} km  `
    + `ftp=${typeof p.ftp_w === 'number' ? p.ftp_w.toFixed(0) : '?'} W  nonFinite=${nf.n}${nf.n ? ` (${[...nf.paths].slice(0, 4).join(', ')})` : ''}`;
  rows.push(line);
  console.log(line);
  if (nf.n > 0) failures.push(`${label}: ${nf.n} valeurs non finies (${[...nf.paths].slice(0, 4).join(', ')})`);
  if (!(r.total_time_s > 0) || !(r.avg_speed_kmh > 5 && r.avg_speed_kmh < 60)) failures.push(`${label}: vitesse/durée absurde`);
}

async function main() {
  const glue = await loadWasm();
  const gt20 = await buildGpx(GT20);
  console.log(`GT20 : ${gt20.nPts} pts, gpx ${mb(gt20.gpx.length)} MB, config ${JSON.stringify(gt20.cfg)}`);

  console.log('\n-- 1. Vrais .fit, un par un (route GT20) --');
  sanity('aucun FIT (niveau seul)', run(glue, [], gt20.gpx, gt20.cfg));
  for (const f of fits) sanity(`${f.name} (${mb(f.bytes.length)} MB)`, run(glue, [f.bytes], gt20.gpx, gt20.cfg));
  sanity(`les ${fits.length} FIT ensemble`, run(glue, fits.map((f) => f.bytes), gt20.gpx, gt20.cfg));

  console.log('\n-- 2. Route longue (Tour de France) : coût d\'un recalcul --');
  const tdf = await buildGpx(TDF);
  console.log(`TdF : ${tdf.nPts} pts, gpx ${mb(tdf.gpx.length)} MB, config ${JSON.stringify(tdf.cfg)}`);
  sanity('TdF sans FIT', run(glue, [], tdf.gpx, tdf.cfg));
  sanity(`TdF + ${fits.length} FIT`, run(glue, fits.map((f) => f.bytes), tdf.gpx, tdf.cfg));

  console.log('\n-- 3. Entrées dégradées --');
  const biggest = fits.reduce((a, b) => (a.bytes.length > b.bytes.length ? a : b));
  const rnd = new Uint8Array(1 << 20);
  let s0 = 7; for (let i = 0; i < rnd.length; i++) { s0 = (s0 * 1103515245 + 12345) % 2147483648; rnd[i] = s0 & 0xff; }
  const gpxAsFit = new Uint8Array(fs.readFileSync(GT20));
  const chained = (n: number) => {
    const out = new Uint8Array(biggest.bytes.length * n);
    for (let i = 0; i < n; i++) out.set(biggest.bytes, i * biggest.bytes.length);
    return out;
  };
  const truncated = biggest.bytes.slice(0, Math.floor(biggest.bytes.length * 0.3));
  const headerOnly = biggest.bytes.slice(0, 14);
  const degraded: Array<[string, Uint8Array[], 'throw' | 'any']> = [
    ['fichier vide (0 o)', [new Uint8Array(0)], 'throw'],
    ['en-tête seul (14 o)', [headerOnly], 'any'],
    [`tronqué à 30 % (${mb(truncated.length)} MB)`, [truncated], 'any'],
    ['octets aléatoires 1 MB', [rnd], 'throw'],
    ['GPX renommé .fit', [gpxAsFit], 'throw'],
    ['lot : 5 FIT valides + 1 vide', [...fits.slice(0, 5).map((f) => f.bytes), new Uint8Array(0)], 'any'],
  ];
  for (const [label, arr, expect] of degraded) {
    const o = run(glue, arr, gt20.gpx, gt20.cfg);
    const line = `${label.padEnd(46)} ${o.ms.toFixed(0).padStart(6)} ms  ${o.ok ? `OK t=${(o.result.total_time_s / 3600).toFixed(2)} h, activités=${o.result.rider_profile?.n_activities ?? '?'}` : `ERREUR ${o.error}`}`;
    rows.push(line); console.log(line);
    if (o.trap) failures.push(`${label}: trap WASM (panic) au lieu d'une erreur propre : ${o.error}`);
    if (expect === 'throw' && o.ok) failures.push(`${label}: accepté silencieusement`);
    if (o.ok) { const nf = scanNonFinite(o.result); if (nf.n) failures.push(`${label}: ${nf.n} non finis`); }
  }

  console.log('\n-- 4. Gros volumes --');
  for (const n of QUICK ? [10] : [10, 40, 100]) {
    const big = chained(n);
    const o = run(glue, [big], gt20.gpx, gt20.cfg);
    const line = `FIT chaîné x${n} (${mb(big.length)} MB)`.padEnd(46) + ` ${o.ms.toFixed(0).padStart(6)} ms  rss ${o.rssMB.toFixed(0)} MB  ${o.ok ? `OK activités=${o.result.rider_profile?.n_activities ?? '?'}` : `ERREUR ${o.error}`}`;
    rows.push(line); console.log(line);
    if (o.trap) failures.push(`FIT chaîné x${n}: trap WASM ${o.error}`);
  }
  const twenty = Array.from({ length: 20 }, () => biggest.bytes);
  const o20 = run(glue, twenty, gt20.gpx, gt20.cfg);
  const l20 = `20 x ${biggest.name} (${mb(biggest.bytes.length * 20)} MB)`.padEnd(46) + ` ${o20.ms.toFixed(0).padStart(6)} ms  rss ${o20.rssMB.toFixed(0)} MB  ${o20.ok ? 'OK' : o20.error}`;
  rows.push(l20); console.log(l20);

  console.log('\n-- 5. Fuzz (octets corrompus) + état de l\'instance après erreur --');
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const small = fits.find((f) => f.name.startsWith('Les 6 Puys'))!.bytes;
  let traps = 0, errors = 0, oks = 0, firstTrap = '', poisoned = 0;
  const N = QUICK ? 100 : 400;
  for (let i = 0; i < N; i++) {
    const mut = small.slice();
    const flips = 1 + Math.floor(rand() * 8);
    for (let k = 0; k < flips; k++) mut[14 + Math.floor(rand() * (mut.length - 16))] = (rand() * 256) | 0;
    const o = run(glue, [mut], gt20.gpx, gt20.cfg);
    if (o.trap) {
      traps++; if (!firstTrap) firstTrap = o.error!;
      const check = run(glue, [small], gt20.gpx, gt20.cfg);
      if (!check.ok) { poisoned++; if (poisoned === 1) console.log(`  après trap #${traps}: appel valide -> ${check.error}`); }
    } else if (o.ok) oks++; else errors++;
  }
  const fuzzLine = `fuzz ${N} mutations : ${oks} OK, ${errors} erreurs propres, ${traps} traps WASM${firstTrap ? ` (1er: ${firstTrap})` : ''}, instance inutilisable après trap : ${poisoned}`;
  rows.push(fuzzLine); console.log(fuzzLine);
  if (traps > 0) failures.push(`fuzz : ${traps} panics WASM (RuntimeError) — ${firstTrap}`);
  if (poisoned > 0) failures.push(`fuzz : instance WASM inutilisable après panic (${poisoned} fois)`);

  console.log(failures.length ? `\nFAIL ${failures.length} échec(s):\n  - ${failures.join('\n  - ')}` : '\nOK aucun défaut');
  process.exitCode = failures.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 2; });
