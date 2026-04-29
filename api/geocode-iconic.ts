import type { VercelRequest, VercelResponse } from '@vercel/node';

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const TIMEOUT_MS = 12_000;
const USER_AGENT = 'RedViewPRODUCTION/1.0 (iconic geocoder proxy)';

function readQueryParam(req: VercelRequest, key: string): string {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

function clampLimit(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(1, Math.min(parsed, 6));
}

function sanitizeCountryCodes(raw: string): string | null {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => /^[a-z]{2}$/.test(part));
  return parts.length > 0 ? parts.join(',') : null;
}

function previewText(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

async function fetchWithTimeout(target: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(target, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timer);
  }
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

  const query = readQueryParam(req, 'q').trim();
  if (query.length < 2) {
    return res.status(400).json({ error: 'Missing query' });
  }

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    extratags: '1',
    limit: String(clampLimit(readQueryParam(req, 'limit'))),
  });

  const language = readQueryParam(req, 'language').trim() || 'fr';
  params.set('accept-language', language);

  const countryCodes = sanitizeCountryCodes(readQueryParam(req, 'countrycodes'));
  if (countryCodes) params.set('countrycodes', countryCodes);

  try {
    const upstream = await fetchWithTimeout(`${NOMINATIM_ENDPOINT}?${params.toString()}`);
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) {
      const preview = previewText(body.toString('utf-8'));
      return res.status(502).json({
        error: 'Iconic geocoder upstream failed',
        detail: preview || `HTTP ${upstream.status}`,
      });
    }

    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=900');
    res.setHeader('X-Geocoder-Source', 'nominatim');
    return res.send(body);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ error: 'Iconic geocoder request failed', detail });
  }
}