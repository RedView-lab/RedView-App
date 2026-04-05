import type { VercelRequest, VercelResponse } from '@vercel/node';

const IGN_BASE = 'https://data.geopf.fr/telechargement/download/LiDARHD-NUALID';

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
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(600_000),
    });

    if (!upstream.ok) {
      res.status(upstream.status).send(upstream.statusText);
      return;
    }

    const contentLength = upstream.headers.get('content-length');
    res.setHeader('Content-Type', 'application/octet-stream');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
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
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (!res.headersSent) {
      res.status(502).json({ error: message });
    }
  }
}
