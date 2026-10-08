import type { ApiRequest } from './types.js';
import { PublicError } from './errors.js';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // Le nom de la variable reste côté serveur (logs), jamais renvoyé au client.
    console.error(`[config] Missing required environment variable: ${name}`);
    throw new PublicError('Service temporarily unavailable.', 503);
  }
  return value;
}

export function getAppBaseUrl(req: ApiRequest): string {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const hostHeader = req.headers['x-forwarded-host'] ?? req.headers.host;
  const protoHeader = req.headers['x-forwarded-proto'];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;

  const ALLOWED_HOST_PATTERN = /^(?:(?:[a-zA-Z0-9-]+\.)*redview\.tech|localhost|127\.0\.0\.1)(?::\d+)?$/;

  if (host && ALLOWED_HOST_PATTERN.test(host)) {
    return `${proto ?? 'https'}://${host}`.replace(/\/+$/, '');
  }

  return 'https://app.redview.tech';
}
