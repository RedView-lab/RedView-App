const IGN_ALTIMETRY_ENDPOINT = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_ALTIMETRY_RESOURCE = 'ign_rge_alti_wld';
const IGN_ALTIMETRY_DELIMITER = '|';
const IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST = 5_000;
const IGN_ALTIMETRY_MIN_DELAY_MS = 220;
const IGN_ALTIMETRY_NODATA = -99_999;

interface PointLike {
  lat: number;
  lon: number;
}

interface IgnElevationResponse {
  elevations?: number[];
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

async function requestIgnElevations(
  points: PointLike[],
  signal?: AbortSignal,
): Promise<Array<number | null>> {
  throwIfAborted(signal);

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

  const payload = await response.json() as IgnElevationResponse;
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

export async function sampleTerrainElevationsAtPoints(
  points: PointLike[],
  signal?: AbortSignal,
): Promise<Array<number | null>> {
  if (points.length === 0) return [];

  const out: Array<number | null> = [];
  for (let offset = 0; offset < points.length; offset += IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST) {
    throwIfAborted(signal);
    const batch = points.slice(offset, offset + IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST);
    const batchElevations = await requestIgnElevations(batch, signal);
    out.push(...batchElevations);
    if (offset + IGN_ALTIMETRY_MAX_POINTS_PER_REQUEST < points.length) {
      await delay(IGN_ALTIMETRY_MIN_DELAY_MS, signal);
    }
  }

  return out;
}