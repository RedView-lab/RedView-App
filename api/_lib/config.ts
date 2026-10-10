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

  // Hôte de la requête accepté seulement en développement : en production,
  // l'URL publique de l'app (X-Forwarded-Host vient du client quand le proxy
  // ne la réécrit pas ; un sous-domaine quelconque devenait une destination
  // de redirection, A2-3).
  if (process.env.NODE_ENV !== 'production') {
    const hostHeader = req.headers['x-forwarded-host'] ?? req.headers.host;
    const protoHeader = req.headers['x-forwarded-proto'];
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    if (host && /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)) {
      return `${proto === 'https' ? 'https' : 'http'}://${host}`;
    }
  }

  return 'https://app.redview.tech';
}
