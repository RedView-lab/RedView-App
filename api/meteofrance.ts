/**
 * Proxy → API WCS de Météo-France (snow_depth d'AROME).
 *
 * Pourquoi côté serveur (plutôt qu'une requête du navigateur) ?
 *   1. Le WCS de Météo-France renvoie du GRIB2 — un format scientifique
 *      binaire très lourd à analyser dans le navigateur (compression CCSDS /
 *      gabarit 5.42).
 *   2. La clé d'API JWT ne doit pas être exposée au client.
 *
 * C'est EXACTEMENT la même logique que celle de RedView v0.1
 *   crates/redview-io/src/remote/arome_client/{api,parser,auth,mod}.rs
 * mais portée sous Node + l'analyseur GRIB2 Rust @mattnucc/gribberish (même
 * famille de crates `grib` que celle utilisée par la v0.1).
 *
 * Pipeline :
 *   1. WCS GetCapabilities → liste les dernières couvertures SNOW_DEPTH
 *   2. WCS DescribeCoverage → premier pas de temps (analyse = 0 s)
 *   3. WCS GetCoverage(time, bbox) → octets GRIB2 (un seul champ 2D)
 *   4. gribberish analyse le GRIB2 → valeurs + tableaux lat / lon
 *   5. Conversion en cm, réponse JSON
 *
 * Point d'accès :
 *   GET /api/meteofrance?lonMin=...&latMin=...&lonMax=...&latMax=...
 *
 * Variable d'environnement serveur (obligatoire, la route répond 500 sans elle) :
 *   METEOFRANCE_API_KEY=<JWT>
 */
import type { ApiRequest, ApiResponse } from './_lib/types.js';
import { GribMessageFactory, parseMessagesFromBuffer } from '@mattnucc/gribberish';
import { createByteLru } from '../server/lib/byte-lru.mjs';

// ────────────────────────────── Constants ──────────────────────────────

const AROME_API_BASE = 'https://public-api.meteofrance.fr/public/arome/1.0';
const WCS_SERVICE = 'MF-NWP-HIGHRES-AROME-001-FRANCE-WCS';
const SNOW_COVERAGE_PREFIX = 'SNOW_DEPTH__GROUND_OR_WATER_SURFACE___';

const FETCH_TIMEOUT_MS = 25_000;

// ────────────────────────────── Aides HTTP ──────────────────────────────

function getToken(): string {
  const env = (process.env.METEOFRANCE_API_KEY ?? '').trim();
  if (!env) {
    throw new Error('Missing required environment variable: METEOFRANCE_API_KEY');
  }
  return env;
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
      // Corps amont logué côté serveur uniquement, jamais propagé au client.
      const body = await res.text().catch(() => '');
      console.warn(`[meteofrance] upstream HTTP ${res.status}:`, body.slice(0, 300));
      throw new Error(`Météo-France HTTP ${res.status}`);
    }
    return asText ? await res.text() : new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────── Déroulé WCS ──────────────────────────────

/** Récupère le dernier CoverageId qui commence par le préfixe SNOW_DEPTH. */
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
  return ids[ids.length - 1]; // dernier run
}

/** Premier pas de temps de DescribeCoverage (analyse = 0 s). */
async function findFirstTimeStep(coverageId: string): Promise<string> {
  const url =
    `${AROME_API_BASE}/wcs/${WCS_SERVICE}/DescribeCoverage` +
    `?service=WCS&version=2.0.1&coverageID=${encodeURIComponent(coverageId)}`;
  const xml = (await fetchWithApikey(url, '*/*', true)) as string;

  // Cherche les coefficients de l'axe du temps
  const timeBlock = /gridAxesSpanned>\s*time\s*<[\s\S]*?<gmlrgrid:coefficients>([^<]+)<\/gmlrgrid:coefficients>/.exec(
    xml,
  );
  if (timeBlock) {
    const first = timeBlock[1].trim().split(/\s+/)[0];
    if (first) return first;
  }
  // Repli : position de début ISO
  const begin = /<gml:beginPosition[^>]*>([^<]+)</.exec(xml);
  if (begin) return begin[1].trim();
  return '0';
}

/**
 * Dernier run AROME et son pas d'analyse, gardés 10 min (un nouveau run sort
 * toutes les quelques heures) : sans ce cache, chaque grille non cachée
 * coûtait trois appels au quota de la clé Météo-France au lieu d'un. Un
 * échec n'est pas gardé ; les demandes simultanées partagent la même.
 */
const LATEST_RUN_TTL_MS = 10 * 60 * 1000;
let latestRun: { at: number; run: Promise<{ coverageId: string; timeValue: string }> } | null = null;

function resolveLatestRun(): Promise<{ coverageId: string; timeValue: string }> {
  const now = Date.now();
  if (latestRun && now - latestRun.at < LATEST_RUN_TTL_MS) return latestRun.run;
  const run = (async () => {
    const coverageId = await findSnowCoverage();
    return { coverageId, timeValue: await findFirstTimeStep(coverageId) };
  })();
  const entry = { at: now, run };
  latestRun = entry;
  run.catch(() => {
    if (latestRun === entry) latestRun = null;
  });
  return run;
}

/** Heure du run d'après le CoverageId : ...___2026-04-23T06.00.00Z → "06". */
function extractRunHour(coverageId: string): string {
  const t = coverageId.lastIndexOf('T');
  return t >= 0 && coverageId.length >= t + 3
    ? coverageId.slice(t + 1, t + 3)
    : '00';
}

/** GetCoverage → octets GRIB2 d'un sous-ensemble bbox à l'instant choisi. */
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
  /** hauteur de neige en cm, ligne par ligne du sud vers le nord */
  valuesCm: number[];
  /** emprise WGS84 englobant les points de la grille */
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
  // Préfère une réponse WCS à message unique, sinon cherche une abréviation liée à la neige.
  try {
    const factory = GribMessageFactory.fromBuffer(buf);
    const keys = factory.availableMessages;
    if (keys.length === 1) return factory.getMessage(keys[0]);
    // Note chacun : SD (hauteur de neige, m) > SDWE (équivalent en eau) > tout ce qui touche à la neige
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
    // Repli : premier message
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
  // Hauteur de neige en mètres
  if (u === 'm' || ab === 'SD') return 100;
  // SWE en kg/m² (mm d'équivalent en eau) → masse volumique de la neige supposée ~300 kg/m³
  if (u.includes('kg') || ab === 'SDWE') return 1 / 3;
  // Par défaut : mètres supposés (standard AROME)
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

  // gribberish.latlng renvoie des tableaux d'axe 1D pour les grilles régulières :
  //   latitude.length  == lignes   (une entrée par ligne, nord→sud ou sud→nord)
  //   longitude.length == colonnes (une entrée par colonne, ouest→est en général)
  // Pour les grilles non régulières, il peut renvoyer un tableau à plat par
  // cellule de longueur lignes*colonnes.
  const latArr = ll.latitude;
  const lonArr = ll.longitude;
  const latIsAxis = latArr.length === height;
  const lonIsAxis = lonArr.length === width;
  const latIsFlat = latArr.length === width * height;
  const lonIsFlat = lonArr.length === width * height;
  if (!(latIsAxis || latIsFlat) || !(lonIsAxis || lonIsFlat)) {
    throw new Error(
      `GRIB latlng unexpected shape: lat=${latArr.length} lon=${lonArr.length} ` +
        `vs grid ${width}×${height}`,
    );
  }

  const factor = unitFactorToCm(msg.units, msg.varAbbrev);

  // Détecte le sens de balayage (nord→sud est le défaut d'AROME — la première ligne est au nord).
  const latFirstRow = latIsAxis ? latArr[0] : latArr[0];
  const latLastRow = latIsAxis ? latArr[height - 1] : latArr[(height - 1) * width];
  const scanNorthSouth = latFirstRow > latLastRow;

  const valuesCm: number[] = new Array(width * height);
  for (let j = 0; j < height; j++) {
    // La ligne de sortie j doit aller du sud au nord (j=0 = la plus au sud).
    const srcRow = scanNorthSouth ? height - 1 - j : j;
    for (let i = 0; i < width; i++) {
      const v = data[srcRow * width + i];
      const cm = !Number.isFinite(v) || v < 0 ? 0 : Math.min(v * factor, 2000);
      valuesCm[j * width + i] = cm;
    }
  }

  // Emprise d'après latlng (gère les dispositions en axes et à plat)
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (let k = 0; k < latArr.length; k++) {
    const lat = latArr[k];
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  for (let k = 0; k < lonArr.length; k++) {
    let lon = lonArr[k];
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
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

// ────────────────────────────── Cache LRU ──────────────────────────────

/**
 * L'app demande ±0,4° × ±0,3° autour de la scène (`snow/lib/sources/arome.ts`) ;
 * 2° laissent de la marge. À 15°, une seule requête faisait décoder 2,25 M
 * cellules GRIB et sérialiser ~20 Mo de JSON sur le fil principal.
 */
const MAX_BBOX_SPAN_DEG = 2;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// Réponse JSON déjà sérialisée, bornée en octets : une grille de 15° × 15° à
// 0,01° pèse plusieurs Mo (64 grilles en `number[]` pouvaient dépasser 450 Mo).
const gridCache = createByteLru<string>({
  maxBytes: 32 * 1024 * 1024,
  sizeOf: (json) => json.length,
  ttlMs: CACHE_TTL_MS,
});

/** Grilles en cours de calcul : deux scènes voisines au même moment font un seul appel amont. */
const inflightGrids = new Map<string, Promise<string>>();

async function computeGridJson(lonMin: number, latMin: number, lonMax: number, latMax: number): Promise<string> {
  const t0 = Date.now();
  const { coverageId, timeValue } = await resolveLatestRun();
  const gribBytes = await downloadCoverage(coverageId, timeValue, lonMin, latMin, lonMax, latMax);
  const grid = parseGribToGrid(gribBytes, coverageId);
  const json = JSON.stringify(grid);
  // Jamais l'emprise : c'est la position de la scène de l'utilisateur.
  console.log(
    `[meteofrance] ${coverageId} time=${timeValue} ` +
      `→ ${grid.width}×${grid.height} unit=${grid.units} factor=${grid.unitToCm} ${Date.now() - t0}ms`,
  );
  return json;
}

// ────────────────────────────── Handler ──────────────────────────────

class BadRequestError extends Error {}

/** Clé absente (facultative, .env.example) : signalée une fois, pas à chaque requête. */
let missingKeyReported = false;

function parseFloatStrict(v: unknown, name: string): number {
  const n = typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) throw new BadRequestError(`Missing/invalid query param: ${name}`);
  return n;
}

/** Arrondi « vers l'extérieur » au centième de degré (la bbox ne rétrécit jamais). */
function snapOutward(value: number, direction: 'down' | 'up'): number {
  const scaled = value * 100;
  const snapped = direction === 'down' ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  return snapped / 100;
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

  let lonMin: number;
  let latMin: number;
  let lonMax: number;
  let latMax: number;
  try {
    // bbox arrondie au centième (vers l'extérieur) : clé de cache stable et
    // requête amont identique pour toutes les bbox voisines.
    lonMin = snapOutward(parseFloatStrict(req.query.lonMin, 'lonMin'), 'down');
    latMin = snapOutward(parseFloatStrict(req.query.latMin, 'latMin'), 'down');
    lonMax = snapOutward(parseFloatStrict(req.query.lonMax, 'lonMax'), 'up');
    latMax = snapOutward(parseFloatStrict(req.query.latMax, 'latMax'), 'up');

    if (latMin < -90 || latMax > 90 || lonMin < -180 || lonMax > 180) {
      throw new BadRequestError('Invalid bbox: out of range');
    }
    if (lonMax <= lonMin || latMax <= latMin) {
      throw new BadRequestError('Invalid bbox: max must be > min');
    }
    if (lonMax - lonMin > MAX_BBOX_SPAN_DEG || latMax - latMin > MAX_BBOX_SPAN_DEG) {
      throw new BadRequestError(`Invalid bbox: span must be ≤ ${MAX_BBOX_SPAN_DEG}°`);
    }
  } catch (err) {
    const message = err instanceof BadRequestError ? err.message : 'Invalid bbox';
    return res.status(400).json({ error: message });
  }

  if (!(process.env.METEOFRANCE_API_KEY ?? '').trim()) {
    if (!missingKeyReported) {
      missingKeyReported = true;
      console.warn('[meteofrance] METEOFRANCE_API_KEY absente : pas d’analyse AROME (le mode neige prend son repli)');
    }
    return res.status(503).json({ error: 'Météo-France source not configured' });
  }

  const cacheKey = [lonMin, latMin, lonMax, latMax].map((v) => v.toFixed(2)).join(',');
  const cachedJson = gridCache.get(cacheKey);
  if (cachedJson) {
    res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Snow-Source', 'meteofrance-wcs');
    res.setHeader('X-Snow-Cache', 'HIT');
    return res.status(200).send(cachedJson);
  }

  try {
    let pending = inflightGrids.get(cacheKey);
    if (!pending) {
      pending = computeGridJson(lonMin, latMin, lonMax, latMax).then((json) => {
        gridCache.set(cacheKey, json);
        return json;
      });
      const entry = pending;
      inflightGrids.set(cacheKey, entry);
      void entry.catch(() => undefined).finally(() => {
        if (inflightGrids.get(cacheKey) === entry) inflightGrids.delete(cacheKey);
      });
    }
    const json = await pending;

    res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Snow-Source', 'meteofrance-wcs');
    return res.status(200).send(json);
  } catch (err) {
    console.error('[meteofrance] failure:', err);
    return res.status(502).json({ error: 'Météo-France WCS fetch failed' });
  }
}
