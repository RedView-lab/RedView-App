/**
 * Vercel serverless proxy → Météo-France WCS API (AROME snow_depth).
 *
 * Why a serverless function (vs. browser fetch)?
 *   1. The Météo-France WCS endpoint returns GRIB2 — a binary scientific
 *      format that's very heavy to parse in the browser (CCSDS / template
 *      5.42 compression).
 *   2. The JWT API key shouldn't be exposed to the client.
 *
 * This is the EXACT same logic as RedView v0.1's
 *   crates/redview-io/src/remote/arome_client/{api,parser,auth,mod}.rs
 * but ported to Node + the @mattnucc/gribberish Rust GRIB2 parser
 * (same `grib` crate family v0.1 used).
 *
 * Pipeline:
 *   1. WCS GetCapabilities → list latest SNOW_DEPTH coverages
 *   2. WCS DescribeCoverage → first time step (analysis = 0s)
 *   3. WCS GetCoverage(time, bbox) → GRIB2 bytes (single 2D field)
 *   4. gribberish parses GRIB2 → values + lat/lon arrays
 *   5. Convert to cm, return JSON
 *
 * Endpoint:
 *   GET /api/meteofrance?lonMin=...&latMin=...&lonMax=...&latMax=...
 *
 * Env var (optional, falls back to v0.1 embedded beta token):
 *   METEOFRANCE_API_KEY=<JWT>
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GribMessageFactory, parseMessagesFromBuffer } from '@mattnucc/gribberish';

// ────────────────────────────── Constants ──────────────────────────────

const AROME_API_BASE = 'https://public-api.meteofrance.fr/public/arome/1.0';
const WCS_SERVICE = 'MF-NWP-HIGHRES-AROME-001-FRANCE-WCS';
const SNOW_COVERAGE_PREFIX = 'SNOW_DEPTH__GROUND_OR_WATER_SURFACE___';

const FETCH_TIMEOUT_MS = 25_000;

/**
 * Fallback JWT API key embedded in v0.1 (distribution bêta).
 * Expiry: 2027-04-09 (exp claim in payload).
 * Override with env METEOFRANCE_API_KEY if needed.
 */
const EMBEDDED_BETA_TOKEN =
  'eyJ4NXQiOiJZV0kxTTJZNE1qWTNOemsyTkRZeU5XTTRPV014TXpjek1UVmhNbU14T1RSa09ETXlOVEE0Tnc9PSIsImtpZCI6ImdhdGV3YXlfY2VydGlmaWNhdGVfYWxpYXMiLCJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJTaW1vbkxlU2ltb25AY2FyYm9uLnN1cGVyIiwiYXBwbGljYXRpb24iOnsib3duZXIiOiJTaW1vbkxlU2ltb24iLCJ0aWVyUXVvdGFUeXBlIjpudWxsLCJ0aWVyIjoiVW5saW1pdGVkIiwibmFtZSI6IkRlZmF1bHRBcHBsaWNhdGlvbiIsImlkIjozNzA1NCwidXVpZCI6IjNhZjgzOWE5LTVmZWMtNDM1NC1hODk2LWZiZDI0YmZmZWRhYiJ9LCJpc3MiOiJodHRwczpcL1wvcG9ydGFpbC1hcGkubWV0ZW9mcmFuY2UuZnI6NDQzXC9vYXV0aDJcL3Rva2VuIiwidGllckluZm8iOnsiNTBQZXJNaW4iOnsidGllclF1b3RhVHlwZSI6InJlcXVlc3RDb3VudCIsImdyYXBoUUxNYXhDb21wbGV4aXR5IjowLCJncmFwaFFMTWF4RGVwdGgiOjAsInN0b3BPblF1b3RhUmVhY2giOnRydWUsInNwaWtlQXJyZXN0TGltaXQiOjAsInNwaWtlQXJyZXN0VW5pdCI6InNlYyJ9fSwia2V5dHlwZSI6IlBST0RVQ1RJT04iLCJzdWJzY3JpYmVkQVBJcyI6W3sic3Vic2NyaWJlclRlbmFudERvbWFpbiI6ImNhcmJvbi5zdXBlciIsIm5hbWUiOiJBUk9NRSIsImNvbnRleHQiOiJcL3B1YmxpY1wvYXJvbWVcLzEuMCIsInB1Ymxpc2hlciI6ImFkbWluX21mIiwidmVyc2lvbiI6IjEuMCIsInN1YnNjcmlwdGlvblRpZXIiOiI1MFBlck1pbiJ9XSwiZXhwIjoxODAyNDY5NTYyLCJ0b2tlbl90eXBlIjoiYXBpS2V5IiwiaWF0IjoxNzcwOTMzNTYyLCJqdGkiOiI2MDkxYzc5YS0yNDQyLTRmNzMtYTQ4ZS1lODg3N2RmMmVkZjUifQ==.EJGvCWbmVQgr9I7w4VGZJcoT1V1Ge4FJn94D-xaqCHBUzmPi8DbP0JJ4UQUcMACKwCsYGbvw2yMAErwcoX9Lpfq_vO2jElcOm8LYdrriOcWDcRIoMghVPnNmtxN0AXlac7T-6uGK6BTFEKCOa6_DTXA6WUYrOYWvRrv1W9T5O5f6tWkurSSebvAYvZgp91K4KujXfuGBmU08NpfAu5ZIzaKG3ktATsv1qSO7d_td4h28tDfyDLsmc5XA8hxJWgoIqdcsjAETaQ-tYuX0RR5THjLGyU1z2RsjzLLcGbS7mmpEryKAMq6sYbcc963N1TekklfbLiiKDD9IyKQbxUOZqg==';

// ────────────────────────────── HTTP helpers ──────────────────────────────

function getToken(): string {
  const env = (process.env.METEOFRANCE_API_KEY ?? '').trim();
  return env || EMBEDDED_BETA_TOKEN;
}

async function fetchWithApikey(url: string, accept: string, asText: boolean) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { apikey: getToken(), Accept: accept },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Météo-France HTTP ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    return asText ? await res.text() : new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────── WCS workflow ──────────────────────────────

/** Pulls latest CoverageId starting with SNOW_DEPTH prefix. */
async function findSnowCoverage(): Promise<string> {
  const url =
    `${AROME_API_BASE}/wcs/${WCS_SERVICE}/GetCapabilities` +
    `?service=WCS&version=2.0.1&language=fre`;
  const xml = (await fetchWithApikey(url, '*/*', true)) as string;

  const ids: string[] = [];
  const re = /<(?:wcs:)?CoverageId>([^<]+)<\/(?:wcs:)?CoverageId>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1].startsWith(SNOW_COVERAGE_PREFIX)) ids.push(m[1]);
  }
  if (ids.length === 0) {
    throw new Error('No SNOW_DEPTH coverage found in WCS GetCapabilities');
  }
  ids.sort();
  return ids[ids.length - 1]; // latest run
}

/** First time step from DescribeCoverage (analysis = 0s). */
async function findFirstTimeStep(coverageId: string): Promise<string> {
  const url =
    `${AROME_API_BASE}/wcs/${WCS_SERVICE}/DescribeCoverage` +
    `?service=WCS&version=2.0.1&coverageID=${encodeURIComponent(coverageId)}`;
  const xml = (await fetchWithApikey(url, '*/*', true)) as string;

  // Look for time axis coefficients
  const timeBlock = /gridAxesSpanned>\s*time\s*<[\s\S]*?<gmlrgrid:coefficients>([^<]+)<\/gmlrgrid:coefficients>/.exec(
    xml,
  );
  if (timeBlock) {
    const first = timeBlock[1].trim().split(/\s+/)[0];
    if (first) return first;
  }
  // Fallback: ISO begin position
  const begin = /<gml:beginPosition[^>]*>([^<]+)</.exec(xml);
  if (begin) return begin[1].trim();
  return '0';
}

/** Run hour from CoverageId: ...___2026-04-23T06.00.00Z → "06". */
function extractRunHour(coverageId: string): string {
  const t = coverageId.lastIndexOf('T');
  return t >= 0 && coverageId.length >= t + 3
    ? coverageId.slice(t + 1, t + 3)
    : '00';
}

/** GetCoverage → GRIB2 bytes for a bbox subset at the chosen time. */
async function downloadCoverage(
  coverageId: string,
  timeValue: string,
  lonMin: number,
  latMin: number,
  lonMax: number,
  latMax: number,
): Promise<Uint8Array> {
  const fmt = (v: number) => v.toFixed(4);
  const url =
    `${AROME_API_BASE}/wcs/${WCS_SERVICE}/GetCoverage` +
    `?service=WCS&version=2.0.1` +
    `&coverageid=${encodeURIComponent(coverageId)}` +
    `&subset=time(${encodeURIComponent(timeValue)})` +
    `&subset=lat(${fmt(latMin)},${fmt(latMax)})` +
    `&subset=long(${fmt(lonMin)},${fmt(lonMax)})` +
    `&format=application/wmo-grib`;
  return (await fetchWithApikey(
    url,
    'application/octet-stream',
    false,
  )) as Uint8Array;
}

// ────────────────────────────── GRIB → JSON ──────────────────────────────

interface SnowGridJson {
  width: number;
  height: number;
  /** snow depth in cm, row-major south→north */
  valuesCm: number[];
  /** WGS84 enclosing bbox of the grid points */
  lonMin: number;
  latMin: number;
  lonMax: number;
  latMax: number;
  coverageId: string;
  runHour: string;
  timestamp: string;
  unitToCm: number;
  units: string;
  varAbbrev: string;
}

function pickSnowMessage(buf: Uint8Array) {
  // Prefer single-message WCS response, else scan for snow-related abbrev.
  try {
    const factory = GribMessageFactory.fromBuffer(buf);
    const keys = factory.availableMessages;
    if (keys.length === 1) return factory.getMessage(keys[0]);
    // Score each: SD (snow depth m) > SDWE (water equivalent) > anything snow
    let best: { msg: ReturnType<typeof factory.getMessage>; score: number } | null = null;
    for (const k of keys) {
      const msg = factory.getMessage(k);
      const ab = (msg.varAbbrev || '').toUpperCase();
      const nm = (msg.varName || '').toUpperCase();
      let s = 0;
      if (ab === 'SD') s = 200;
      else if (['SDWE', 'TSNOWP', 'SNOL'].includes(ab)) s = 80;
      else if (nm.includes('SNOW') || nm.includes('NEIGE')) s = 60;
      if (s > 0 && (!best || s > best.score)) best = { msg, score: s };
    }
    if (best) return best.msg;
    // Fallback: first message
    return factory.getMessage(keys[0]);
  } catch {
    const all = parseMessagesFromBuffer(buf);
    if (all.length === 0) throw new Error('GRIB2 has no parseable messages');
    return all[0];
  }
}

function unitFactorToCm(units: string, varAbbrev: string): number {
  const u = (units || '').toLowerCase();
  const ab = (varAbbrev || '').toUpperCase();
  // Snow depth in metres
  if (u === 'm' || ab === 'SD') return 100;
  // SWE in kg/m² (mm water equivalent) → assume snow density ~300 kg/m³
  if (u.includes('kg') || ab === 'SDWE') return 1 / 3;
  // Default: assume metres (AROME standard)
  return 100;
}

function parseGribToGrid(buf: Uint8Array, coverageId: string): SnowGridJson {
  const msg = pickSnowMessage(buf);
  const shape = msg.gridShape;
  const ll = msg.latlng;
  const data = msg.data;

  const width = shape.cols;
  const height = shape.rows;
  if (data.length !== width * height) {
    throw new Error(
      `GRIB grid mismatch: data=${data.length} vs ${width}×${height}=${width * height}`,
    );
  }
  if (ll.latitude.length !== width * height) {
    throw new Error(
      `GRIB latlng mismatch: lat=${ll.latitude.length} vs ${width * height}`,
    );
  }

  const factor = unitFactorToCm(msg.units, msg.varAbbrev);

  // Detect scan direction from corner coordinates.
  // gribberish always returns row-major in scan order; we want south→north.
  const latFirst = ll.latitude[0];
  const latLast = ll.latitude[(height - 1) * width];
  const scanNorthSouth = latFirst > latLast;

  const valuesCm: number[] = new Array(width * height);
  for (let j = 0; j < height; j++) {
    const srcRow = scanNorthSouth ? height - 1 - j : j; // flip if needed
    for (let i = 0; i < width; i++) {
      const v = data[srcRow * width + i];
      const cm = !Number.isFinite(v) || v < 0 ? 0 : Math.min(v * factor, 2000);
      valuesCm[j * width + i] = cm;
    }
  }

  // Bounding box from latlng arrays
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (let k = 0; k < ll.latitude.length; k++) {
    const lat = ll.latitude[k];
    let lon = ll.longitude[k];
    // Normalise lon to (-180, 180]
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
  }

  return {
    width,
    height,
    valuesCm,
    lonMin,
    latMin,
    lonMax,
    latMax,
    coverageId,
    runHour: extractRunHour(coverageId),
    timestamp: msg.referenceDate.toISOString(),
    unitToCm: factor,
    units: msg.units || '',
    varAbbrev: msg.varAbbrev || '',
  };
}

// ────────────────────────────── Handler ──────────────────────────────

function parseFloatStrict(v: unknown, name: string): number {
  const n = typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Missing/invalid query param: ${name}`);
  return n;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const lonMin = parseFloatStrict(req.query.lonMin, 'lonMin');
    const latMin = parseFloatStrict(req.query.latMin, 'latMin');
    const lonMax = parseFloatStrict(req.query.lonMax, 'lonMax');
    const latMax = parseFloatStrict(req.query.latMax, 'latMax');

    if (lonMax <= lonMin || latMax <= latMin) {
      throw new Error('Invalid bbox: max must be > min');
    }

    const t0 = Date.now();
    const coverageId = await findSnowCoverage();
    const timeValue = await findFirstTimeStep(coverageId);
    const gribBytes = await downloadCoverage(
      coverageId,
      timeValue,
      lonMin,
      latMin,
      lonMax,
      latMax,
    );
    const grid = parseGribToGrid(gribBytes, coverageId);
    const elapsed = Date.now() - t0;

    console.log(
      `[meteofrance] ${coverageId} time=${timeValue} ` +
        `bbox=[${lonMin.toFixed(3)},${latMin.toFixed(3)},${lonMax.toFixed(3)},${latMax.toFixed(3)}] ` +
        `→ ${grid.width}×${grid.height} unit=${grid.units} factor=${grid.unitToCm} ${elapsed}ms`,
    );

    res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=1800');
    res.setHeader('X-Snow-Source', 'meteofrance-wcs');
    return res.status(200).json(grid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[meteofrance] failure:', msg);
    return res.status(502).json({ error: 'Météo-France WCS fetch failed', detail: msg });
  }
}
