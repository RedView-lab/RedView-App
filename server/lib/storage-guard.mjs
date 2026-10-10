// ---------------------------------------------------------------------------
// Garde des buckets Appwrite (A15-3, audit du 2026-10-10).
//
// Les trois buckets que remplit l'app accordent `create("users")` : le
// navigateur y envoie directement miniatures, .fit et charges de gros
// projets. Appwrite ne connaît qu'une taille maximale par fichier et une
// liste d'extensions ; aucun plafond par compte, aucun contrôle du contenu.
// N'importe quel compte pouvait donc remplir le disque du VPS (qui porte
// toute l'infra) à ~1,8 Go/h par IP, avec des octets quelconques nommés
// `x.gz`.
//
// Ce garde tourne dans le serveur de l'app (prod, clé d'API) : toutes les
// `intervalMs`, il relit les fichiers créés depuis son dernier passage et :
//   1. supprime un fichier terminé, créé depuis le démarrage de la garde,
//      dont le contenu n'a pas la signature de son bucket (en-tête FIT, magie
//      gzip, image) ; un fichier plus ancien est seulement signalé (jamais
//      d'effacement du stock existant sur une règle qui n'existait pas) ;
//   2. tient à jour l'occupation de chaque compte (propriétaire = rôle
//      `user:<id>` de la permission `delete`, comme partout ailleurs) et,
//      au-delà de `perUserBytes`, supprime les fichiers NEUFS du compte, du
//      plus récent au plus ancien, jusqu'à repasser sous le plafond — jamais
//      un fichier qui existait avant le passage précédent, ni la charge la plus
//      récente d'un projet (bucket des charges : la dernière sauvegarde) ;
//   3. signale chaque suppression à GlitchTip (identifiants et tailles
//      seulement, jamais un nom de fichier : données personnelles).
// L'occupation complète est recalculée au démarrage et toutes les
// `fullScanEveryMs` (le reste du temps : incrémentale).
//
// Un fichier sans propriétaire utilisateur (instantanés du serveur temps
// réel, écrits avec la clé d'administration) n'est jamais touché. Un envoi
// par morceaux pas encore terminé est laissé tranquille pendant
// `incompleteGraceMs`, puis supprimé s'il n'a pas avancé (morceaux
// abandonnés qui occupent le disque).
// ---------------------------------------------------------------------------

import { Query } from 'node-appwrite';

/** Buckets gardés et forme attendue de leur contenu. */
export const GUARDED_BUCKETS = Object.freeze([
  { id: 'project-thumbnails', kind: 'image' },
  { id: 'itinerary-fit-files', kind: 'fit' },
  { id: 'project-payloads', kind: 'gzip' },
]);

export const STORAGE_GUARD_DEFAULTS = Object.freeze({
  intervalMs: 5 * 60_000,
  fullScanEveryMs: 6 * 60 * 60_000,
  /** Un très gros utilisateur légitime : ~50 projets de 100 Mo (charges ≤ 30 Mo) + ses .fit. */
  perUserBytes: 2 * 1024 ** 3,
  incompleteGraceMs: 60 * 60_000,
  /** Recouvrement de la fenêtre incrémentale : horloges et écritures en cours. */
  overlapMs: 60_000,
});

const SIGNATURE_BYTES = 16;

/** Vrai si `head` (premiers octets) a la signature attendue pour `kind`. */
export function hasExpectedSignature(kind, head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head ?? []);
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  switch (kind) {
    case 'gzip':
      return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
    case 'fit':
      // En-tête FIT : taille 12 ou 14, puis « .FIT » aux octets 8–11.
      return b.length >= 12 && (b[0] === 12 || b[0] === 14) && ascii(8, 12) === '.FIT';
    case 'image':
      return (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG')
        || (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        || (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'))
        || (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP');
    default:
      return false;
  }
}

/** Propriétaire utilisateur d'un fichier (rôle de la permission `delete`), ou null. */
export function fileOwnerId(file) {
  const permissions = Array.isArray(file?.$permissions) ? file.$permissions : [];
  for (const entry of permissions) {
    const match = /^delete\("user:([A-Za-z0-9][A-Za-z0-9._-]{0,35})"\)$/.exec(entry);
    if (match) return match[1];
  }
  return null;
}

function isComplete(file) {
  const total = Number(file?.chunksTotal ?? 1);
  const uploaded = Number(file?.chunksUploaded ?? total);
  return uploaded >= total;
}

/**
 * Fichiers à supprimer pour ramener chaque compte sous son plafond : les
 * fichiers neufs (`freshIds`) du compte, du plus récent au plus ancien, tant
 * que l'occupation dépasse `perUserBytes`. Fonction pure.
 * La charge la plus récente de chaque projet (bucket `project-payloads`,
 * un nom de fichier par projet) n'est jamais retirée : c'est sa dernière
 * sauvegarde.
 *
 * @param {Map<string, Map<string, { size: number, createdAt: number, bucketId: string, name?: string }>>} usage
 * @param {Set<string>} freshKeys  clés `bucket/fileId` des fichiers de ce passage
 * @param {number} perUserBytes
 * @returns {{ userId: string, bucketId: string, fileId: string, size: number }[]}
 */
export function planQuotaEvictions(usage, freshKeys, perUserBytes) {
  const evictions = [];
  for (const [userId, files] of usage) {
    let total = 0;
    for (const entry of files.values()) total += entry.size;
    if (total <= perUserBytes) continue;
    const newestPayloadByName = new Map();
    for (const [key, entry] of files) {
      if (entry.bucketId !== 'project-payloads' || !entry.name) continue;
      const current = newestPayloadByName.get(entry.name);
      if (!current || files.get(current).createdAt < entry.createdAt) newestPayloadByName.set(entry.name, key);
    }
    const protectedKeys = new Set(newestPayloadByName.values());
    const fresh = [...files.entries()]
      .filter(([key]) => freshKeys.has(key) && !protectedKeys.has(key))
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
    for (const [key, entry] of fresh) {
      if (total <= perUserBytes) break;
      total -= entry.size;
      evictions.push({ userId, bucketId: entry.bucketId, fileId: key.slice(entry.bucketId.length + 1), size: entry.size });
    }
  }
  return evictions;
}

/**
 * @param {{
 *   listFiles: (bucketId: string, sinceIso: string | null, cursor: string | null) => Promise<{ files: any[] }>,
 *   getFile: (bucketId: string, fileId: string) => Promise<any | null>,
 *   readHead: (bucketId: string, fileId: string, bytes: number) => Promise<Uint8Array>,
 *   deleteFile: (bucketId: string, fileId: string) => Promise<void>,
 *   report: (error: Error, extra?: Record<string, unknown>) => void,
 *   now?: () => number,
 *   log?: (message: string) => void,
 *   enforce?: boolean,
 *   options?: Partial<typeof STORAGE_GUARD_DEFAULTS>,
 * }} deps
 */
export function createStorageGuard(deps) {
  const options = { ...STORAGE_GUARD_DEFAULTS, ...(deps.options ?? {}) };
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  // Faux : tout est signalé, rien n'est supprimé (premier déploiement, diagnostic).
  const enforce = deps.enforce ?? true;
  /** userId → (`bucket/fileId` → taille, date, bucket) */
  let usage = new Map();
  /** Fichiers déjà contrôlés (contenu) : un fichier n'est lu qu'une fois. */
  const checked = new Set();
  /** Envois par morceaux inachevés : progression vue au premier passage. */
  const incomplete = new Map();
  let lastScanAt = null;
  let lastFullScanAt = 0;
  let running = false;
  /** Démarrage de la garde : seuls les fichiers créés depuis peuvent être effacés pour leur contenu. */
  let guardStartedAt = null;

  async function listAll(bucketId, sinceIso) {
    const out = [];
    let cursor = null;
    for (;;) {
      const page = await deps.listFiles(bucketId, sinceIso, cursor);
      const files = Array.isArray(page?.files) ? page.files : [];
      out.push(...files);
      if (files.length < 100) return out;
      cursor = files[files.length - 1].$id;
    }
  }

  async function remove(bucketId, file, reason, extra = {}) {
    const owner = fileOwnerId(file);
    if (!enforce) {
      deps.report(new Error(`Storage guard would remove a file (${reason})`), {
        bucketId, fileId: file.$id, ownerId: owner, size: Number(file.sizeOriginal ?? 0), reason, ...extra,
      });
      return false;
    }
    try {
      await deps.deleteFile(bucketId, file.$id);
    } catch (error) {
      if (Number(error?.code) !== 404) {
        deps.report(error instanceof Error ? error : new Error(String(error)), { bucketId, fileId: file.$id, reason });
        return false;
      }
    }
    usage.get(owner)?.delete(`${bucketId}/${file.$id}`);
    checked.delete(`${bucketId}/${file.$id}`);
    deps.report(new Error(`Storage guard removed a file (${reason})`), {
      bucketId, fileId: file.$id, ownerId: owner, size: Number(file.sizeOriginal ?? 0), reason, ...extra,
    });
    return true;
  }

  /** Un passage ; renvoie le nombre de fichiers supprimés. */
  async function runOnce() {
    if (running) return 0;
    running = true;
    let removed = 0;
    try {
      const startedAt = now();
      if (guardStartedAt === null) guardStartedAt = startedAt;
      const full = lastScanAt === null || startedAt - lastFullScanAt >= options.fullScanEveryMs;
      const listedKeys = new Set();
      const sinceIso = full ? null : new Date(lastScanAt - options.overlapMs).toISOString();
      const nextUsage = full ? new Map() : usage;
      const freshKeys = new Set();
      const isFirstScan = lastScanAt === null;

      for (const bucket of GUARDED_BUCKETS) {
        const files = await listAll(bucket.id, sinceIso);
        // Envois inachevés plus anciens que la fenêtre incrémentale : relus un par un.
        const listed = new Set(files.map((file) => `${bucket.id}/${file.$id}`));
        for (const key of [...incomplete.keys()]) {
          if (!key.startsWith(`${bucket.id}/`) || listed.has(key)) continue;
          const file = await deps.getFile(bucket.id, key.slice(bucket.id.length + 1)).catch(() => undefined);
          if (file === null) incomplete.delete(key);
          else if (file) files.push(file);
        }
        for (const file of files) {
          const owner = fileOwnerId(file);
          if (!owner) continue;
          const key = `${bucket.id}/${file.$id}`;
          listedKeys.add(key);
          const createdAt = Date.parse(file.$createdAt) || startedAt;
          const isFresh = !isFirstScan && (lastScanAt === null || createdAt >= lastScanAt - options.overlapMs);

          if (!isComplete(file)) {
            const progress = Number(file.chunksUploaded ?? 0);
            const seen = incomplete.get(key);
            if (!seen || seen.progress !== progress) {
              incomplete.set(key, { progress, since: startedAt });
            } else if (startedAt - seen.since >= options.incompleteGraceMs) {
              incomplete.delete(key);
              if (await remove(bucket.id, file, 'abandoned-chunks')) removed += 1;
              continue;
            }
          } else {
            incomplete.delete(key);
            if (!checked.has(key)) {
              let head;
              try {
                head = await deps.readHead(bucket.id, file.$id, SIGNATURE_BYTES);
              } catch (error) {
                // Lecture impossible (réseau) : contrôlé au passage suivant.
                log(`[storage-guard] head ${key} failed: ${error?.message ?? error}`);
                head = null;
              }
              if (head) {
                checked.add(key);
                if (!hasExpectedSignature(bucket.kind, head)) {
                  if (createdAt >= guardStartedAt) {
                    if (await remove(bucket.id, file, 'bad-content', { kind: bucket.kind })) removed += 1;
                    continue;
                  }
                  deps.report(new Error('Storage guard: existing file with unexpected content (kept)'), {
                    bucketId: bucket.id, fileId: file.$id, ownerId: owner, size: Number(file.sizeOriginal ?? 0), reason: 'bad-content-existing', kind: bucket.kind,
                  });
                }
              }
            }
          }

          let files0 = nextUsage.get(owner);
          if (!files0) nextUsage.set(owner, (files0 = new Map()));
          files0.set(key, { size: Number(file.sizeOriginal ?? 0), createdAt, bucketId: bucket.id, name: String(file.name ?? '') });
          if (isFresh) freshKeys.add(key);
        }
      }
      usage = nextUsage;
      // Passage complet : les fichiers disparus quittent la mémoire de la garde
      // (bornée par le nombre de fichiers des buckets).
      if (full) {
        for (const key of checked) if (!listedKeys.has(key)) checked.delete(key);
        for (const key of incomplete.keys()) if (!listedKeys.has(key)) incomplete.delete(key);
      }

      for (const eviction of planQuotaEvictions(usage, freshKeys, options.perUserBytes)) {
        const file = { $id: eviction.fileId, $permissions: [`delete("user:${eviction.userId}")`], sizeOriginal: eviction.size };
        if (await remove(eviction.bucketId, file, 'over-quota', { perUserBytes: options.perUserBytes })) removed += 1;
      }

      // Comptes au-dessus du plafond sans fichier neuf à retirer (premier
      // passage, ou déjà là avant le garde) : signalés à chaque passage complet.
      if (full) {
        for (const [userId, files] of usage) {
          let total = 0;
          for (const entry of files.values()) total += entry.size;
          if (total > options.perUserBytes) {
            deps.report(new Error('Storage guard: account over quota'), { ownerId: userId, bytes: total, perUserBytes: options.perUserBytes, reason: 'over-quota-existing' });
          }
        }
      }

      lastScanAt = startedAt;
      if (full) lastFullScanAt = startedAt;
      return removed;
    } finally {
      running = false;
    }
  }

  let timer = null;
  return {
    runOnce,
    /** Occupation connue d'un compte, en octets (tests, diagnostic). */
    usageOf(userId) {
      let total = 0;
      for (const entry of usage.get(userId)?.values() ?? []) total += entry.size;
      return total;
    },
    start() {
      if (timer) return;
      const tick = () => {
        runOnce().catch((error) => deps.report(error instanceof Error ? error : new Error(String(error)), { reason: 'scan-failed' }));
      };
      tick();
      timer = setInterval(tick, options.intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * Garde branché sur Appwrite (REST + clé d'API). Démarré par server.mjs en
 * production seulement, quand la clé est là et `REDVIEW_STORAGE_GUARD` n'est
 * pas `off`.
 * @param {{ endpoint: string, projectId: string, apiKey: string, enforce?: boolean, report: (error: Error, extra?: Record<string, unknown>) => void, log?: (message: string) => void }} config
 */
export function createAppwriteStorageGuard({ endpoint, projectId, apiKey, enforce, report, log }) {
  const base = endpoint.replace(/\/+$/, '');
  const headers = { 'X-Appwrite-Project': projectId, 'X-Appwrite-Key': apiKey };
  const request = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok && response.status !== 206) {
      const error = new Error(`Appwrite ${init.method ?? 'GET'} ${path.split('?')[0]} → HTTP ${response.status}`);
      error.code = response.status;
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    return response;
  };
  return createStorageGuard({
    report,
    log,
    enforce,
    async getFile(bucketId, fileId) {
      try {
        const response = await request(`/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}`);
        return response.json();
      } catch (error) {
        if (error?.code === 404) return null;
        throw error;
      }
    },
    async listFiles(bucketId, sinceIso, cursor) {
      const queries = [
        Query.limit(100),
        ...(sinceIso ? [Query.greaterThanEqual('$createdAt', sinceIso)] : []),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ];
      const search = queries.map((query) => `queries[]=${encodeURIComponent(query)}`).join('&');
      const response = await request(`/storage/buckets/${encodeURIComponent(bucketId)}/files?${search}`);
      return response.json();
    },
    async readHead(bucketId, fileId, bytes) {
      const response = await request(
        `/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}/download`,
        { headers: { Range: `bytes=0-${bytes - 1}` } },
      );
      // Sans prise en charge de Range, seuls les premiers octets sont lus.
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (length < bytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        length += value.length;
      }
      await reader.cancel().catch(() => {});
      const head = new Uint8Array(Math.min(length, bytes));
      let offset = 0;
      for (const chunk of chunks) {
        const part = chunk.subarray(0, head.length - offset);
        head.set(part, offset);
        offset += part.length;
        if (offset >= head.length) break;
      }
      return head;
    },
    async deleteFile(bucketId, fileId) {
      await request(`/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    },
  });
}
