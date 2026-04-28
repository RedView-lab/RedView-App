import type { VercelRequest, VercelResponse } from '@vercel/node';

export function sendMethodNotAllowed(
  res: VercelResponse,
  allowedMethods: string[],
): VercelResponse {
  res.setHeader('Allow', allowedMethods.join(', '));
  return res.status(405).json({ error: 'Method not allowed' });
}

export async function readJsonBody<T>(req: VercelRequest): Promise<T> {
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

export async function readRawBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
