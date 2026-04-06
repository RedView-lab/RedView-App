import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const { zoom, row, col } = req.query;

    if (!zoom || !row || !col) {
      return res.status(400).send('Missing zoom/row/col parameters');
    }

    // Validate numeric params
    const z = String(zoom);
    const r = String(row);
    const c = String(col);
    if (!/^\d+$/.test(z) || !/^\d+$/.test(r) || !/^\d+$/.test(c)) {
      return res.status(400).send('Invalid tile parameters');
    }

    const url = `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${r}&TILECOL=${c}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'RedView/Web' },
    });

    if (!response.ok) {
      return res.status(response.status).send('WMTS error');
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(buffer);
  } catch (err: any) {
    console.error('[LiDAR] WMTS proxy error:', err.message);
    res.status(502).send('WMTS proxy error');
  }
}
