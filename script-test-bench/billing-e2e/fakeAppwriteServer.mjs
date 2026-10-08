/**
 * Appwrite en mémoire CÔTÉ SERVEUR, pour le banc de facturation.
 *
 * Le faux Appwrite de dashboard-perf (fakeAppwrite.mjs) sert le navigateur via
 * `context.route` ; les routes `api/billing/*` et le webhook, elles, appellent
 * Appwrite depuis le serveur bundlé avec `node-appwrite`, que Playwright ne
 * voit pas. Ce serveur HTTP local répond à ces appels-là (le serveur de l'app
 * est lancé avec `APPWRITE_ENDPOINT` pointé dessus) :
 *
 *  - `GET /v1/account` avec `X-Appwrite-JWT` : le compte du jeton
 *    (`requireAuthenticatedUser`), 401 pour un jeton inconnu ;
 *  - documents : get / list (equal, limit) / create / update / delete, dans
 *    n'importe quelle collection (`customers`, `subscriptions` en pratique).
 *
 * Tout autre appel est journalisé dans `state.unhandled` et reçoit un 404
 * Appwrite : le banc échoue s'il en voit.
 */
import http from 'node:http';

function appwriteError(code, message, type = 'general_not_found') {
  return { status: code, body: { message, code, type, version: 'fake' } };
}

function parseQueries(searchParams) {
  const queries = [];
  for (const [key, value] of searchParams) {
    if (!/^queries\[\d*\]$/.test(key)) continue;
    try {
      queries.push(JSON.parse(value));
    } catch {
      // Query illisible : ignorée comme un filtre vide.
    }
  }
  return queries;
}

function matches(doc, query) {
  if (query.method !== 'equal') return true;
  return (query.values ?? []).some((candidate) => candidate === doc[query.attribute]);
}

/**
 * @param {{ users: Record<string, { $id: string, email: string, name: string }> }} options
 *   JWT → compte (le faux Appwrite du navigateur délivre ces jetons).
 */
export async function startFakeAppwriteServer({ users }) {
  const state = {
    /** @type {Map<string, Map<string, Record<string, unknown>>>} */
    collections: new Map(),
    calls: [],
    unhandled: [],
  };
  const collection = (id) => {
    if (!state.collections.has(id)) state.collections.set(id, new Map());
    return state.collections.get(id);
  };
  const now = () => new Date().toISOString().replace('Z', '+00:00');

  function handle(method, path, searchParams, headers, body) {
    const segments = path.split('/').filter(Boolean);

    if (segments[0] === 'account' && segments.length === 1 && method === 'GET') {
      const user = users[headers['x-appwrite-jwt'] ?? ''];
      if (!user) return appwriteError(401, 'Invalid JWT', 'user_jwt_invalid');
      return {
        status: 200,
        body: { ...user, status: true, labels: [], emailVerification: true, prefs: {}, $createdAt: now(), $updatedAt: now() },
      };
    }

    if (segments[0] === 'databases' && segments[2] === 'collections' && segments[4] === 'documents') {
      if (!headers['x-appwrite-key']) return appwriteError(401, 'Missing API key', 'general_unauthorized_scope');
      const docs = collection(segments[3]);
      const id = segments[5] ? decodeURIComponent(segments[5]) : null;
      if (method === 'GET' && !id) {
        const queries = parseQueries(searchParams);
        const list = [...docs.values()].filter((doc) => queries.every((q) => matches(doc, q)));
        const limit = queries.find((q) => q.method === 'limit')?.values?.[0] ?? 25;
        return { status: 200, body: { total: list.length, documents: list.slice(0, limit) } };
      }
      if (method === 'GET') {
        const doc = docs.get(id);
        return doc ? { status: 200, body: doc } : appwriteError(404, 'Document not found', 'document_not_found');
      }
      if (method === 'POST') {
        const documentId = body?.documentId;
        if (!documentId) return appwriteError(400, 'Missing documentId', 'general_argument_invalid');
        if (docs.has(documentId)) return appwriteError(409, 'Document already exists', 'document_already_exists');
        const doc = { $id: documentId, $collectionId: segments[3], $createdAt: now(), $updatedAt: now(), $permissions: body?.permissions ?? [], ...(body?.data ?? {}) };
        docs.set(documentId, doc);
        return { status: 201, body: doc };
      }
      if (method === 'PATCH') {
        const doc = docs.get(id);
        if (!doc) return appwriteError(404, 'Document not found', 'document_not_found');
        Object.assign(doc, body?.data ?? {}, { $updatedAt: now() });
        return { status: 200, body: doc };
      }
      if (method === 'DELETE') {
        if (!docs.delete(id)) return appwriteError(404, 'Document not found', 'document_not_found');
        return { status: 204, body: null };
      }
    }
    return null;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const path = url.pathname.replace(/^\/v1/, '');
      let body = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      const result = handle(req.method ?? 'GET', path, url.searchParams, req.headers, body)
        ?? (state.unhandled.push(`${req.method} ${path}`), appwriteError(404, `fake Appwrite (serveur) : ${req.method} ${path} non simulé`));
      state.calls.push({ method: req.method, path, status: result.status });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(result.body === null ? '' : JSON.stringify(result.body));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    state,
    /** Identifiants Stripe des clients que l'app a créés (nettoyage). */
    stripeCustomerIds: () => [...collection('customers').values()]
      .map((doc) => doc.stripe_customer_id)
      .filter((id) => typeof id === 'string' && id.startsWith('cus_')),
    /** Ensemence un document (ex. la ligne `customers` d'un client Stripe créé par le banc). */
    putDocument: (collectionId, id, data) => {
      collection(collectionId).set(id, { $id: id, $collectionId: collectionId, $createdAt: now(), $updatedAt: now(), $permissions: [], ...data });
    },
    customerIdFor: (userId) => {
      const id = collection('customers').get(userId)?.stripe_customer_id;
      return typeof id === 'string' && id ? id : null;
    },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
