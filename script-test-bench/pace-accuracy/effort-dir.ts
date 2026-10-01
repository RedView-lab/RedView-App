/**
 * Effort et conditions par sortie : fréquence cardiaque, température, cadence,
 * puissance moyennes en roulant, puis vitesse et puissance (zéros compris) par
 * classe de pente sur des blocs de 200 m — pour séparer « moins de watts » de
 * « plus de résistance » quand une sortie est plus lente que les autres.
 *
 *   npx tsx script-test-bench/pace-accuracy/effort-dir.ts <dossier>
 */
import fs from 'node:fs';
import path from 'node:path';
import { Decoder, Stream } from '@garmin/fitsdk';

const dir = process.argv[2];
if (!dir) throw new Error('usage: effort-dir.ts <dossier>');
const CLASSES: [string, number, number][] = [['-1..1', -1, 1], ['1..3', 1, 3], ['3..6', 3, 6], ['6..9', 6, 9]];
const BLOCK_M = 200;
for (const file of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.fit'))) {
  const { messages } = new Decoder(Stream.fromByteArray(new Uint8Array(fs.readFileSync(path.join(dir, file))))).read();
  const recs = (messages.recordMesgs ?? []) as Record<string, unknown>[];
  let hr = 0, nHr = 0, temp = 0, nT = 0, cad = 0, nCad = 0, pw = 0, nPw = 0;
  for (const r of recs) {
    const speed = (r.enhancedSpeed ?? r.speed) as number | undefined;
    if (!(typeof speed === 'number' && speed > 2)) continue;
    if (typeof r.heartRate === 'number' && r.heartRate > 40) { hr += r.heartRate; nHr++; }
    if (typeof r.temperature === 'number') { temp += r.temperature; nT++; }
    if (typeof r.cadence === 'number' && r.cadence > 0) { cad += r.cadence; nCad++; }
    if (typeof r.power === 'number' && r.power > 0) { pw += r.power; nPw++; }
  }
  const f = (v: number, n: number, d = 0) => (n > 0 ? (v / n).toFixed(d) : '-');
  console.log(`${file.padEnd(40)} FC ${f(hr, nHr)} bpm · T ${f(temp, nT, 1)} °C · cadence ${f(cad, nCad)} · puissance (>0) ${f(pw, nPw)} W`);

  // Blocs de 200 m en roulant : pente baro, vitesse, puissance moyenne en temps (roue libre comprise).
  const pts = recs
    .map((r) => ({
      t: r.timestamp instanceof Date ? r.timestamp.getTime() / 1000 : NaN,
      d: r.distance as number,
      e: (r.enhancedAltitude ?? r.altitude) as number,
      p: typeof r.power === 'number' ? r.power : NaN,
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.d) && Number.isFinite(p.e));
  const acc = CLASSES.map(() => ({ m: 0, s: 0, j: 0, sp: 0 }));
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.d - pts[start]!.d < BLOCK_M) continue;
    const a = pts[start]!, b = pts[i]!;
    start = i;
    const dt = b.t - a.t, dd = b.d - a.d;
    if (dt <= 0 || dt > 120 || dd / dt < 2) continue; // arrêt dans le bloc : ignoré
    const g = ((b.e - a.e) / dd) * 100;
    const k = CLASSES.findIndex(([, lo, hi]) => g >= lo && g < hi);
    if (k < 0) continue;
    let joules = 0, sp = 0;
    for (let j = pts.indexOf(a) + 1; j <= i; j++) {
      const step = pts[j]!.t - pts[j - 1]!.t;
      if (Number.isFinite(pts[j]!.p)) { joules += pts[j]!.p * step; sp += step; }
    }
    acc[k]!.m += dd; acc[k]!.s += dt; acc[k]!.j += joules; acc[k]!.sp += sp;
  }
  console.log(`  ${CLASSES.map(([l], k) => {
    const c = acc[k]!;
    if (c.m < 5000) return `${l}: -`;
    return `${l}: ${(c.m / 1000 / (c.s / 3600)).toFixed(1)} km/h ${c.sp > 0 ? (c.j / c.sp).toFixed(0) : '-'} W (${(c.m / 1000).toFixed(0)} km)`;
  }).join(' · ')}`);
}
