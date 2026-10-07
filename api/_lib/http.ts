import type { ApiRequest, ApiResponse } from './types.js';

export function sendMethodNotAllowed(
  res: ApiResponse,
  allowedMethods: string[],
): ApiResponse {
  res.setHeader('Allow', allowedMethods.join(', '));
  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * Champs du corps JSON déjà lu, chacun `unknown` : le handler valide le type
 * de chaque champ qu'il utilise. Tout autre corps (texte, Buffer, tableau,
 * absent) donne un objet vide.
 */
export function bodyFields(req: ApiRequest): Record<string, unknown> {
  const { body } = req;
  return body && typeof body === 'object' && !Array.isArray(body) && !Buffer.isBuffer(body)
    ? body as Record<string, unknown>
    : {};
}

export async function readJsonBody<T>(req: ApiRequest): Promise<T> {
  if (req.body && typeof req.body === 'object') {
    return req.body as T;
  }

  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body) as T;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

export async function readRawBody(req: ApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
