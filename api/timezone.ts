import type { VercelRequest, VercelResponse } from '@vercel/node';

function parseCoordinate(raw: unknown, kind: 'lat' | 'lon'): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (kind === 'lat' && (value < -90 || value > 90)) return null;
  if (kind === 'lon' && (value < -180 || value > 180)) return null;
  return value;
}

async function resolveTimeZones(lat: number, lon: number): Promise<string[]> {
  const geoTzModule = await import('geo-tz');
  const find = geoTzModule.find;
  const matches = find(lat, lon);
  return Array.isArray(matches)
    ? matches.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
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

  const lat = parseCoordinate(req.query.lat, 'lat');
  const lon = parseCoordinate(req.query.lon, 'lon');
  if (lat == null || lon == null) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  try {
    const candidates = await resolveTimeZones(lat, lon);
    const timeZone = candidates[0] ?? null;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.status(200).json({ timeZone, candidates });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: 'Timezone lookup failed', detail });
  }
}