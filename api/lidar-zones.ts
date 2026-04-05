import type { VercelRequest, VercelResponse } from '@vercel/node';

const IGN_BASE = 'https://data.geopf.fr/telechargement/resource/LiDARHD-NUALID';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const page = typeof req.query.page === 'string' ? req.query.page : '1';
  const url = `${IGN_BASE}?limit=100&page=${encodeURIComponent(page)}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8',
        'User-Agent': 'RedView-App/1.0',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok) {
      res.status(upstream.status).send(upstream.statusText);
      return;
    }

    const xml = await upstream.text();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(xml);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(502).json({ error: message });
  }
}
