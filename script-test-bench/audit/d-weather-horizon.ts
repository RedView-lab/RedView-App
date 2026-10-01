/**
 * Audit D / DW — Forecast (+2j) slider vs VPS forecast horizon.
 *
 * The slider allows day 0..+2, 00:00..23:00 local (forecastTime.ts L1, L91-93) but
 * the VPS meta only carries 48 hourly steps starting at the model run hour
 * (prod snapshot 2026-10-01: first=06:00Z, last=2026-10-03T05:00Z).
 * findClosestForecastHour() (vpsWeatherClient.ts L134-163) silently snaps any
 * later time to the LAST hour, so the map shows 07:00 weather under a 23:00 label.
 *
 * Uses the real functions. Exit 1 when some slider positions are served a tile
 * more than 1 h away from the requested time.
 *   npx tsx script-test-bench/audit/d-weather-horizon.ts
 */
process.env.TZ = 'Europe/Paris';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const imp = (p: string) => import(pathToFileURL(path.join(root, p)).href);
(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

const { clampForecastSelection } = await imp('src/features/weather/lib/forecastTime.ts');
const { findClosestForecastHour } = await imp('src/features/weather/overlay/vpsWeatherClient.ts');

// Prod meta snapshot (GET https://app.redview.tech/api/weather/meta.json, 2026-10-01)
const first = Date.parse('2026-10-01T06:00:00Z');
const hours = Array.from({ length: 48 }, (_, i) => new Date(first + i * 3600_000).toISOString().replace('.000Z', 'Z'));
const now = new Date('2026-10-01T10:30:00+02:00');

let mismatched = 0;
let total = 0;
const examples: string[] = [];
for (let day = 0; day <= 2; day++) {
  for (let h = 0; h <= 23; h++) {
    const d = new Date(now); d.setDate(d.getDate() + day);
    const dateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const sel = clampForecastSelection({ date: dateIso, time: `${String(h).padStart(2, '0')}:00`, forecastDay: day }, now);
    if (sel.date !== dateIso || sel.time !== `${String(h).padStart(2, '0')}:00`) continue; // slider cannot reach it
    total += 1;
    const shown = findClosestForecastHour(sel.date, sel.time, hours);
    const reqMs = new Date(`${sel.date}T${sel.time}:00`).getTime();
    const gapH = Math.abs(Date.parse(shown) - reqMs) / 3600_000;
    if (gapH > 1) {
      mismatched += 1;
      if (examples.length < 4) examples.push(`${sel.date} ${sel.time} local -> tile ${shown} (${gapH.toFixed(0)} h off)`);
    }
  }
}
console.log(`slider positions reachable: ${total}, served a tile > 1 h off: ${mismatched}`);
for (const e of examples) console.log('  ' + e);
if (mismatched > 0) {
  console.error('FAIL: forecast slider exceeds VPS horizon; map silently shows the last available hour.');
  process.exit(1);
}
console.log('PASS');
