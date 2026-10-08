/**
 * Faux Appwrite HTTP du banc d'entrée dans une salle (processus enfant de
 * run.ts) : les routes que le serveur temps réel appelle avec le vrai
 * `node-appwrite` — compte par JWT, documents (`projects`,
 * `project_journal` : lecture avec `Query.select`, listes filtrées et
 * paginées, création avec conflit 409, mise à jour, suppression),
 * appartenances d'équipe, fichiers du bucket (création multipart, fiche,
 * téléchargement, liste par nom, suppression).
 *
 * Chaque appel attend une latence tirée d'une loi log-normale (`p50`, `p95`
 * en ms) : celle qu'Appwrite montre sous charge (rapport vps-load,
 * `aw.serveur.*` : p50 ≈ 120–190 ms, p95 ≈ 550–650 ms à 100 utilisateurs).
 * Les JWT sont signés (HMAC) par le banc et vérifiés ici ; un jeton faux ou
 * expiré reçoit 401 comme chez Appwrite.
 *
 * Pilotage (sans latence) : `POST /_bench/seed` (projets, équipes),
 * `POST /_bench/latency` ({ p50, p95 }), `GET /_bench/stats` (appels par
 * route). Le port est envoyé au parent par IPC (`ready`).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Doc {
  $id: string;
  $permissions: string[];
  $createdAt: string;
  $updatedAt: string;
  [key: string]: unknown;
}

interface StoredFile {
  name: string;
  bytes: Buffer;
  permissions: string[];
}

export interface SeedProject {
  id: string;
  ownerId: string;
  members: string[];
  data: string;
}

const secret = process.env.FAKE_APPWRITE_JWT_SECRET ?? 'banc';
let latency = { p50: Number(process.env.FAKE_APPWRITE_P50 ?? 0), p95: Number(process.env.FAKE_APPWRITE_P95 ?? 0) };

const collections = new Map<string, Map<string, Doc>>();
const teams = new Map<string, Map<string, string[]>>();
const files = new Map<string, StoredFile>();
const stats = new Map<string, number>();

function collection(id: string): Map<string, Doc> {
  let docs = collections.get(id);
  if (!docs) {
    docs = new Map();
    collections.set(id, docs);
  }
  return docs;
}

/** Latence d'un appel : log-normale de médiane p50 et de 95e centile p95. */
function sampleLatency(): number {
  if (latency.p50 <= 0) return 0;
  const sigma = latency.p95 > latency.p50 ? Math.log(latency.p95 / latency.p50) / 1.645 : 0;
  // Box-Muller.
  const u = 1 - Math.random();
  const v = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return latency.p50 * Math.exp(sigma * normal);
}

class HttpError extends Error {
  readonly status: number;
  readonly type: string;

  constructor(status: number, type: string, message = type) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

interface Query {
  method: string;
  attribute?: string;
  values?: unknown[];
}

function parseQueries(url: URL): Query[] {
  const out: Query[] = [];
  for (const [key, value] of url.searchParams) if (key.startsWith('queries[')) out.push(JSON.parse(value) as Query);
  return out;
}

function matches(doc: Record<string, unknown>, query: Query): boolean {
  const value = query.attribute ? doc[query.attribute] : undefined;
  switch (query.method) {
    case 'equal': return (query.values ?? []).includes(value);
    case 'greaterThan': return (value as number) > (query.values![0] as number);
    case 'lessThanEqual': return (value as number) <= (query.values![0] as number);
    default: return true;
  }
}

function selected(doc: Doc, queries: Query[]): Record<string, unknown> {
  const select = queries.find((query) => query.method === 'select')?.values as string[] | undefined;
  if (!select) return doc;
  return Object.fromEntries(Object.entries(doc).filter(([key]) => key === '$id' || select.includes(key)));
}

function listOf<T>(items: T[], queries: Query[], idOf: (item: T) => string): T[] {
  let out = items;
  const order = queries.find((query) => query.method === 'orderAsc');
  if (order) out = [...out].sort((a, b) => ((a as Record<string, number>)[order.attribute!] ?? 0) - ((b as Record<string, number>)[order.attribute!] ?? 0));
  const cursor = queries.find((query) => query.method === 'cursorAfter');
  if (cursor) out = out.slice(out.findIndex((item) => idOf(item) === cursor.values![0]) + 1);
  const limit = queries.find((query) => query.method === 'limit');
  return out.slice(0, (limit?.values?.[0] as number) ?? 25);
}

/** JWT du banc : `en-tête.charge.signature`, signature = HMAC-SHA256 base64url de `en-tête.charge`. */
function verifyJwt(token: string | undefined): { userId: string } {
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) throw new HttpError(401, 'user_jwt_invalid');
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'user_jwt_invalid');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { userId: string; exp: number };
  if (payload.exp * 1000 < Date.now()) throw new HttpError(401, 'user_jwt_invalid');
  return payload;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

type Reply = { status: number; json?: unknown; bytes?: Buffer };

async function route(req: http.IncomingMessage, url: URL): Promise<Reply> {
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/^\/v1/, '');
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  const queries = parseQueries(url);
  const now = new Date().toISOString();

  if (segments[0] === 'account' && segments.length === 1 && method === 'GET') {
    const { userId } = verifyJwt(req.headers['x-appwrite-jwt'] as string | undefined);
    return { status: 200, json: { $id: userId, name: `Banc ${userId}`, email: `${userId}@banc.test` } };
  }

  // /databases/{db}/collections/{col}/documents[/{id}]
  if (segments[0] === 'databases' && segments[2] === 'collections' && segments[4] === 'documents') {
    const docs = collection(segments[3]);
    const id = segments[5];
    if (method === 'GET' && id) {
      const doc = docs.get(id);
      if (!doc) throw new HttpError(404, 'document_not_found');
      return { status: 200, json: selected(doc, queries) };
    }
    if (method === 'GET') {
      const filtered = [...docs.values()].filter((doc) => queries.every((query) => matches(doc, query)));
      const documents = listOf(filtered, queries, (doc) => doc.$id).map((doc) => selected(doc, queries));
      return { status: 200, json: { total: documents.length, documents } };
    }
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as { documentId?: string; data?: Record<string, unknown>; permissions?: string[] };
    if (method === 'POST') {
      const newId = body.documentId!;
      if (docs.has(newId)) throw new HttpError(409, 'document_already_exists');
      const doc: Doc = { ...body.data, $id: newId, $permissions: body.permissions ?? [], $createdAt: now, $updatedAt: now };
      docs.set(newId, doc);
      return { status: 201, json: doc };
    }
    if (method === 'PATCH') {
      const doc = docs.get(id);
      if (!doc) throw new HttpError(404, 'document_not_found');
      Object.assign(doc, body.data, { $updatedAt: now });
      if (body.permissions) doc.$permissions = body.permissions;
      return { status: 200, json: doc };
    }
    if (method === 'DELETE') {
      if (!docs.delete(id)) throw new HttpError(404, 'document_not_found');
      return { status: 204 };
    }
  }

  // /teams/{teamId}/memberships
  if (segments[0] === 'teams' && segments[2] === 'memberships' && method === 'GET') {
    const team = teams.get(segments[1]);
    if (!team) throw new HttpError(404, 'team_not_found');
    const memberships = [...team].map(([userId, roles]) => ({ $id: `m-${userId}`, userId, roles, confirm: true, teamId: segments[1] }))
      .filter((membership) => queries.every((query) => matches(membership, query)));
    return { status: 200, json: { total: memberships.length, memberships: listOf(memberships, queries, (m) => m.$id) } };
  }

  // /storage/buckets/{bucket}/files[/{id}[/download]]
  if (segments[0] === 'storage' && segments[3] === 'files') {
    const fileId = segments[4];
    if (method === 'POST' && !fileId) {
      const form = await new Request('http://banc/upload', {
        method: 'POST',
        headers: { 'content-type': String(req.headers['content-type']) },
        body: new Uint8Array(await readBody(req)),
      }).formData();
      const file = form.get('file') as File;
      const requested = String(form.get('fileId') ?? 'unique()');
      const newId = requested === 'unique()' ? randomBytes(10).toString('hex') : requested;
      files.set(newId, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()), permissions: form.getAll('permissions[]').map(String) });
      return { status: 201, json: { $id: newId, name: file.name, $permissions: form.getAll('permissions[]').map(String), sizeOriginal: file.size } };
    }
    if (method === 'GET' && !fileId) {
      const list = [...files].map(([$id, file]) => ({ $id, name: file.name, $permissions: file.permissions }))
        .filter((file) => queries.every((query) => matches(file, query)));
      return { status: 200, json: { total: list.length, files: listOf(list, queries, (file) => file.$id) } };
    }
    const file = files.get(fileId);
    if (!file) throw new HttpError(404, 'storage_file_not_found');
    if (method === 'GET' && segments[5] === 'download') return { status: 200, bytes: file.bytes };
    if (method === 'GET') return { status: 200, json: { $id: fileId, name: file.name, $permissions: file.permissions, sizeOriginal: file.bytes.length } };
    if (method === 'DELETE') {
      files.delete(fileId);
      return { status: 204 };
    }
  }
  throw new HttpError(404, 'general_route_not_found', `${method} ${path}`);
}

function seed(projects: SeedProject[]): void {
  const docs = collection('projects');
  const now = new Date().toISOString();
  for (const project of projects) {
    const owner = `user:${project.ownerId}`;
    const teamId = `p${project.id}`;
    docs.set(project.id, {
      $id: project.id,
      $permissions: [`read("${owner}")`, `update("${owner}")`, `delete("${owner}")`, `read("team:${teamId}")`],
      $createdAt: now,
      $updatedAt: now,
      user_id: project.ownerId,
      name: `Banc ${project.id}`,
      data: project.data,
      team_id: teamId,
    });
    teams.set(teamId, new Map([[project.ownerId, ['owner']], ...project.members.map((member): [string, string[]] => [member, ['editor']])]));
  }
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://banc');
    if (url.pathname.startsWith('/_bench/')) {
      if (url.pathname === '/_bench/seed') seed(JSON.parse((await readBody(req)).toString('utf8')) as SeedProject[]);
      else if (url.pathname === '/_bench/latency') latency = JSON.parse((await readBody(req)).toString('utf8')) as typeof latency;
      else if (url.pathname === '/_bench/stats') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Object.fromEntries(stats)));
        return;
      }
      res.writeHead(204).end();
      return;
    }
    const key = `${req.method} ${url.pathname.replace(/^\/v1/, '').replace(/\/(banc|u|p|file)?[0-9a-z]*\d[0-9a-z_]*(?=\/|$)/g, '/:id')}`;
    stats.set(key, (stats.get(key) ?? 0) + 1);
    const wait = sampleLatency();
    let reply: Reply;
    try {
      reply = await route(req, url);
    } catch (error) {
      reply = error instanceof HttpError
        ? { status: error.status, json: { message: error.message, code: error.status, type: error.type } }
        : { status: 500, json: { message: String(error), code: 500, type: 'general_unknown' } };
    }
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (reply.bytes) {
      res.writeHead(reply.status, { 'content-type': 'application/octet-stream', 'content-length': reply.bytes.length }).end(reply.bytes);
    } else if (reply.json !== undefined) {
      const body = JSON.stringify(reply.json);
      res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
    } else {
      res.writeHead(reply.status).end();
    }
  })().catch((error: unknown) => {
    res.writeHead(500).end(String(error));
  });
});
server.keepAliveTimeout = 30_000;
server.listen(0, '127.0.0.1', () => {
  process.send?.({ type: 'ready', port: (server.address() as AddressInfo).port });
});
process.on('disconnect', () => process.exit(0));
