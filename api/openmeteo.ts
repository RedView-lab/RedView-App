/**
 * Proxy → Open-Meteo auto-hébergé sur le VPS (api/_lib/openMeteo.ts).
 *
 *   GET /api/openmeteo/v1/forecast?latitude=...&longitude=...&...
 *
 * Pourquoi un proxy ? L'Open-Meteo du VPS répond en HTTP simple et seulement
 * en local (nginx de l'hôte) : le navigateur reste same-origin. La requête est
 * bornée à ce que le VPS sert (modèles Météo-France, J+4, 3 jours passés,
 * 200 points) ; aucune autre source, jamais l'API publique.
 *
 * Variable d'env serveur (voir .env.example) :
 *   OPENMETEO_UPSTREAM=http://<VPS_IP>/openmeteo
 */
import { PublicError, sendSafeError } from './_lib/errors.js';
import {
  OPENMETEO_MAX_FORECAST_DAYS,
  OPENMETEO_MAX_LOCATIONS,
  OPENMETEO_MAX_PAST_DAYS,
  openMeteoUpstream,
  resolveOpenMeteoModel,
} from './_lib/openMeteo.js';
import type { ApiRequest, ApiResponse } from './_lib/types.js';

const TIMEOUT_MS = 25_000;
const FORECAST_PATH = '/v1/forecast';

/** Borne un entier de la query (`forecast_days`, `past_days`) ; absent ou illisible : laissé tel quel. */
function clampDays(params: URLSearchParams, name: string, max: number): void {
  const raw = params.get(name);
  if (raw === null) return;
  const value = Number.parseInt(raw, 10);
  if (Number.isFinite(value)) params.set(name, String(Math.max(0, Math.min(value, max))));
}

/** Query transmise au VPS : modèle servi, horizon et nombre de points bornés. */
function buildUpstreamQuery(search: string): URLSearchParams {
  const params = new URLSearchParams(search);
  const locations = (params.get('latitude') ?? '').split(',').filter(Boolean).length;
  if (locations === 0) throw new PublicError('latitude and longitude are required', 400);
  if (locations > OPENMETEO_MAX_LOCATIONS) {
    throw new PublicError(`At most ${OPENMETEO_MAX_LOCATIONS} locations per request`, 400);
  }
  params.set('models', resolveOpenMeteoModel(params.get('models')));
  clampDays(params, 'forecast_days', OPENMETEO_MAX_FORECAST_DAYS);
  clampDays(params, 'past_days', OPENMETEO_MAX_PAST_DAYS);
  return params;
}

function isJson(text: string): boolean {
  if (!text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Chemin exact uniquement : la cible amont est une constante + la query.
  const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
  const subPath = parsedUrl.pathname.replace(/^\/api\/openmeteo(?=\/|$)/, '').replace(/\/$/, '');
  if (subPath !== FORECAST_PATH) {
    return res.status(404).json({ error: 'Unknown Open-Meteo path' });
  }

  let target: string;
  try {
    target = `${openMeteoUpstream()}${FORECAST_PATH}?${buildUpstreamQuery(parsedUrl.search).toString()}`;
  } catch (error) {
    return sendSafeError(res, error, 'Weather request refused', 'openmeteo');
  }

  let upstream: Response;
  let body: Buffer;
  try {
    upstream = await fetch(target, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = Buffer.from(await upstream.arrayBuffer());
  } catch (error) {
    console.error('[openmeteo] VPS unreachable:', error instanceof Error ? error.message : error);
    return res.status(502).json({ error: 'Weather service unavailable' });
  }

  const text = body.toString('utf-8');
  const json = isJson(text);
  // Une réponse JSON 4xx est celle d'Open-Meteo à cette requête (paramètre
  // refusé, 429) : relayée telle quelle. Tout le reste est une panne du VPS.
  if (!json || (!upstream.ok && (upstream.status < 400 || upstream.status >= 500))) {
    console.error(`[openmeteo] VPS answered HTTP ${upstream.status}${json ? '' : ' (non-JSON)'}: ${text.slice(0, 200)}`);
    return res.status(502).json({ error: 'Weather service unavailable' });
  }

  res.status(upstream.status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Weather-Source', 'self-hosted-vps');
  if (upstream.ok) {
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  } else {
    // Jamais en cache (l'horizon avance chaque jour) ; Retry-After pour le backoff du client.
    res.setHeader('Cache-Control', 'no-store');
    const retryAfter = upstream.headers.get('retry-after')?.trim();
    if (retryAfter && /^\d{1,6}$/.test(retryAfter)) res.setHeader('Retry-After', retryAfter);
  }
  return res.send(body);
}
