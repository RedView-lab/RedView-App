import type { VercelRequest, VercelResponse } from '@vercel/node';

import { createAppTranslationBundle, resolveAppLocale } from '../src/shared/i18n/config';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const locale = resolveAppLocale(req.query.locale);
  const bundle = createAppTranslationBundle(locale);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
  return res.status(200).json(bundle);
}