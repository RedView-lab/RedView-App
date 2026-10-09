import { PublicError } from './errors.js';
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PublicError('Invalid JSON body', 400);
  }
  if (!isJsonObject(parsed)) throw new PublicError('The JSON body must be an object', 400);
  return parsed;
}

/**
 * Corps JSON objet de la requête. Un corps invalide, ou qui n'est pas un
 * objet (`null`, tableau, nombre), est une erreur du client : 400
 * (`PublicError`), jamais un 500 remonté à GlitchTip. Le handler valide
 * ensuite le type de chaque champ qu'il lit.
 */
export async function readJsonBody<T>(req: ApiRequest): Promise<T> {
  // server.mjs / le plugin de dev ont déjà décodé un corps `application/json`
  // valide ; un JSON invalide y reste en texte.
  if (isJsonObject(req.body)) return req.body as T;
  if (typeof req.body === 'string') return parseJsonObject(req.body) as T;

  const raw = await readRawBody(req);
  return parseJsonObject(raw.toString('utf8')) as T;
}

export async function readRawBody(req: ApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
