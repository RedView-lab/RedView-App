import type { VercelRequest, VercelResponse } from '@vercel/node';
import { processDemTile } from '../lib/dem-processor.js';

const HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400, s-maxage=604800',
  'Access-Control-Allow-Origin': '*',
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { z, x, y } = req.query;
  const mercZ = parseInt(z as string, 10);
  const mercX = parseInt(x as string, 10);
  const mercY = parseInt(y as string, 10);

  if ([mercZ, mercX, mercY].some((v) => Number.isNaN(v) || v < 0)) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }

  const token = process.env.VITE_MAPBOX_TOKEN || process.env.MAPBOX_TOKEN || '';
  const result = await processDemTile(mercZ, mercX, mercY, token);

  if (!result) {
    return res.status(204).end();
  }

  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  return res.status(200).send(result.data);
}