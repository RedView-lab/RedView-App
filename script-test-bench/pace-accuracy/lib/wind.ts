/**
 * R9 — Vent historique (Open-Meteo archive, ERA5) le long d'une sortie,
 * converti en vent de face à hauteur de cycliste. Mis en cache dans .cache/.
 *
 * Diagnostic uniquement : mesurer la part de l'écart journalier due au vent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { haversineM, type Ride } from './rides';

const CACHE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '.cache');
const SAMPLE_EVERY_M = 12_000;
/** Vent à 10 m → hauteur de cycliste (~1,3 m, loi logarithmique, z0 ≈ 0,1 m). */
export const HEIGHT_FACTOR = 0.6;

interface WindSample { d: number; lat: number; lon: number; times: number[]; speedMs: number[]; dirFromDeg: number[] }

async function fetchSamples(ride: Ride): Promise<WindSample[]> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `wind-${ride.id}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  const pts: { d: number; lat: number; lon: number }[] = [];
  for (let d = 0; d <= ride.distanceM; d += SAMPLE_EVERY_M) {
    const p = ride.track.find((t) => t.d >= d) ?? ride.track[ride.track.length - 1]!;
    pts.push({ d: p.d, lat: p.lat, lon: p.lon });
  }
  const last = ride.track[ride.track.length - 1]!;
  pts.push({ d: last.d, lat: last.lat, lon: last.lon });
  const day = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);
  const start = day(ride.startEpoch);
  const end = day(ride.track[ride.track.length - 1]!.epoch);
  const url = 'https://archive-api.open-meteo.com/v1/archive?'
    + `latitude=${pts.map((p) => p.lat.toFixed(4)).join(',')}&longitude=${pts.map((p) => p.lon.toFixed(4)).join(',')}`
    + `&start_date=${start}&end_date=${end}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=GMT`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : [json];
  const samples: WindSample[] = list.map((loc: any, i: number) => ({
    ...pts[i]!,
    times: (loc.hourly.time as string[]).map((t) => Date.parse(`${t}:00Z`) / 1000),
    speedMs: loc.hourly.wind_speed_10m,
    dirFromDeg: loc.hourly.wind_direction_10m,
  }));
  fs.writeFileSync(cacheFile, JSON.stringify(samples));
  return samples;
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/** Vent de face (m/s, à hauteur de cycliste) pour chaque point de la trace. */
export async function headwindAlongRide(ride: Ride, heightFactor = HEIGHT_FACTOR): Promise<Float64Array> {
  const samples = await fetchSamples(ride);
  const tr = ride.track;
  const out = new Float64Array(tr.length);
  let back = 0;
  let fwd = 0;
  for (let i = 0; i < tr.length; i++) {
    const p = tr[i]!;
    while (back < i && p.d - tr[back]!.d > 40) back++;
    while (fwd < tr.length - 1 && tr[fwd]!.d - p.d < 40) fwd++;
    const a = tr[back]!;
    const b = tr[Math.max(fwd, i)]!;
    if (haversineM(a.lat, a.lon, b.lat, b.lon) < 5) { out[i] = i > 0 ? out[i - 1]! : 0; continue; }
    const heading = bearingDeg(a.lat, a.lon, b.lat, b.lon);
    // Échantillon le plus proche le long de la trace, interpolation horaire.
    let s = samples[0]!;
    for (const c of samples) if (Math.abs(c.d - p.d) < Math.abs(s.d - p.d)) s = c;
    let h = s.times.findIndex((t) => t > p.epoch);
    if (h <= 0) h = Math.max(1, Math.min(s.times.length - 1, h < 0 ? s.times.length - 1 : 1));
    const t0 = s.times[h - 1]!;
    const t1 = s.times[h]!;
    const f = Math.min(1, Math.max(0, (p.epoch - t0) / (t1 - t0)));
    // Interpolation vectorielle (évite les sauts de direction 359° → 1°).
    const toVec = (spd: number, dir: number) => [spd * Math.sin((dir * Math.PI) / 180), spd * Math.cos((dir * Math.PI) / 180)];
    const [u0, v0] = toVec(s.speedMs[h - 1]!, s.dirFromDeg[h - 1]!);
    const [u1, v1] = toVec(s.speedMs[h]!, s.dirFromDeg[h]!);
    const u = u0! + f * (u1! - u0!);
    const v = v0! + f * (v1! - v0!);
    const hr = (heading * Math.PI) / 180;
    // (u, v) pointe vers la provenance du vent : composante dans l'axe de marche = vent de face.
    out[i] = heightFactor * (u * Math.sin(hr) + v * Math.cos(hr));
  }
  return out;
}
