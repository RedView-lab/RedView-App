// ---------------------------------------------------------------------------
// Décodage d'une requête `/api/*` en `ApiRequest` (forme Vercel : `req.query`,
// `req.body`), partagé par les deux adaptateurs qui exécutent `api/*.ts` :
// server.mjs (prod) et le plugin de dev de vite.config.ts. Le corps est lu
// au préalable, plafonné (`readBodyLimited` de http-security.mjs).
// ---------------------------------------------------------------------------

/**
 * Paramètres de requête : une chaîne par clé, un tableau quand la clé est
 * répétée (`?a=1&a=2` → `{ a: ['1', '2'] }`). Objet sans prototype : une clé
 * `constructor`, `toString` ou `__proto__` est une clé comme une autre (sur
 * un `{}`, `?__proto__=a&__proto__=b` remplaçait le prototype de la query).
 *
 * @param {URLSearchParams} searchParams
 * @returns {Record<string, string | string[]>}
 */
export function parseApiQuery(searchParams) {
  /** @type {Record<string, string | string[]>} */
  const query = Object.create(null);
  for (const [key, value] of searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}

/**
 * Corps décodé selon son Content-Type : objet JSON (le texte brut s'il est
 * invalide, `{}` s'il est vide), texte pour `text/*` et les formulaires,
 * sinon le Buffer tel quel. Venu du client : chaque handler valide ce qu'il lit.
 *
 * @param {Buffer} rawBody
 * @param {string | undefined} contentTypeHeader
 * @returns {unknown}
 */
export function parseApiBody(rawBody, contentTypeHeader) {
  const contentType = (contentTypeHeader || '').toLowerCase();
  if (contentType.includes('application/json')) {
    if (rawBody.length === 0) return {};
    const text = rawBody.toString('utf-8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.includes('text/') || contentType.includes('application/x-www-form-urlencoded')) {
    return rawBody.toString('utf-8');
  }
  return rawBody;
}
