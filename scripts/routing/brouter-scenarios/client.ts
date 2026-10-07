import { type Point, type RouteStats, UPSTREAM, WATCHDOG_RETRY_DELAYS_MS } from './config';
import { haversineKm } from './geometry';

// Client BRouter : envoi du profil BRF et calcul d'un itinéraire.

function formatError(error: unknown): string {
  const err = error as { message?: string; cause?: { code?: string; message?: string } };
  const message = err?.message ?? String(error);
  const cause = err?.cause?.code ?? err?.cause?.message;
  return cause ? `${message} (${cause})` : message;
}

function isWatchdogMessage(message: string): boolean {
  return /thread-priority-watchdog/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function uploadProfile(brf: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${UPSTREAM}/brouter/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: brf,
    });
  } catch (error) {
    throw new Error(`profile upload failed: ${formatError(error)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { profileid?: string; error?: string };
  if (json.error) throw new Error(`profile compile error: ${json.error}`);
  if (!json.profileid) throw new Error(`no profileid in response: ${text}`);
  return json.profileid;
}

export async function fetchRoute(
  profile: string,
  from: Point,
  to: Point,
  via: Point[] = [],
  alternativeIdx = 0,
): Promise<RouteStats> {
  const segs = [from, ...via, to]
    .map((p) => `${p.lon},${p.lat}`)
    .join('|');
  const url = `${UPSTREAM}/brouter?lonlats=${segs}&profile=${profile}&format=geojson&alternativeidx=${alternativeIdx}`;
  let lastFailure: RouteStats | null = null;
  for (let attempt = 0; attempt <= WATCHDOG_RETRY_DELAYS_MS.length; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (error) {
      return {
        distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
        status: -1, profileId: profile, error: `route fetch failed: ${formatError(error)}`,
      };
    }
    const text = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || !ct.includes('json') || text.trimStart().toLowerCase().startsWith('error')) {
      lastFailure = {
        distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
        status: res.status, profileId: profile, error: text.slice(0, 200),
      };
      if (lastFailure.error && isWatchdogMessage(lastFailure.error) && attempt < WATCHDOG_RETRY_DELAYS_MS.length) {
        await delay(WATCHDOG_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return lastFailure;
    }
    const fc = JSON.parse(text);
    const props = fc.features?.[0]?.properties ?? {};
    const dist = Number(props['track-length']) || 0;
    const time = Number(props['total-time']) || 0;
    const asc = Number(props['filtered ascend']) || 0;
    const plain = Number(props['plain-ascend']) || 0;
    const directKm = haversineKm(from, to);
    return {
      distanceKm: dist / 1000,
      ascentM: asc,
      descentM: asc - plain,
      durationMin: time / 60,
      tortuosity: directKm > 0 ? (dist / 1000) / directKm : 0,
      status: res.status,
      profileId: profile,
      coordinates: fc.features?.[0]?.geometry?.coordinates as [number, number][] | undefined,
    };
  }
  return lastFailure ?? {
    distanceKm: 0, ascentM: 0, descentM: 0, durationMin: 0, tortuosity: 0,
    status: -1, profileId: profile, error: 'route fetch failed after watchdog retries',
  };
}
