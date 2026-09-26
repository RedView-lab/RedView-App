const IGN_ALTIMETRY_ENDPOINT = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_ALTIMETRY_RESOURCE = 'ign_rge_alti_wld';
const IGN_ALTIMETRY_DELIMITER = '|';
const IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST = 5_000;
const IGN_ALTIMETRY_MIN_DELAY_MS = 200;
const IGN_ALTIMETRY_NODATA = -99_999;

const OPEN_METEO_ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const OPEN_METEO_MAX_POINTS_PER_REQUEST = 2_000;

export interface PointLike {
  lat: number;
  lon: number;
}

interface IgnElevationResponse {
  elevations?: number[];
}

interface OpenMeteoElevationResponse {
  elevation?: number[];
}

// In-memory cache to avoid duplicate network calls for coordinates already resolved.
// Key format: "lat:lon" quantized to ~1m precision (5 decimals).
const elevationMemoryCache = new Map<string, number>();
const MAX_CACHE_SIZE = 100_000;

function toCacheKey(lat: number, lon: number): string {
  return `${Math.round(lat * 1e5)}:${Math.round(lon * 1e5)}`;
}

function rememberElevation(lat: number, lon: number, ele: number): void {
  if (elevationMemoryCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest 20%
    const keysToDelete = Array.from(elevationMemoryCache.keys()).slice(0, 20_000);
    for (const key of keysToDelete) {
      elevationMemoryCache.delete(key);
    }
  }
  elevationMemoryCache.set(toCacheKey(lat, lon), ele);
}

function isInsideFranceLoose(lat: number, lon: number): boolean {
  return lon >= -5.6 && lon <= 10.0 && lat >= 41.0 && lat <= 51.6;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fetch 1m MNT (sol nu / bare-earth) from IGN Géoplateforme (RGE ALTI).
 */
async function requestIgnElevations(
  points: PointLike[],
  signal?: AbortSignal,
): Promise<Array<number | null>> {
  throwIfAborted(signal);
  if (points.length === 0) return [];

  const response = await fetch(IGN_ALTIMETRY_ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      lon: points.map((point) => point.lon).join(IGN_ALTIMETRY_DELIMITER),
      lat: points.map((point) => point.lat).join(IGN_ALTIMETRY_DELIMITER),
      resource: IGN_ALTIMETRY_RESOURCE,
      delimiter: IGN_ALTIMETRY_DELIMITER,
      indent: 'false',
      measures: 'false',
      zonly: 'true',
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `IGN altimetry HTTP ${response.status}${detail ? ` — ${detail.slice(0, 240)}` : ''}`,
    );
  }

  const payload = (await response.json()) as IgnElevationResponse;
  const elevations = Array.isArray(payload.elevations) ? payload.elevations : null;
  if (!elevations || elevations.length !== points.length) {
    throw new Error('IGN altimetry returned an unexpected elevation array length');
  }

  return elevations.map((elevation) => (
    Number.isFinite(elevation) && elevation > IGN_ALTIMETRY_NODATA
      ? elevation
      : null
  ));
}

/**
 * Fetch bare-earth MNT from Open-Meteo elevation API (Copernicus DEM 90m/30m global bare-earth).
 */
async function requestOpenMeteoElevations(
  points: PointLike[],
  signal?: AbortSignal,
): Promise<Array<number | null>> {
  throwIfAborted(signal);
  if (points.length === 0) return [];

  const response = await fetch(OPEN_METEO_ELEVATION_ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      latitude: points.map((p) => p.lat),
      longitude: points.map((p) => p.lon),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Open-Meteo elevation HTTP ${response.status}${detail ? ` — ${detail.slice(0, 240)}` : ''}`,
    );
  }

  const payload = (await response.json()) as OpenMeteoElevationResponse;
  const elevations = Array.isArray(payload.elevation) ? payload.elevation : null;
  if (!elevations || elevations.length !== points.length) {
    throw new Error('Open-Meteo elevation returned unexpected array length');
  }

  return elevations.map((elevation) => (
    Number.isFinite(elevation) && elevation > -500 && elevation < 9000
      ? elevation
      : null
  ));
}

/**
 * Sample true bare-earth terrain (MNT sol nu) elevations for points:
 * 1. France: IGN RGE ALTI (1m/5m MNT sol nu, stripped of buildings & forest)
 * 2. International / Outside France (or IGN fallback): Open-Meteo Elevation API (Copernicus bare-earth DEM)
 * 3. In-memory cache for ultra-fast repeated queries
 */
export async function sampleTerrainElevationsAtPoints(
  points: PointLike[],
  signal?: AbortSignal,
): Promise<Array<number | null>> {
  if (points.length === 0) return [];

  const results: Array<number | null> = new Array(points.length).fill(null);
  const uncachedIndices: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const key = toCacheKey(pt.lat, pt.lon);
    const cached = elevationMemoryCache.get(key);
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
    }
  }

  if (uncachedIndices.length === 0) {
    return results;
  }

  // Partition uncached points into France candidates vs International candidates
  const franceSubIndices: number[] = [];
  const internationalSubIndices: number[] = [];

  for (const idx of uncachedIndices) {
    const pt = points[idx];
    if (isInsideFranceLoose(pt.lat, pt.lon)) {
      franceSubIndices.push(idx);
    } else {
      internationalSubIndices.push(idx);
    }
  }

  // 1. Fetch France points via IGN RGE ALTI
  const ignFailedOrMissingIndices: number[] = [];
  if (franceSubIndices.length > 0) {
    for (let offset = 0; offset < franceSubIndices.length; offset += IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST) {
      throwIfAborted(signal);
      const batchIndices = franceSubIndices.slice(offset, offset + IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST);
      const batchPoints = batchIndices.map((i) => points[i]);

      try {
        const batchElevations = await requestIgnElevations(batchPoints, signal);
        for (let b = 0; b < batchIndices.length; b++) {
          const originalIdx = batchIndices[b];
          const ele = batchElevations[b];
          if (ele != null && Number.isFinite(ele)) {
            results[originalIdx] = ele;
            rememberElevation(points[originalIdx].lat, points[originalIdx].lon, ele);
          } else {
            ignFailedOrMissingIndices.push(originalIdx);
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') throw err;
        console.warn('[IGN Altimetry] Batch query failed, falling back to international MNT:', err);
        ignFailedOrMissingIndices.push(...batchIndices);
      }

      if (offset + IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST < franceSubIndices.length) {
        await delay(IGN_ALTIMETRY_MIN_DELAY_MS, signal);
      }
    }
  }

  // 2. Fetch International points + any IGN missing/failed points via Open-Meteo Elevation
  const needInternational = [...internationalSubIndices, ...ignFailedOrMissingIndices];
  if (needInternational.length > 0) {
    for (let offset = 0; offset < needInternational.length; offset += OPEN_METEO_MAX_POINTS_PER_REQUEST) {
      throwIfAborted(signal);
      const batchIndices = needInternational.slice(offset, offset + OPEN_METEO_MAX_POINTS_PER_REQUEST);
      const batchPoints = batchIndices.map((i) => points[i]);

      try {
        const batchElevations = await requestOpenMeteoElevations(batchPoints, signal);
        for (let b = 0; b < batchIndices.length; b++) {
          const originalIdx = batchIndices[b];
          const ele = batchElevations[b];
          if (ele != null && Number.isFinite(ele)) {
            results[originalIdx] = ele;
            rememberElevation(points[originalIdx].lat, points[originalIdx].lon, ele);
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') throw err;
        console.warn('[Open-Meteo Elevation] Batch query failed:', err);
      }

      if (offset + OPEN_METEO_MAX_POINTS_PER_REQUEST < needInternational.length) {
        await delay(IGN_ALTIMETRY_MIN_DELAY_MS, signal);
      }
    }
  }

  return results;
}