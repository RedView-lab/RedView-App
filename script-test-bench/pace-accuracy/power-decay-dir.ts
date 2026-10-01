/**
 * Puissance réelle par tranche de temps de roulage (capteur de puissance) :
 * forme de la baisse d'intensité au fil d'un ultra, sans le terrain.
 *   npx tsx script-test-bench/pace-accuracy/power-decay-dir.ts <dossier> [--slice=6]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Decoder, Stream } from '@garmin/fitsdk';

const dir = process.argv[2];
if (!dir) throw new Error('usage: power-decay-dir.ts <dossier>');
const sliceH = Number(process.argv.find((a) => a.startsWith('--slice='))?.slice(8) ?? 6);
for (const file of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.fit'))) {
  const { messages } = new Decoder(Stream.fromByteArray(new Uint8Array(fs.readFileSync(path.join(dir, file))))).read();
  const recs = ((messages.recordMesgs ?? []) as Record<string, any>[])
    .map((r) => ({ t: r.timestamp instanceof Date ? r.timestamp.getTime() / 1000 : NaN, d: r.distance as number, e: (r.enhancedAltitude ?? r.altitude) as number, p: typeof r.power === 'number' ? r.power : NaN, v: (r.enhancedSpeed ?? r.speed) as number }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.d));
  let moving = 0;
  // Par tranche : énergie / temps (zéros compris), et puissance en montée (pente ≥ 3 % sur 200 m).
  const s: { j: number; dt: number; jc: number; dtc: number; dist: number }[] = [];
  let blockStart = 0;
  for (let i = 1; i < recs.length; i++) {
    const a = recs[i - 1]!, b = recs[i]!;
    const dt = b.t - a.t, dd = b.d - a.d;
    if (!(dt > 0 && dt <= 30 && dd / dt >= 0.6)) continue;
    const k = Math.floor(moving / 3600 / sliceH);
    moving += dt;
    s[k] ??= { j: 0, dt: 0, jc: 0, dtc: 0, dist: 0 };
    s[k]!.dist += dd;
    if (Number.isFinite(b.p)) { s[k]!.j += b.p * dt; s[k]!.dt += dt; }
    // pente locale sur ~200 m
    while (blockStart < i && b.d - recs[blockStart]!.d > 200) blockStart++;
    const a0 = recs[Math.max(0, blockStart - 1)]!;
    const g = b.d - a0.d > 100 ? (b.e - a0.e) / (b.d - a0.d) : 0;
    if (g >= 0.03 && Number.isFinite(b.p)) { s[k]!.jc += b.p * dt; s[k]!.dtc += dt; }
  }
  const base = s[0] ? s[0].j / s[0].dt : NaN;
  const baseC = s[0] && s[0].dtc > 0 ? s[0].jc / s[0].dtc : NaN;
  console.log(`${file.slice(0, 34).padEnd(34)} ${(moving / 3600).toFixed(1)} h`);
  console.log(`   P moy  ${s.map((x) => (x && x.dt > 600 ? (x.j / x.dt / base).toFixed(2) : ' -  ')).join(' ')}   (base ${base.toFixed(0)} W)`);
  console.log(`   P mont ${s.map((x) => (x && x.dtc > 600 ? (x.jc / x.dtc / baseC).toFixed(2) : ' -  ')).join(' ')}   (base ${baseC.toFixed(0)} W)`);
  console.log(`   km/h   ${s.map((x) => (x ? (x.dist / 1000 / sliceH).toFixed(0).padStart(4) : ' -  ')).join(' ')}`);
}
