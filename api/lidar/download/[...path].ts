export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request) {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const url = new URL(req.url);
    const rawPath = url.pathname;
    const pathSegments = rawPath
      .replace(/^\/api\/lidar\/download\//, '')
      .split('/')
      .filter(Boolean);

    console.log(`[LiDAR proxy] raw pathname=${rawPath} segments=[${pathSegments.join(', ')}]`);

    if (pathSegments.length < 2) {
      console.warn(`[LiDAR proxy] Not enough segments (${pathSegments.length}) from pathname: ${rawPath}`);
      return new Response('Missing zone/file parameters', { status: 400 });
    }

    const zone = pathSegments[0];
    const file = pathSegments[1];

    // Validate parameters to prevent path traversal
    if (!/^[\w._-]+$/.test(zone) || !/^[\w._-]+$/.test(file)) {
      return new Response('Invalid parameters', { status: 400 });
    }

    const ignUrl = `https://data.geopf.fr/telechargement/download/LiDARHD-NUALID/${zone}/${file}`;
    console.log(`[LiDAR proxy] ${req.method} zone=${zone} file=${file} -> ${ignUrl}`);

    const maxRetries = 3;
    const baseDelay429 = 2000;
    const baseDelay5xx = 1000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(ignUrl, {
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
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        const headers: HeadersInit = {};
        if (retryAfter) headers['Retry-After'] = retryAfter;
        return new Response('IGN rate limit exceeded after retries', { status: 429, headers });
      }

      if (response.status >= 500 && attempt < maxRetries) {
        const delay = baseDelay5xx * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        console.warn(`[LiDAR proxy] Upstream ${response.status} for ${ignUrl}`);
        return new Response(`IGN download error: ${response.status}`, { status: response.status });
      }

      // Stream the response body directly — no buffering
      const headers = new Headers();
      const contentLength = response.headers.get('content-length');
      const contentType = response.headers.get('content-type');
      if (contentLength) headers.set('Content-Length', contentLength);
      headers.set('Content-Type', contentType || 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="${file}"`);

      return new Response(response.body, { status: 200, headers });
    }

    return new Response('Download failed after retries', { status: 502 });
  } catch {
    return new Response('Download proxy error', { status: 502 });
  }
}
