/**
 * Snow context around a scene, for the snow engine (features/snow):
 *   - measured snow depths of flat-field stations:
 *       · SLF IMIS (Switzerland, open, 30 min, last 24 h): measurement-api.slf.ch
 *       · Météo-France climatological hourly data (open, updated every morning
 *         with the night's values): NEIGETOT of every station of the
 *         départements around the scene (meteo.data.gouv.fr, per-département
 *         "latest" files, streamed and cached)
 *   - the snow cover block of the Météo-France avalanche bulletin (BRA) of the
 *     massif holding the scene (DPBRA API, needs METEOFRANCE_API_KEY with the
 *     BRA API subscribed): depth on north/south slopes at 3 altitudes and the
 *     continuous snow cover limits;
 *   - the hourly weather of the past weeks (self-hosted Open-Meteo on the VPS,
 *     Météo-France models: temperature at the scene altitude, precipitation,
 *     snowfall, 10 m wind) for melt and drift.
 * Every part is optional: a failing source is reported in `sources`, never
 * fatal.
 *
 * GET /api/snow-context?lat=..&lon=..&elevation=..&radiusKm=50&pastDays=60
 */
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import type { ApiRequest, ApiResponse } from './_lib/types.js';
import { OPENMETEO_DEFAULT_MODEL, OPENMETEO_MAX_HISTORY_DAYS, openMeteoUpstream } from './_lib/openMeteo.js';
import { BRA_MASSIFS } from './_lib/snow/braMassifs.js';
import { createOldestKeyTaker } from '../server/lib/oldest-key.mjs';

const FETCH_TIMEOUT_MS = 20_000;
const MF_PARSE_BUDGET_MS = 45_000;
const HOUR_MS = 3_600_000;

type SourceState = 'ok' | 'empty' | 'error' | 'skipped' | 'unavailable' | 'pending' | 'off-season';

interface StationOut {
  id: string;
  source: 'slf-imis' | 'meteofrance';
  name: string;
  lon: number;
  lat: number;
  elevationM: number;
  hsCm: number;
  time: string;
}

// ────────────────────────────── helpers ──────────────────────────────

class BadRequestError extends Error {}

function num(v: unknown, name: string, min: number, max: number, fallback?: number): number {
  const raw = Array.isArray(v) ? v[0] : v;
  if ((raw === undefined || raw === '') && fallback !== undefined) return fallback;
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestError(`Missing/invalid query param: ${name}`);
  return n;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Tiny TTL cache that also shares in-flight promises. */
class TtlCache<T> {
  private readonly map = new Map<string, { value: Promise<T>; expiresAt: number }>();
  private readonly takeOldestKey = createOldestKeyTaker(this.map);
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries: number) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    while (this.map.size >= this.maxEntries) {
      const oldest = this.takeOldestKey();
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    const value = load();
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    // A failure is not cached.
    value.catch(() => { if (this.map.get(key)?.value === value) this.map.delete(key); });
    return value;
  }
}

// ────────────────────────────── SLF IMIS ──────────────────────────────

const SLF_BASE = 'https://measurement-api.slf.ch/public/api/imis';

interface SlfStation { code: string; label: string; lon: number; lat: number; elevation: number; type: string }
interface SlfMeasurement { station_code: string; measure_date: string; HS: number | null }

const slfStationsCache = new TtlCache<SlfStation[]>(24 * HOUR_MS, 1);
const slfMeasurementsCache = new TtlCache<SlfMeasurement[]>(20 * 60_000, 1);

function nearSwitzerland(lat: number, lon: number, radiusKm: number): boolean {
  const m = radiusKm / 100;
  return lat > 45.8 - m && lat < 47.85 + m && lon > 5.95 - m * 1.4 && lon < 10.5 + m * 1.4;
}

async function slfStations(lat: number, lon: number, radiusKm: number): Promise<StationOut[]> {
  const [stations, measurements] = await Promise.all([
    slfStationsCache.get('all', async () => {
      const res = await fetchWithTimeout(`${SLF_BASE}/stations`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`SLF stations HTTP ${res.status}`);
      return (await res.json()) as SlfStation[];
    }),
    slfMeasurementsCache.get('all', async () => {
      const res = await fetchWithTimeout(`${SLF_BASE}/measurements`, { headers: { Accept: 'application/json' } }, 30_000);
      if (!res.ok) throw new Error(`SLF measurements HTTP ${res.status}`);
      return (await res.json()) as SlfMeasurement[];
    }),
  ]);
  const near = new Map<string, SlfStation>();
  for (const s of stations) {
    // WIND stations sit on crests: their snow depth is not a flat-field value.
    if (s.type !== 'SNOW_FLAT') continue;
    if (haversineKm(lat, lon, s.lat, s.lon) <= radiusKm) near.set(s.code, s);
  }
  const latest = new Map<string, SlfMeasurement>();
  const minTime = Date.now() - 12 * HOUR_MS;
  for (const m of measurements) {
    if (!near.has(m.station_code) || m.HS == null || !Number.isFinite(m.HS)) continue;
    const t = Date.parse(m.measure_date);
    if (!(t >= minTime)) continue;
    const prev = latest.get(m.station_code);
    if (!prev || Date.parse(prev.measure_date) < t) latest.set(m.station_code, m);
  }
  const out: StationOut[] = [];
  for (const [code, m] of latest) {
    const s = near.get(code) as SlfStation;
    out.push({ id: `slf:${code}`, source: 'slf-imis', name: s.label, lon: s.lon, lat: s.lat, elevationM: s.elevation, hsCm: Math.max(0, m.HS as number), time: m.measure_date });
  }
  return out;
}

// ────────────────────── Météo-France open hourly data ──────────────────────

const MF_DATASET_API = 'https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-horaires/';
const GEO_API = 'https://geo.api.gouv.fr/communes';

interface MfStation { id: string; name: string; lat: number; lon: number; alt: number; date: string; hs: number }

const mfFilesCache = new TtlCache<Map<string, string>>(24 * HOUR_MS, 1);
const mfDeptCache = new TtlCache<MfStation[]>(3 * HOUR_MS, 24);
const deptLookupCache = new TtlCache<string | null>(30 * 24 * HOUR_MS, 2000);

/** Département file code of a point (Corsica is "20" in these files), null outside France. */
function departmentAt(lat: number, lon: number): Promise<string | null> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  return deptLookupCache.get(key, async () => {
    const res = await fetchWithTimeout(`${GEO_API}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&fields=codeDepartement&format=json`, { headers: { Accept: 'application/json' } }, 8000);
    if (!res.ok) throw new Error(`geo.api.gouv.fr HTTP ${res.status}`);
    const json = (await res.json()) as Array<{ codeDepartement?: string }>;
    const code = json[0]?.codeDepartement;
    if (!code) return null;
    return code === '2A' || code === '2B' ? '20' : code;
  });
}

function mfLatestFiles(): Promise<Map<string, string>> {
  return mfFilesCache.get('files', async () => {
    const res = await fetchWithTimeout(MF_DATASET_API, { headers: { Accept: 'application/json' } }, 30_000);
    if (!res.ok) throw new Error(`data.gouv HTTP ${res.status}`);
    const json = (await res.json()) as { resources?: Array<{ url?: string }> };
    const files = new Map<string, string>();
    for (const r of json.resources ?? []) {
      const m = /\/H_([0-9AB]{2,3})_latest-[0-9]{4}-[0-9]{4}\.csv\.gz$/.exec(r.url ?? '');
      if (m && r.url) files.set(m[1], r.url);
    }
    if (files.size === 0) throw new Error('no latest hourly file listed');
    return files;
  });
}

/**
 * Latest NEIGETOT of every station of a département file (stations whose
 * last value is older than 48 h before the file's newest hour are dropped:
 * seasonal ski-resort posts stop reporting in spring).
 */
function mfDepartment(dept: string): Promise<MfStation[]> {
  return mfDeptCache.get(dept, async () => {
    const url = (await mfLatestFiles()).get(dept);
    if (!url) return [];
    const res = await fetchWithTimeout(url, {}, 60_000);
    if (!res.ok || !res.body) throw new Error(`Météo-France file HTTP ${res.status}`);
    const rl = createInterface({ input: Readable.fromWeb(res.body as never).pipe(createGunzip()), crlfDelay: Infinity });
    let idx: Record<string, number> | null = null;
    let newest = '';
    const latest = new Map<string, MfStation>();
    // ~200 columns per line, ~10⁶ lines per file: only the snow depth and the
    // date are read on every line, by walking the separators (no split).
    const field = (line: string, k: number): string => {
      let start = 0;
      for (let c = 0; c < k; c++) {
        start = line.indexOf(';', start) + 1;
        if (start === 0) return '';
      }
      const end = line.indexOf(';', start);
      return end < 0 ? line.slice(start) : line.slice(start, end);
    };
    for await (const line of rl) {
      if (!idx) {
        const header = line.split(';');
        idx = {};
        for (const k of ['NUM_POSTE', 'NOM_USUEL', 'LAT', 'LON', 'ALTI', 'AAAAMMJJHH', 'NEIGETOT']) idx[k] = header.indexOf(k);
        if (idx.NEIGETOT < 0 || idx.AAAAMMJJHH < 0) return [];
        continue;
      }
      const date = field(line, idx.AAAAMMJJHH);
      if (date > newest) newest = date;
      const v = field(line, idx.NEIGETOT);
      if (v === '') continue;
      const hs = Number(v);
      if (!Number.isFinite(hs)) continue;
      const f = line.split(';');
      const id = f[idx.NUM_POSTE];
      const prev = latest.get(id);
      if (!prev || prev.date < date) {
        latest.set(id, { id, name: f[idx.NOM_USUEL], lat: Number(f[idx.LAT]), lon: Number(f[idx.LON]), alt: Number(f[idx.ALTI]), date, hs });
      }
    }
    const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10));
    const minMs = newest.length === 10 ? toMs(newest) - 48 * HOUR_MS : 0;
    return [...latest.values()].filter((s) => s.date.length === 10 && toMs(s.date) >= minMs);
  });
}

async function meteoFranceStations(lat: number, lon: number, radiusKm: number): Promise<{ stations: StationOut[]; state: SourceState }> {
  // Départements of the centre and of 8 points on a circle around it.
  const r = Math.min(radiusKm, 40);
  const probes: Array<[number, number]> = [[lat, lon]];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    probes.push([lat + (r / 111) * Math.cos(a), lon + (r / (111 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a)]);
  }
  const depts = new Set<string>();
  const found = await Promise.allSettled(probes.map(([la, lo]) => departmentAt(la, lo)));
  for (const f of found) if (f.status === 'fulfilled' && f.value) depts.add(f.value);
  if (depts.size === 0) return { stations: [], state: 'skipped' };
  const loads = [...depts].map((d) => mfDepartment(d));
  const all = Promise.allSettled(loads);
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), MF_PARSE_BUDGET_MS));
  const done = await Promise.race([all, timeout]);
  if (done === 'timeout') return { stations: [], state: 'pending' };
  const stations: StationOut[] = [];
  let failures = 0;
  for (const res of done) {
    if (res.status === 'rejected') { failures++; continue; }
    for (const s of res.value) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || haversineKm(lat, lon, s.lat, s.lon) > radiusKm) continue;
      const d = s.date;
      stations.push({
        id: `mf:${s.id}`, source: 'meteofrance', name: s.name, lon: s.lon, lat: s.lat, elevationM: s.alt, hsCm: Math.max(0, s.hs),
        time: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(8, 10)}:00:00Z`,
      });
    }
  }
  return { stations, state: failures === done.length ? 'error' : stations.length ? 'ok' : 'empty' };
}

// ────────────────────────────── BRA ──────────────────────────────

interface BraOut {
  massif: string;
  date: string;
  levels: Array<{ altitudeM: number; northCm: number; southCm: number }>;
  limitNorthM: number | null;
  limitSouthM: number | null;
}

const braCache = new TtlCache<BraOut | null>(3 * HOUR_MS, 64);

function pointInRing(lon: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function massifAt(lat: number, lon: number): { id: number; name: string } | null {
  for (const m of BRA_MASSIFS) {
    let inside = false;
    for (const ring of m.rings) if (pointInRing(lon, lat, ring)) inside = !inside;
    if (inside) return { id: m.id, name: m.name };
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/** Snow cover block of a BRA XML: the most recent ENNEIGEMENT with its NIVEAU levels. */
export function parseBraEnneigement(xml: string, massifName: string): BraOut | null {
  const blocks = [...xml.matchAll(/<ENNEIGEMENT\b([^>]*)>([\s\S]*?)<\/ENNEIGEMENT>/g)];
  let best: { date: string; head: string; body: string } | null = null;
  for (const b of blocks) {
    const date = attr(b[1], 'DATE') ?? '';
    if (!best || date > best.date) best = { date, head: b[1], body: b[2] };
  }
  if (!best) return null;
  const levels: BraOut['levels'] = [];
  for (const n of best.body.matchAll(/<NIVEAU\b([^>]*)\/?>/g)) {
    const alt = Number(attr(n[1], 'ALTI'));
    const north = Number(attr(n[1], 'N'));
    const south = Number(attr(n[1], 'S'));
    if (Number.isFinite(alt) && Number.isFinite(north) && Number.isFinite(south)) levels.push({ altitudeM: alt, northCm: north, southCm: south });
  }
  const limit = (name: string) => {
    const v = attr(best!.head, name);
    const n = v == null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  if (levels.length === 0) return null;
  const bulletinDate = /DATEBULLETIN="([^"]+)"/.exec(xml)?.[1] ?? best.date;
  return { massif: massifName, date: bulletinDate, levels, limitNorthM: limit('LimiteNord'), limitSouthM: limit('LimiteSud') };
}

async function braFor(lat: number, lon: number): Promise<{ bra: BraOut | null; state: SourceState }> {
  const month = new Date().getUTCMonth();
  if (month >= 5 && month <= 9) return { bra: null, state: 'off-season' };
  const massif = massifAt(lat, lon);
  if (!massif) return { bra: null, state: 'skipped' };
  const key = (process.env.METEOFRANCE_API_KEY ?? '').trim();
  if (!key) return { bra: null, state: 'unavailable' };
  const bra = await braCache.get(String(massif.id), async () => {
    const url = `https://public-api.meteofrance.fr/public/DPBRA/v1/massif/BRA?id-massif=${massif.id}&format=xml`;
    const res = await fetchWithTimeout(url, { headers: { apikey: key, Accept: 'application/xml' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[snow-context] BRA HTTP ${res.status}:`, body.slice(0, 200));
      throw new Error(`BRA HTTP ${res.status}`);
    }
    return parseBraEnneigement(await res.text(), massif.name);
  });
  return { bra, state: bra ? 'ok' : 'empty' };
}

// ────────────────────────────── Open-Meteo ──────────────────────────────

interface WeatherOut {
  startMs: number;
  elevationM: number;
  temperatureC: number[];
  precipitationMm: number[];
  snowfallCm: number[];
  windSpeedMs: number[];
  windDirDeg: number[];
}

const weatherCache = new TtlCache<WeatherOut>(HOUR_MS, 128);

/** Open-Meteo auto-hébergé du VPS (api/_lib/openMeteo.ts), sans autre source. */
async function openMeteo(pathAndQuery: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${openMeteoUpstream()}${pathAndQuery}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

function cleanSeries(values: unknown, n: number, fallback: number): number[] {
  const arr = Array.isArray(values) ? values : [];
  const out = new Array<number>(n);
  let last = fallback;
  for (let i = 0; i < n; i++) {
    const v = Number(arr[i]);
    if (Number.isFinite(v)) last = v;
    out[i] = Number.isFinite(v) ? v : last;
  }
  return out;
}

function weatherHistory(lat: number, lon: number, elevation: number | null, pastDays: number): Promise<WeatherOut> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${elevation == null ? '' : Math.round(elevation / 100)},${pastDays}`;
  return weatherCache.get(key, async () => {
    const q = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      hourly: 'temperature_2m,precipitation,snowfall,wind_speed_10m,wind_direction_10m',
      past_days: String(pastDays),
      forecast_days: '1',
      models: OPENMETEO_DEFAULT_MODEL,
      wind_speed_unit: 'ms',
      timezone: 'GMT',
    });
    if (elevation != null) q.set('elevation', String(Math.round(elevation)));
    const json = (await openMeteo(`/v1/forecast?${q.toString()}`)) as { elevation?: number; hourly?: Record<string, unknown> };
    const times = Array.isArray(json.hourly?.time) ? (json.hourly?.time as string[]) : [];
    const now = Date.now();
    let n = 0;
    while (n < times.length && Date.parse(`${times[n]}Z`) <= now) n++;
    if (n < 48) throw new Error('weather history too short');
    return {
      startMs: Date.parse(`${times[0]}Z`),
      elevationM: Number.isFinite(json.elevation) ? (json.elevation as number) : (elevation ?? 0),
      temperatureC: cleanSeries(json.hourly?.temperature_2m, n, 0),
      precipitationMm: cleanSeries(json.hourly?.precipitation, n, 0),
      snowfallCm: cleanSeries(json.hourly?.snowfall, n, 0),
      windSpeedMs: cleanSeries(json.hourly?.wind_speed_10m, n, 0),
      windDirDeg: cleanSeries(json.hourly?.wind_direction_10m, n, 270),
    };
  });
}

// ────────────────────────────── handler ──────────────────────────────

/**
 * Buddy check (as the operational snow analyses): a station far from every
 * neighbour at a similar altitude is dropped — automatic snow-depth sensors
 * report grass, puddles or a parked snowcat as "snow".
 */
function buddyCheck(stations: StationOut[]): StationOut[] {
  return stations.filter((s) => {
    const buddies = stations.filter((o) => o !== s && haversineKm(s.lat, s.lon, o.lat, o.lon) < 25 && Math.abs(o.elevationM - s.elevationM) < 300);
    if (buddies.length < 2) return true;
    const sorted = buddies.map((b) => b.hsCm).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.abs(s.hsCm - median) <= Math.max(12, 0.5 * median);
  });
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let lat: number, lon: number, elevation: number | null, radiusKm: number, pastDays: number;
  try {
    lat = num(req.query.lat, 'lat', -90, 90);
    lon = num(req.query.lon, 'lon', -180, 180);
    const e = num(req.query.elevation, 'elevation', -500, 9000, Number.NaN);
    elevation = Number.isFinite(e) ? e : null;
    radiusKm = num(req.query.radiusKm, 'radiusKm', 5, 80, 50);
    pastDays = Math.round(num(req.query.pastDays, 'pastDays', 7, OPENMETEO_MAX_HISTORY_DAYS, OPENMETEO_MAX_HISTORY_DAYS));
  } catch (err) {
    return res.status(400).json({ error: err instanceof BadRequestError ? err.message : 'Invalid query' });
  }

  const sources: Record<string, SourceState> = {};
  const [slf, mf, bra, weather] = await Promise.allSettled([
    nearSwitzerland(lat, lon, radiusKm) ? slfStations(lat, lon, radiusKm) : Promise.resolve(null),
    meteoFranceStations(lat, lon, radiusKm),
    braFor(lat, lon),
    weatherHistory(lat, lon, elevation, pastDays),
  ]);

  let stations: StationOut[] = [];
  if (slf.status === 'fulfilled') {
    if (slf.value === null) sources.slf = 'skipped';
    else { stations = stations.concat(slf.value); sources.slf = slf.value.length ? 'ok' : 'empty'; }
  } else {
    sources.slf = 'error';
    console.warn('[snow-context] SLF:', slf.reason);
  }
  if (mf.status === 'fulfilled') {
    stations = stations.concat(mf.value.stations);
    sources.meteofrance = mf.value.state;
  } else {
    sources.meteofrance = 'error';
    console.warn('[snow-context] Météo-France:', mf.reason);
  }
  const checked = buddyCheck(stations);

  let braOut: BraOut | null = null;
  if (bra.status === 'fulfilled') { braOut = bra.value.bra; sources.bra = bra.value.state; }
  else { sources.bra = 'error'; console.warn('[snow-context] BRA:', bra.reason); }

  let weatherOut: WeatherOut | null = null;
  if (weather.status === 'fulfilled') { weatherOut = weather.value; sources.weather = 'ok'; }
  else { sources.weather = 'error'; console.warn('[snow-context] weather:', weather.reason); }


  res.setHeader('Cache-Control', 'private, max-age=600');
  return res.status(200).json({
    stations: checked,
    rejectedStations: stations.length - checked.length,
    bra: braOut,
    weather: weatherOut,
    sources,
  });
}
