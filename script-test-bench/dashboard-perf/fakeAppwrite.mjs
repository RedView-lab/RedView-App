/**
 * Appwrite en mémoire pour les bancs du dashboard sur le build de production.
 *
 * Le build de production n'a pas de compte démo : sans backend, il s'arrête à
 * l'écran de connexion. Plutôt que la prod (latence variable, écritures sur un
 * compte de test, secrets), les appels REST du SDK `appwrite` sont servis ici
 * via `context.route` : compte, documents (projects, project_folders,
 * project_views…), fichiers des buckets. Un délai réseau modélisé (aller-retour
 * + octets / débit) remplace le vrai : une réponse fournie par `route.fulfill`
 * échappe à l'émulation réseau de Chromium.
 *
 * Couverture : ce que l'app appelle (account.get/updatePrefs/createJWT/
 * createEmailPasswordSession/deleteSession, databases list/get/create/update/
 * delete avec equal/notEqual/limit/cursorAfter/orderDesc/select, storage
 * download/view/list/create/delete). Tout autre appel est journalisé
 * (`unhandled`) et reçoit un 404 Appwrite : un banc qui en voit doit échouer.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Délai d'une réponse de `bytes` octets sur un profil { rttMs, downKbps }. */
export function transferDelayMs(network, bytes) {
  if (!network) return 0;
  const transfer = network.downKbps > 0 ? (bytes * 8) / network.downKbps : 0;
  return network.rttMs + transfer;
}

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
      // Query illisible : ignorée comme le ferait un filtre vide.
    }
  }
  return queries;
}

function matches(doc, query) {
  const value = doc[query.attribute];
  const values = query.values ?? [];
  switch (query.method) {
    case 'equal':
      return values.some((candidate) => candidate === value);
    case 'notEqual':
      return values.every((candidate) => candidate !== value);
    case 'isNull':
      return value === null || value === undefined;
    case 'isNotNull':
      return value !== null && value !== undefined;
    default:
      return true;
  }
}

function project(doc, select) {
  if (!select) return doc;
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('$') || select.includes(key)) out[key] = value;
  }
  return out;
}

const userPermissions = (userId) => [`read("user:${userId}")`, `update("user:${userId}")`, `delete("user:${userId}")`];

/**
 * @param {object} options
 * @param {string} options.endpoint  VITE_APPWRITE_ENDPOINT du build (…/v1)
 * @param {{ $id: string, email: string, name: string }} options.user
 * @param {boolean} [options.loggedIn]
 * @param {{ rttMs: number, downKbps: number } | null} [options.network]
 */
export function createFakeAppwrite({ endpoint, user, loggedIn = true, network = null }) {
  const base = endpoint.replace(/\/+$/, '');
  const state = {
    loggedIn,
    network,
    user: {
      $id: user.$id,
      $createdAt: '2026-01-01T00:00:00.000+00:00',
      $updatedAt: '2026-01-01T00:00:00.000+00:00',
      name: user.name,
      email: user.email,
      registration: '2026-01-01T00:00:00.000+00:00',
      status: true,
      labels: [],
      passwordUpdate: '2026-01-01T00:00:00.000+00:00',
      phone: '',
      emailVerification: true,
      phoneVerification: false,
      mfa: false,
      prefs: {},
      targets: [],
      accessedAt: '2026-01-01T00:00:00.000+00:00',
    },
    /** @type {Map<string, Map<string, Record<string, unknown>>>} */
    collections: new Map(),
    /** @type {Map<string, Map<string, { bytes: Buffer, meta: Record<string, unknown> }>>} */
    buckets: new Map(),
    calls: [],
    unhandled: [],
  };

  const collection = (id) => {
    if (!state.collections.has(id)) state.collections.set(id, new Map());
    return state.collections.get(id);
  };
  const bucket = (id) => {
    if (!state.buckets.has(id)) state.buckets.set(id, new Map());
    return state.buckets.get(id);
  };
  const now = () => new Date().toISOString().replace('Z', '+00:00');

  /** Ajoute un document appartenant à l'utilisateur (permissions comprises, comme l'app les écrit). */
  function putDocument(collectionId, id, attributes) {
    const stamp = attributes.$updatedAt ?? now();
    const doc = {
      $id: id,
      $collectionId: collectionId,
      $databaseId: 'fake',
      $createdAt: attributes.$createdAt ?? stamp,
      $updatedAt: stamp,
      $permissions: userPermissions(state.user.$id),
      ...attributes,
    };
    collection(collectionId).set(id, doc);
    return doc;
  }

  function putFile(bucketId, id, bytes, name = id) {
    const meta = {
      $id: id,
      bucketId,
      $createdAt: now(),
      $updatedAt: now(),
      $permissions: userPermissions(state.user.$id),
      name,
      signature: '',
      mimeType: 'application/octet-stream',
      sizeOriginal: bytes.length,
      chunksTotal: 1,
      chunksUploaded: 1,
    };
    bucket(bucketId).set(id, { bytes, meta });
    return meta;
  }

  function handle(method, path, searchParams, body) {
    const segments = path.split('/').filter(Boolean);
    const unauthorized = () => appwriteError(401, 'User (role: guests) missing scope (account)', 'general_unauthorized_scope');

    if (segments[0] === 'account') {
      if (method === 'POST' && segments[1] === 'sessions') {
        state.loggedIn = true;
        return { status: 201, body: { $id: 'fake-session', userId: state.user.$id, current: true, provider: 'email', expire: '2099-01-01T00:00:00.000+00:00' } };
      }
      if (!state.loggedIn) return unauthorized();
      if (method === 'GET' && segments.length === 1) return { status: 200, body: state.user };
      if (method === 'GET' && segments[1] === 'prefs') return { status: 200, body: state.user.prefs };
      if (method === 'PATCH' && segments[1] === 'prefs') {
        state.user.prefs = body?.prefs ?? {};
        return { status: 200, body: state.user };
      }
      if (method === 'POST' && segments[1] === 'jwts') return { status: 201, body: { jwt: 'fake-jwt' } };
      if (method === 'DELETE' && segments[1] === 'sessions') {
        state.loggedIn = false;
        return { status: 204, body: null };
      }
      return null;
    }

    if (!state.loggedIn) return unauthorized();

    // /databases/{db}/collections/{collection}/documents[/{id}]
    if (segments[0] === 'databases' && segments[2] === 'collections' && segments[4] === 'documents') {
      const docs = collection(segments[3]);
      const id = segments[5];
      const queries = parseQueries(searchParams);
      const select = queries.find((q) => q.method === 'select')?.values ?? null;
      if (method === 'GET' && !id) {
        let list = [...docs.values()].filter((doc) => queries.every((q) => matches(doc, q)));
        const order = queries.find((q) => q.method === 'orderDesc' || q.method === 'orderAsc');
        if (order) {
          const sign = order.method === 'orderDesc' ? -1 : 1;
          list.sort((a, b) => (a[order.attribute] < b[order.attribute] ? -sign : a[order.attribute] > b[order.attribute] ? sign : 0));
        }
        const total = list.length;
        const cursor = queries.find((q) => q.method === 'cursorAfter')?.values?.[0];
        if (cursor) list = list.slice(list.findIndex((doc) => doc.$id === cursor) + 1);
        const limit = queries.find((q) => q.method === 'limit')?.values?.[0] ?? 25;
        return { status: 200, body: { total, documents: list.slice(0, limit).map((doc) => project(doc, select)) } };
      }
      if (method === 'GET') {
        const doc = docs.get(id);
        return doc ? { status: 200, body: project(doc, select) } : appwriteError(404, 'Document with the requested ID could not be found.', 'document_not_found');
      }
      if (method === 'POST') {
        // Comme Appwrite : un id déjà pris répond 409 (jamais un écrasement).
        if (body?.documentId && docs.has(body.documentId)) {
          return appwriteError(409, 'Document with the requested ID already exists.', 'document_already_exists');
        }
        const doc = putDocument(segments[3], body?.documentId ?? `doc${docs.size + 1}`, body?.data ?? {});
        if (Array.isArray(body?.permissions)) doc.$permissions = body.permissions;
        return { status: 201, body: doc };
      }
      if (method === 'PATCH' || method === 'PUT') {
        const existing = docs.get(id);
        if (!existing && method === 'PATCH') return appwriteError(404, 'Document with the requested ID could not be found.', 'document_not_found');
        const doc = putDocument(segments[3], id, { ...(existing ?? {}), ...(body?.data ?? {}), $updatedAt: now() });
        if (Array.isArray(body?.permissions)) doc.$permissions = body.permissions;
        return { status: 200, body: doc };
      }
      if (method === 'DELETE') {
        if (!docs.delete(id)) return appwriteError(404, 'Document with the requested ID could not be found.', 'document_not_found');
        return { status: 204, body: null };
      }
    }

    // /storage/buckets/{bucket}/files[/{id}[/download|view|preview]]
    if (segments[0] === 'storage' && segments[1] === 'buckets' && segments[3] === 'files') {
      const files = bucket(segments[2]);
      const id = segments[4];
      if (method === 'GET' && !id) {
        const queries = parseQueries(searchParams);
        const list = [...files.values()].map((file) => file.meta).filter((meta) => queries.every((q) => matches(meta, q)));
        const limit = queries.find((q) => q.method === 'limit')?.values?.[0] ?? 25;
        return { status: 200, body: { total: list.length, files: list.slice(0, limit) } };
      }
      const file = id ? files.get(id) : null;
      if (method === 'GET' && segments[5] && file) return { status: 200, body: file.bytes, raw: true };
      if (method === 'GET' && file) return { status: 200, body: file.meta };
      if (method === 'GET') return appwriteError(404, 'The requested file could not be found.', 'storage_file_not_found');
      if (method === 'DELETE') {
        if (!files.delete(id)) return appwriteError(404, 'The requested file could not be found.', 'storage_file_not_found');
        return { status: 204, body: null };
      }
      if (method === 'POST') {
        // Envoi multipart non décodé : les bancs ne relisent pas ce qu'ils écrivent.
        const fileId = body?.fileId ?? `file${files.size + 1}`;
        return { status: 201, body: putFile(segments[2], fileId, Buffer.alloc(0)) };
      }
    }

    if (segments[0] === 'teams' && method === 'GET') return { status: 200, body: { total: 0, teams: [], memberships: [] } };
    return null;
  }

  /** Installe le faux backend sur un contexte Playwright. */
  async function install(context) {
    await context.route(`${base}/**`, async (route) => {
      const request = route.request();
      const cors = {
        'access-control-allow-origin': request.headers().origin ?? '*',
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'X-Fallback-Cookies',
      };
      if (request.method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            ...cors,
            'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
            'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
          },
        });
        return;
      }
      const url = new URL(request.url());
      const path = url.pathname.slice(new URL(base).pathname.length);
      let body = null;
      const contentType = request.headers()['content-type'] ?? '';
      if (contentType.includes('application/json')) {
        try {
          body = JSON.parse(request.postData() ?? 'null');
        } catch {
          body = null;
        }
      } else if (contentType.includes('multipart/form-data')) {
        const fileId = /name="fileId"\r\n\r\n([^\r\n]+)/.exec(request.postData() ?? '')?.[1];
        body = { fileId };
      }
      const startedAt = Date.now();
      const result = handle(request.method(), path, url.searchParams, body)
        ?? (state.unhandled.push(`${request.method()} ${path}`), appwriteError(404, `fake Appwrite: ${request.method()} ${path} non simulé`));
      const payload = result.body === null ? Buffer.alloc(0) : result.raw ? result.body : Buffer.from(JSON.stringify(result.body));
      state.calls.push({ method: request.method(), path, status: result.status, bytes: payload.length, at: startedAt });
      await sleep(transferDelayMs(state.network, payload.length + 400));
      await route.fulfill({
        status: result.status,
        headers: { 'content-type': result.raw ? 'application/octet-stream' : 'application/json', ...cors },
        body: payload,
      });
    });
  }

  return { state, install, putDocument, putFile };
}
