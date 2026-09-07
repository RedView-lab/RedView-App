import type { ApiRequest, ApiResponse } from './_lib/types.js';
import { resolveAppLocale, createAppTranslationBundle } from './_lib/i18n.js';

export default function handler(req: ApiRequest, res: ApiResponse) {
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