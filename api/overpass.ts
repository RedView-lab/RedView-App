/**
 * Vercel serverless proxy → public Overpass API mirrors.
 *
 * Used by the Col-Bagging v2 engine to discover OSM mountain passes,
 * saddles and high peaks inside a route corridor.
 *
 *   POST /api/overpass
 *     Content-Type: text/plain
 *     body = Overpass QL query (≤ 50 KB)
 *
 * Strategy:
 *   - Try `MIRRORS` in order. First HTTP-2xx with a JSON body wins.
 *   - On 429 / 504 / 5xx / network error → fall through to the next.
 *   - Total wall-clock cap = OVERPASS_TIMEOUT_MS so Vercel doesn't 504.
 *
 * Caching:
 *   - `Cache-Control: public, s-maxage=86400, stale-while-revalidate=604800`
 *     so Vercel's edge caches identical queries for a day. Our client
 *     also caches them in IndexedDB, but the edge cache helps when
 *     several users plan the same corridor.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const OVERPASS_TIMEOUT_MS = 85_000; // Vercel maxDuration must be ≥ this.
const PER_MIRROR_TIMEOUT_MS = 60_000;
const MAX_QUERY_BYTES = 50_000;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = await readBody(req);
  if (!body || body.length === 0) {
    return res.status(400).json({ error: 'Empty Overpass QL body' });
  }
  if (body.length > MAX_QUERY_BYTES) {
    return res.status(413).json({
      error: `Overpass query exceeds ${MAX_QUERY_BYTES} bytes`,
    });
  }

  const deadline = Date.now() + OVERPASS_TIMEOUT_MS;
  let lastErr = '';

  for (const url of MIRRORS) {
    const remaining = deadline - Date.now();
    if (remaining < 5_000) break;
    const perTry = Math.min(PER_MIRROR_TIMEOUT_MS, remaining);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perTry);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'Accept': 'application/json',
          'User-Agent': 'RedView/1.0 (+https://redview.app)',
        },
        body,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = (err as { name?: string } | undefined)?.name === 'AbortError';
      lastErr = `${url}: ${isAbort ? 'timeout' : (err as Error).message}`;
      continue;
    }
    clearTimeout(timer);

    if (upstream.status === 429 || upstream.status === 504 ||
        upstream.status === 503 || upstream.status === 502) {
      lastErr = `${url}: HTTP ${upstream.status}`;
      continue;
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res
        .status(upstream.status)
        .send(text || `Overpass HTTP ${upstream.status}`);
    }

    const text = await upstream.text();
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=86400, stale-while-revalidate=604800',
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('x-overpass-mirror', url);
    return res.status(200).send(text);
  }

  return res.status(502).json({
    error: 'All Overpass mirrors failed',
    detail: lastErr.slice(0, 400),
  });
}

async function readBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') {
    return JSON.stringify(req.body);
  }
  // Fallback: stream-read.
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
