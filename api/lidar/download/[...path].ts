import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  try {
    // Vercel catch-all: req.query.path is an array of path segments
    const pathSegments = req.query.path;
    if (!Array.isArray(pathSegments) || pathSegments.length < 2) {
      return res.status(400).send('Missing zone/file parameters');
    }

    const zone = pathSegments[0];
    const file = pathSegments[1];

    // Validate parameters to prevent path traversal
    if (!/^[\w._-]+$/.test(zone) || !/^[\w._-]+$/.test(file)) {
      return res.status(400).send('Invalid parameters');
    }

    const url = `https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/${zone}/${file}`;

    const maxRetries = 3;
    const baseDelay429 = 2000;
    const baseDelay5xx = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'RedView/0.1' },
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        let delay: number;
        if (retryAfter) {
          const secs = parseInt(retryAfter, 10);
          delay = isNaN(secs) ? baseDelay429 * Math.pow(2, attempt) : secs * 1000;
        } else {
          delay = baseDelay429 * Math.pow(2, attempt);
        }

        if (attempt < maxRetries) {
          console.log(`[LiDAR] 429 from IGN for ${file}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        return res.status(429).send('IGN rate limit exceeded after retries');
      }

      if (response.status >= 500 && attempt < maxRetries) {
        const delay = baseDelay5xx * Math.pow(2, attempt);
        console.log(`[LiDAR] ${response.status} from IGN for ${file}, retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        return res.status(response.status).send(`IGN download error: ${response.status}`);
      }

      const contentLength = response.headers.get('content-length');
      const contentType = response.headers.get('content-type');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('Content-Type', contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file}"`);

      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
      return;
    }
  } catch (err: any) {
    console.error('[LiDAR] Download proxy error:', err.message);
    if (!res.headersSent) res.status(502).send('Download proxy error');
  }
}
