const IGN_ALTIMETRY_ENDPOINT = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_ALTIMETRY_RESOURCE = 'ign_rge_alti_wld';
const IGN_ALTIMETRY_DELIMITER = '|';
const IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST = 5_000;
const IGN_ALTIMETRY_MIN_DELAY_MS = 200;
const IGN_ALTIMETRY_NODATA = -99_999;


export interface PointLike {
  lat: number;
  lon: number;
}

interface IgnElevationResponse {
  elevations?: number[];
}

// Cache en mémoire pour éviter les appels réseau en double pour des coordonnées déjà résolues.
// Format de clé : « lat:lon » quantifié à ~1 m de précision (5 décimales).
const elevationMemoryCache = new Map<string, number>();
const MAX_CACHE_SIZE = 100_000;

function toCacheKey(lat: number, lon: number): string {
  return `${Math.round(lat * 1e5)}:${Math.round(lon * 1e5)}`;
}

function rememberElevation(lat: number, lon: number, ele: number): void {
  if (elevationMemoryCache.size >= MAX_CACHE_SIZE) {
    // Évincer les 20 % les plus anciens
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
 * Récupère le MNT à 1 m (sol nu) de la Géoplateforme IGN (RGE ALTI).
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
 * Échantillonne les vraies altitudes du terrain sol nu (MNT) pour des points :
 * 1. France : IGN RGE ALTI (MNT sol nu à 1 m/5 m, sans bâtiments ni forêt)
 * 2. Hors de France (ou échec de l'IGN) : tuiles AWS Terrarium à z12 (~27 m à
 *    45°N, SRTM / EU-DEM), décodées dans le navigateur — au-delà de 400 tuiles,
 *    les points restants gardent leur altitude GPX / BRouter
 * 3. Cache en mémoire pour des requêtes répétées ultra-rapides
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

  // Répartir les points hors cache entre candidats France et candidats internationaux
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

  // 1. Points de France via l'IGN RGE ALTI
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

  // 2. Points hors de France + échecs de l'IGN : tuiles Terrarium
  const needInternational = [...internationalSubIndices, ...ignFailedOrMissingIndices];
  if (needInternational.length > 0) {
    throwIfAborted(signal);
    // Chargé à la demande : hors du chemin critique de l'app (tracés en France = IGN seul).
    const { sampleTerrariumElevations } = await import('@/shared/lib/terrarium');
    const elevations = await sampleTerrariumElevations(needInternational.map((i) => points[i]), { signal });
    elevations.forEach((ele, k) => {
      if (ele == null) return;
      const originalIdx = needInternational[k];
      results[originalIdx] = ele;
      rememberElevation(points[originalIdx].lat, points[originalIdx].lon, ele);
    });
  }

  return results;
}