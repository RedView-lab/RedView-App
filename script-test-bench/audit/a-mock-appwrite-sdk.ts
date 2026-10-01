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

export const __mock = {
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
  reset() {
    this.dataMaxChars = 16_000_000;
    this.proxyRejections = 0;
    this.collections.clear();
    this.accountGetMode = 'ok';
    this.accountGetFailures = -1;
    this.dbNetworkDown = false;
    this.updateLatencyQueue = [];
    this.calls = [];
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let idCounter = 0;
let clock = Date.parse('2026-10-01T10:00:00Z');
const nowIso = () => new Date((clock += 1000)).toISOString();

function netCheck(op: string) {
  __mock.calls.push(op);
  if (__mock.dbNetworkDown) throw new TypeError('Failed to fetch');
}

function validate(data: Doc) {
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

export class Client {
  setEndpoint() {
    return this;
  }
  setProject() {
    return this;
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
    const t = nowIso();
    const doc = { ...data, $id: id, $createdAt: t, $updatedAt: t, $permissions: permissions };
    __mock.col(col).set(id, doc);
    return structuredClone(doc);
  }
  async updateDocument(_db: string, col: string, id: string, data: Doc) {
    netCheck(`updateDocument:${col}`);
    const latency = __mock.updateLatencyQueue.shift() ?? 0;
    if (latency) await sleep(latency);
    validate(data);
    const c = __mock.col(col);
    const cur = c.get(id);
    if (!cur) throw new AppwriteException('Document with the requested ID could not be found.', 404, 'document_not_found');
    const next = { ...cur, ...data, $updatedAt: nowIso() };
    c.set(id, next);
    return structuredClone(next);
  }
  async getDocument(_db: string, col: string, id: string) {
    netCheck(`getDocument:${col}`);
    const d = __mock.col(col).get(id);
    if (!d) throw new AppwriteException('Document with the requested ID could not be found.', 404, 'document_not_found');
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
    for (const q of parseQueries(queries)) {
      if (q.method === 'equal') docs = docs.filter((d) => q.values!.includes(d[q.attribute!] ?? null));
      if (q.method === 'limit') limit = q.values![0];
      if (q.method === 'orderDesc') docs.sort((a, b) => String(b[q.attribute!]).localeCompare(String(a[q.attribute!])));
      if (q.method === 'select') select = q.values as string[];
    }
    const total = docs.length;
    let out = docs.slice(0, limit).map((d) => structuredClone(d));
    if (select) {
      out = out.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => select!.includes(k) || k.startsWith('$'))));
    }
    const res = { total, documents: out };
    __mock.lastListResponseBytes = JSON.stringify(res).length;
    return res;
  }
}

export class Storage {}

export const ID = { unique: () => `doc${String(++idCounter).padStart(4, '0')}` };
export const Query = {
  equal: (attribute: string, value: unknown) =>
    JSON.stringify({ method: 'equal', attribute, values: Array.isArray(value) ? value : [value] }),
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
export const Role = { user: (id: string) => `user:${id}`, any: () => 'any', users: () => 'users' };
export const OAuthProvider = { Google: 'google' };
export const ImageFormat = { Webp: 'webp' };
