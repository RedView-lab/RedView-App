/**
 * Audit A — faux paquet `appwrite` (SDK web) pour simuler la persistance projet en Node.
 * Substitué à `appwrite` par a-persistence-sim.ts (plugin esbuild). Le VRAI
 * src/shared/services/appwrite.ts et les VRAIS projectRows.ts / folders.ts tournent dessus.
 *
 * Reproduit les comportements Appwrite pertinents :
 *  - attribut `projects.data` limité à 16 000 000 caractères depuis 2026-10-01 (erreur 400
 *    document_invalid_structure ; `dataMaxChars` réglable par scénario, ex. 1 000 000 = ancien schéma)
 *  - nginx devant Appwrite : corps > `proxyMaxChars` → 502 Bad Gateway (accepte ~12 M, 502 à 16 M)
 *  - listDocuments : limite par défaut 25 si aucune Query.limit, filtre equal / orderDesc / select
 *  - erreurs réseau (TypeError 'Failed to fetch') et latences paramétrables
 *  - Storage : bucket en mémoire (createFile, getFile, listFiles par nom, deleteFile) et
 *    téléchargement par client.call (charges utiles des gros projets, payloadFiles.ts)
 *  - écriture conditionnelle d'un document (`PATCH` brut avec `X-Appwrite-Timestamp`) :
 *    409 document_update_conflict si la ligne a changé après l'horodatage, comme le serveur
 *    (utopia-php/database, `withRequestTimestamp`, ligne lue sous verrou)
 *
 * L'état (`__mock`, compteurs d'id et horloge) est global : deux instances du module
 * (deux onglets, chacun son graphe de modules) parlent au même serveur.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export class AppwriteException extends Error {
  code: number;
  type: string;
  constructor(message: string, code: number, type: string) {
    super(message);
    this.code = code;
    this.type = type;
    this.name = 'AppwriteException';
  }
}

type Doc = Record<string, any>;

const sharedState = globalThis as typeof globalThis & {
  __rvMockAppwrite?: typeof mockState;
  __rvMockAppwriteCounters?: { id: number; clock: number };
};

const mockState = {
  collections: new Map<string, Map<string, Doc>>(),
  user: { $id: 'user-A', email: 'a@example.test', name: 'A' } as Doc,
  /** 'ok' | 'network' (TypeError) | 'unauthorized' (401) */
  accountGetMode: 'ok' as 'ok' | 'network' | 'unauthorized',
  /** Nombre d'appels account.get() en échec réseau avant retour à 'ok' (-1 = permanent). */
  accountGetFailures: -1,
  dbNetworkDown: false,
  /** Latences (ms) consommées dans l'ordre par updateDocument. */
  updateLatencyQueue: [] as number[],
  calls: [] as string[],
  lastListQueries: [] as string[],
  lastListResponseBytes: 0,
  dataMaxChars: 16_000_000,
  proxyMaxChars: 14_000_000,
  /** Nombre d'appels createDocument/updateDocument dont le champ data a dépassé le proxy. */
  proxyRejections: 0,
  /** Collections pas (encore) créées côté serveur : 404 collection_not_found. */
  missingCollections: new Set<string>(),
  /** Nombre d'appels account.updatePrefs. */
  prefsUpdates: 0,
  /** Fichiers des buckets (id → contenu). */
  files: new Map<string, { bucket: string; name: string; bytes: Uint8Array; permissions: string[]; $createdAt?: string }>(),
  /** Appelé (une fois) juste avant la prochaine écriture d'un document de `projects` : écriture concurrente d'un autre onglet. */
  beforeProjectWrite: null as (() => Promise<void>) | null,
  reset() {
    this.dataMaxChars = 16_000_000;
    this.proxyRejections = 0;
    this.missingCollections.clear();
    this.prefsUpdates = 0;
    this.files.clear();
    this.user = { $id: 'user-A', email: 'a@example.test', name: 'A', prefs: {} };
    this.collections.clear();
    this.accountGetMode = 'ok';
    this.accountGetFailures = -1;
    this.dbNetworkDown = false;
    this.updateLatencyQueue = [];
    this.calls = [];
    this.beforeProjectWrite = null;
  },
  col(name: string) {
    let c = this.collections.get(name);
    if (!c) {
      c = new Map();
      this.collections.set(name, c);
    }
    return c;
  },
};

export const __mock = (sharedState.__rvMockAppwrite ??= mockState);
const counters = (sharedState.__rvMockAppwriteCounters ??= { id: 0, clock: Date.parse('2026-10-01T10:00:00Z') });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date((counters.clock += 1000)).toISOString();

function netCheck(op: string) {
  __mock.calls.push(op);
  if (__mock.dbNetworkDown) throw new TypeError('Failed to fetch');
  const col = op.split(':')[1];
  if (col && __mock.missingCollections.has(col)) {
    throw new AppwriteException('Collection with the requested ID could not be found.', 404, 'collection_not_found');
  }
}

function validate(data: Doc) {
  // `name` (projets, dossiers) : attribut de 255 caractères, comptés en points de code comme Appwrite.
  if (typeof data.name === 'string' && Array.from(data.name).length > 255) {
    throw new AppwriteException(
      'Invalid document structure: Attribute "name" has invalid format. Value must be a valid string and no longer than 255 chars',
      400,
      'document_invalid_structure',
    );
  }
  if (typeof data.data === 'string' && data.data.length > __mock.proxyMaxChars) {
    __mock.proxyRejections += 1;
    throw new AppwriteException('<html>502 Bad Gateway</html>', 502, '');
  }
  if (typeof data.data === 'string' && data.data.length > __mock.dataMaxChars) {
    throw new AppwriteException(
      `Invalid document structure: Attribute "data" has invalid format. Value must be a valid string and no longer than ${__mock.dataMaxChars} chars`,
      400,
      'document_invalid_structure',
    );
  }
}

/** Mise à jour d'un document ; `timestamp` : écriture conditionnelle (en-tête X-Appwrite-Timestamp). */
async function updateDocumentIn(col: string, id: string, data: Doc, timestamp: string | null) {
  netCheck(`updateDocument:${col}`);
  const latency = __mock.updateLatencyQueue.shift() ?? 0;
  if (latency) await sleep(latency);
  if (col === 'projects' && __mock.beforeProjectWrite) {
    const concurrent = __mock.beforeProjectWrite;
    __mock.beforeProjectWrite = null;
    await concurrent();
  }
  validate(data);
  const c = __mock.col(col);
  const cur = c.get(id);
  if (!cur) throw new AppwriteException('Document with the requested ID could not be found.', 404, 'document_not_found');
  if (timestamp !== null && Date.parse(cur.$updatedAt) > Date.parse(timestamp)) {
    throw new AppwriteException('Remote document is newer than local.', 409, 'document_update_conflict');
  }
  const next = { ...cur, ...data, $updatedAt: nowIso() };
  c.set(id, next);
  return structuredClone(next);
}

export class Client {
  config = { endpoint: 'https://appwrite.mock/v1', project: 'mock' };
  setEndpoint() {
    return this;
  }
  setProject() {
    return this;
  }
  /**
   * Téléchargement d'un fichier de bucket (URL de Storage.getFileDownload / getFileView)
   * et mise à jour brute d'un document (`PATCH`, avec `X-Appwrite-Timestamp` éventuel).
   */
  async call(method: string, url: URL, headers?: Record<string, string>, params?: Doc, responseType?: string) {
    __mock.calls.push(`client.call:${method}`);
    if (__mock.dbNetworkDown) throw new TypeError('Failed to fetch');
    const document = /\/databases\/[^/]+\/collections\/([^/]+)\/documents\/([^/]+)$/.exec(url.pathname);
    if (method === 'patch' && document) {
      const timestamp = headers?.['X-Appwrite-Timestamp'] ?? null;
      return updateDocumentIn(decodeURIComponent(document[1]), decodeURIComponent(document[2]), params?.data ?? {}, timestamp);
    }
    const match = /\/storage\/buckets\/[^/]+\/files\/([^/]+)\/(?:download|view)/.exec(url.pathname);
    const file = match ? __mock.files.get(match[1]) : undefined;
    if (!file) throw new AppwriteException('The requested file could not be found.', 404, 'storage_file_not_found');
    const bytes = file.bytes.slice();
    return responseType === 'arrayBuffer' ? bytes.buffer : bytes;
  }
}

export class Account {
  async get() {
    __mock.calls.push('account.get');
    if (__mock.accountGetMode === 'network') {
      if (__mock.accountGetFailures > 0) {
        __mock.accountGetFailures -= 1;
        if (__mock.accountGetFailures === 0) __mock.accountGetMode = 'ok';
      }
      throw new TypeError('Failed to fetch');
    }
    if (__mock.accountGetMode === 'unauthorized') {
      throw new AppwriteException('User (role: guests) missing scope (account)', 401, 'general_unauthorized_scope');
    }
    return { ...__mock.user };
  }
  async createJWT() {
    return { jwt: 'mock-jwt' };
  }
  async updatePrefs(prefs: Doc) {
    __mock.calls.push('account.updatePrefs');
    if (__mock.dbNetworkDown) throw new TypeError('Failed to fetch');
    __mock.prefsUpdates += 1;
    __mock.user = { ...__mock.user, prefs: structuredClone(prefs) };
    return { ...__mock.user };
  }
  async deleteSession() {
    return {};
  }
}

function parseQueries(queries: string[] = []) {
  return queries.map((q) => JSON.parse(q) as { method: string; attribute?: string; values?: any[] });
}

export class Databases {
  async createDocument(_db: string, col: string, id: string, data: Doc, permissions: string[] = []) {
    netCheck(`createDocument:${col}`);
    validate(data);
    if (__mock.col(col).has(id)) {
      throw new AppwriteException('Document with the requested ID already exists.', 409, 'document_already_exists');
    }
    const t = nowIso();
    const doc = { ...data, $id: id, $createdAt: t, $updatedAt: t, $permissions: permissions };
    __mock.col(col).set(id, doc);
    return structuredClone(doc);
  }
  async updateDocument(_db: string, col: string, id: string, data: Doc) {
    return updateDocumentIn(col, id, data, null);
  }
  async getDocument(_db: string, col: string, id: string, queries: string[] = []) {
    netCheck(`getDocument:${col}`);
    const d = __mock.col(col).get(id);
    if (!d) throw new AppwriteException('Document with the requested ID could not be found.', 404, 'document_not_found');
    const select = parseQueries(queries).find((q) => q.method === 'select')?.values as string[] | undefined;
    if (select) return Object.fromEntries(Object.entries(structuredClone(d)).filter(([k]) => select.includes(k) || k.startsWith('$')));
    return structuredClone(d);
  }
  async deleteDocument(_db: string, col: string, id: string) {
    netCheck(`deleteDocument:${col}`);
    __mock.col(col).delete(id);
    return {};
  }
  async listDocuments(_db: string, col: string, queries: string[] = []) {
    netCheck(`listDocuments:${col}`);
    __mock.lastListQueries = queries;
    let docs = [...__mock.col(col).values()];
    let limit = 25; // défaut Appwrite
    let select: string[] | null = null;
    let cursorAfter: string | null = null;
    for (const q of parseQueries(queries)) {
      if (q.method === 'equal') docs = docs.filter((d) => q.values!.includes(d[q.attribute!] ?? null));
      if (q.method === 'notEqual') docs = docs.filter((d) => !q.values!.includes(d[q.attribute!] ?? null));
      if (q.method === 'limit') limit = q.values![0];
      if (q.method === 'orderDesc') docs.sort((a, b) => String(b[q.attribute!]).localeCompare(String(a[q.attribute!])));
      if (q.method === 'select') select = q.values as string[];
      if (q.method === 'cursorAfter') cursorAfter = q.values![0];
    }
    const total = docs.length;
    if (cursorAfter) {
      const at = docs.findIndex((d) => d.$id === cursorAfter);
      if (at < 0) throw new AppwriteException(`Document '${cursorAfter}' for the 'cursor' value not found.`, 400, 'general_cursor_not_found');
      docs = docs.slice(at + 1);
    }
    let out = docs.slice(0, limit).map((d) => structuredClone(d));
    if (select) {
      out = out.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => select!.includes(k) || k.startsWith('$'))));
    }
    const res = { total, documents: out };
    __mock.lastListResponseBytes = JSON.stringify(res).length;
    return res;
  }
}

export class Storage {
  async createFile(bucket: string, fileId: string, file: File, permissions: string[] = []) {
    netCheck(`createFile:${bucket}`);
    if (__mock.files.has(fileId)) throw new AppwriteException('A storage file with the requested ID already exists.', 409, 'storage_file_already_exists');
    const $createdAt = nowIso();
    __mock.files.set(fileId, { bucket, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), permissions, $createdAt });
    return { $id: fileId, bucketId: bucket, name: file.name, sizeOriginal: file.size, $createdAt };
  }
  async getFile(bucket: string, fileId: string) {
    netCheck(`getFile:${bucket}`);
    const file = __mock.files.get(fileId);
    if (!file || file.bucket !== bucket) throw new AppwriteException('The requested file could not be found.', 404, 'storage_file_not_found');
    return { $id: fileId, bucketId: bucket, name: file.name, sizeOriginal: file.bytes.byteLength, $createdAt: file.$createdAt };
  }
  getFileDownload(bucket: string, fileId: string) {
    return `https://appwrite.mock/v1/storage/buckets/${bucket}/files/${fileId}/download`;
  }
  getFileView(bucket: string, fileId: string) {
    return `https://appwrite.mock/v1/storage/buckets/${bucket}/files/${fileId}/view`;
  }
  async listFiles(bucket: string, queries: string[] = []) {
    netCheck(`listFiles:${bucket}`);
    let files = [...__mock.files.entries()].filter(([, file]) => file.bucket === bucket).map(([id, file]) => ({ $id: id, name: file.name, $createdAt: file.$createdAt }));
    let limit = 25;
    for (const q of parseQueries(queries)) {
      if (q.method === 'equal') files = files.filter((file) => q.values!.includes((file as Doc)[q.attribute!]));
      if (q.method === 'limit') limit = q.values![0];
    }
    return { total: files.length, files: files.slice(0, limit) };
  }
  async deleteFile(bucket: string, fileId: string) {
    netCheck(`deleteFile:${bucket}`);
    if (!__mock.files.delete(fileId)) throw new AppwriteException('The requested file could not be found.', 404, 'storage_file_not_found');
    return {};
  }
}


export const ID = { unique: () => `doc${String(++counters.id).padStart(4, '0')}` };
export const Query = {
  equal: (attribute: string, value: unknown) =>
    JSON.stringify({ method: 'equal', attribute, values: Array.isArray(value) ? value : [value] }),
  notEqual: (attribute: string, value: unknown) =>
    JSON.stringify({ method: 'notEqual', attribute, values: Array.isArray(value) ? value : [value] }),
  limit: (n: number) => JSON.stringify({ method: 'limit', values: [n] }),
  orderDesc: (attribute: string) => JSON.stringify({ method: 'orderDesc', attribute }),
  select: (values: string[]) => JSON.stringify({ method: 'select', values }),
  cursorAfter: (id: string) => JSON.stringify({ method: 'cursorAfter', values: [id] }),
};
export const Permission = {
  read: (r: string) => `read("${r}")`,
  update: (r: string) => `update("${r}")`,
  delete: (r: string) => `delete("${r}")`,
};
export const Role = { user: (id: string) => `user:${id}`, team: (id: string) => `team:${id}`, any: () => 'any', users: () => 'users' };
export const OAuthProvider = { Google: 'google' };
export const ImageFormat = { Webp: 'webp' };
