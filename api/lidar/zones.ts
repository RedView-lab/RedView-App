import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Strip <georss:polygon> elements from the XML response.
 * The client only needs <title>, <link gpf_dl:bbox>, and <feed gpf_dl:pagecount>.
 * Polygons are huge (many KB each) and cause Vercel's 4.5MB body limit to be exceeded.
 */
function stripPolygons(xml: string): string {
  return xml
    .replace(/<georss:polygon>[\s\S]*?<\/georss:polygon>/g, '')
    .replace(/<georss:polygon\/>/g, '');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const page = parseInt(req.query.page as string, 10) || 1;
    const url = `https://data.geopf.fr/telechargement/resource/LiDARHD-NUALID?limit=100&page=${page}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'RedView/0.1' },
    });

    if (!response.ok) {
      return res.status(response.status).send('IGN WFS error');
    }

    const text = await response.text();
    const stripped = stripPolygons(text);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(stripped);
  } catch (err: any) {
    console.error('[LiDAR] WFS proxy error:', err.message);
    res.status(502).send('WFS proxy error');
  }
}
