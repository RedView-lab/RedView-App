/**
 * État de session de la persistance des projets : versions cloud connues,
 * révisions locales, files d'écriture par projet (locale / cloud) et projets
 * dont la charge utile est un fichier du bucket.
 */

/** `$updatedAt` cloud connu par cette session (version chargée ou dernière sauvegarde). */
export const knownCloudVersions = new Map<string, string>();
/**
 * JSON du dernier document dont le cloud a confirmé l'écriture dans cette
 * session : une sauvegarde qui ne change que le travail local (ou rien) n'a
 * pas à réécrire le document.
 */
export const confirmedDocuments = new Map<string, string>();
/** Révision locale par projet : seule la dernière écriture locale peut être marquée propre. */
export const localRevisions = new Map<string, number>();
/**
 * `updated_at` de la dernière copie locale écrite par cet onglet. La copie
 * IndexedDB est commune aux onglets : un onglet ne la marque propre (et ne lui
 * donne sa version cloud) que si elle est encore la sienne.
 */
export const localWriteStamps = new Map<string, string>();
export const localQueues = new Map<string, Promise<unknown>>();
export const cloudQueues = new Map<string, Promise<unknown>>();
/** Projets dont la charge utile cloud est (ou était) un fichier du bucket. */
export const filePayloadProjects = new Set<string>();
/** Projets dont les fichiers de charge utile ont déjà été vérifiés dans cette session. */
export const payloadFilesChecked = new Set<string>();

export function enqueue<T>(queues: Map<string, Promise<unknown>>, id: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

export function rememberCloudVersion(id: string, updatedAt: string | null | undefined): void {
  if (updatedAt) knownCloudVersions.set(id, updatedAt);
}

export function isNewer(candidate: string | null | undefined, reference: string | null | undefined): boolean {
  if (!candidate) return false;
  if (!reference) return true;
  const a = Date.parse(candidate);
  const b = Date.parse(reference);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return candidate !== reference;
  return a > b;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Cloud request timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
