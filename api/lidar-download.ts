import type { VercelRequest, VercelResponse } from '@vercel/node';

const IGN_BASE = 'https://data.geopf.fr/telechargement/download/LiDARHD-NUALID';
const MAX_RETRIES = 3;
const RETRY_BASE_429_MS = 2_000;
const RETRY_BASE_5XX_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { zone, file } = req.query;
  if (typeof zone !== 'string' || typeof file !== 'string') {
    res.status(400).json({ error: 'Missing zone or file parameter' });
    return;
  }

  const safeZone = zone.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const safeFile = file.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  const url = `${IGN_BASE}/${safeZone}/${safeFile}`;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'RedView/1.0' },
        signal: AbortSignal.timeout(600_000),
      });

      if (upstream.status === 429) {
        const retryAfter = upstream.headers.get('retry-after');
        let delay: number;
        if (retryAfter) {
          const secs = parseInt(retryAfter, 10);
          delay = isNaN(secs) ? RETRY_BASE_429_MS * 2 ** attempt : secs * 1000;
        } else {
          delay = RETRY_BASE_429_MS * 2 ** attempt;
        }
        if (attempt < MAX_RETRIES) {
          await sleep(delay);
          continue;
        }
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        res.status(429).send('IGN rate limit exceeded after retries');
        return;
      }

      if (upstream.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_5XX_MS * 2 ** attempt);
        continue;
      }

      if (!upstream.ok) {
        res.status(upstream.status).send(upstream.statusText);
        return;
      }

      const contentLength = upstream.headers.get('content-length');
      const contentType = upstream.headers.get('content-type');
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
      res.setHeader('Cache-Control', 'public, max-age=86400');

      if (!upstream.body) {
        const buf = await upstream.arrayBuffer();
        res.status(200).send(Buffer.from(buf));
        return;
      }

      res.status(200);
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise(resolve => res.once('drain', resolve));
        }
      }
      res.end();
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(502).json({ error: message });
    }
  }
}
