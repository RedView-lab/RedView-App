// Faux Appwrite minimal du banc de robustesse (même processus que run.mjs) :
// assez pour que les routes authentifiées dépassent la vérification du jeton
// et atteignent leur propre validation. Le jeton `fuzz-jwt` est le compte
// `u1` (vérifié, mot de passe défini) ; tout autre jeton reçoit 401. Les
// lectures répondent vide ou « introuvable », les écritures réussissent.
import http from 'node:http';

export const FUZZ_JWT = 'fuzz-jwt';

const USER = {
  $id: 'u1',
  $createdAt: '2026-01-01T00:00:00.000Z',
  $updatedAt: '2026-01-01T00:00:00.000Z',
  name: 'Fuzz',
  email: 'u1@fuzz.test',
  emailVerification: true,
  status: true,
  passwordUpdate: '2026-01-01T00:00:00.000Z',
  labels: [],
  prefs: {},
};

function appwriteError(res, code, type) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: type, code, type, version: '2.3.0' }));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startFakeAppwrite() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://appwrite');
      const path = url.pathname.replace(/^\/v1/, '');
      const segments = path.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      const now = new Date().toISOString();

      if (path === '/account' && method === 'GET') {
        return req.headers['x-appwrite-jwt'] === FUZZ_JWT ? json(res, 200, USER) : appwriteError(res, 401, 'user_jwt_invalid');
      }
      if (segments[0] === 'account') return appwriteError(res, 400, 'general_argument_invalid');
      if (segments[0] === 'users') {
        if (segments.length === 1) return method === 'GET' ? json(res, 200, { total: 0, users: [] }) : appwriteError(res, 409, 'user_already_exists');
        if (segments[1] !== USER.$id) return appwriteError(res, 404, 'user_not_found');
        if (segments.length === 2 && method === 'GET') return json(res, 200, USER);
        if (segments[2] === 'sessions' || segments[2] === 'memberships' || segments[2] === 'logs') return json(res, 200, { total: 0, [segments[2]]: [] });
        return json(res, 200, USER);
      }
      if (segments[0] === 'databases' && segments[4] === 'documents') {
        if (method === 'GET' && segments[5]) return appwriteError(res, 404, 'document_not_found');
        if (method === 'GET') return json(res, 200, { total: 0, documents: [] });
        if (method === 'POST') return json(res, 201, { $id: `doc${Date.now()}`, $permissions: [], $createdAt: now, $updatedAt: now });
        return appwriteError(res, 404, 'document_not_found');
      }
      if (segments[0] === 'teams') {
        if (segments[2] === 'memberships' && method === 'GET') return json(res, 200, { total: 0, memberships: [] });
        if (method === 'POST' && segments.length === 1) return json(res, 201, { $id: 'team', name: 'team' });
        return appwriteError(res, 404, 'team_not_found');
      }
      if (segments[0] === 'storage') {
        if (method === 'GET' && segments.length === 4) return json(res, 200, { total: 0, files: [] });
        return appwriteError(res, 404, 'storage_file_not_found');
      }
      return appwriteError(res, 404, 'general_route_not_found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}
