/**
 * Vue de chaque utilisateur sur un projet (couche « vue » de
 * `lib/project/layers.ts` : itinéraire et mode actifs, panneaux, vue carte,
 * panneau de droite, graphe, affichage des itinéraires).
 *
 * Stockée à part du document partagé, donc sans version ni conflit :
 *  - copie locale IndexedDB (store `views`), écrite presque tout de suite ;
 *  - document cloud `project_views` (un par projet et par utilisateur, id
 *    dérivé des deux), écrit après une pause des modifications (au plus
 *    toutes les CLOUD_WRITE_MAX_WAIT_MS) et à la fermeture du projet.
 * Dernière écriture gagnante, départagée par `updatedAt` à la lecture : un
 * déplacement de carte ou un panneau replié ne réécrit jamais le projet.
 * Sauf le lu / non lu des commentaires (`commentsView.reads`), fusionné fil
 * par fil à l'écriture et à la lecture (`mergeViewReads`) : un appareil resté
 * ouvert sur une vue ancienne remettait « non lus » les fils lus ailleurs.
 *
 * Collection absente (pas encore créée côté serveur) : la vue reste locale,
 * signalée une fois dans la console, sans rien bloquer.
 */
import type { ProjectViewState } from '@/features/itineraryPanel/lib/project/layers';
import { logger } from '@/shared/lib/logger';
import {
  APPWRITE_DATABASE_ID,
  databases,
  Permission,
  PROJECT_VIEWS_COLLECTION_ID,
  Role,
} from '@/shared/services/appwrite';
import {
  idbDeleteProjectView,
  idbGetProjectView,
  idbSaveProjectView,
  type IdbProjectViewEntry,
} from '@/shared/services/storage/idbProjectStore';

import { loadAccessQueries } from './access';
import { getCachedCurrentUserIdSync, isLocalFallbackUser } from './auth';
import { enqueue, withTimeout } from './projectSession';
import type { CloudViewDoc } from './accessQueries';

export type StoredProjectView = IdbProjectViewEntry;

const LOCAL_WRITE_DELAY_MS = 250;
const CLOUD_WRITE_DELAY_MS = 4_000;
const CLOUD_WRITE_MAX_WAIT_MS = 20_000;
const CLOUD_RETRY_DELAY_MS = 30_000;
const CLOUD_READ_TIMEOUT_MS = 6_000;
/** Longueur max. du JSON d'une vue (attribut `project_views.data`). */
export const MAX_PROJECT_VIEW_CHARS = 1_000_000;

/** Propriétaire « anonyme » de getCachedCurrentUserIdSync : rien n'est stocké. */
const ANONYMOUS_OWNER = 'anonymous';

interface PendingView {
  record: StoredProjectView;
  /** Vue d'amorçage (migration) : ne remplace jamais une vue cloud existante. */
  createOnly: boolean;
  localWritten: boolean;
  cloudWritten: boolean;
  localTimer: ReturnType<typeof setTimeout> | null;
  cloudTimer: ReturnType<typeof setTimeout> | null;
  firstQueuedAt: number;
}

const pendingViews = new Map<string, PendingView>();
const cloudViewQueues = new Map<string, Promise<unknown>>();
/** JSON de la dernière vue connue (lue ou enregistrée), par `${ownerId}:${projectId}`. */
const lastKnownViews = new Map<string, string>();
/**
 * Mon document de vue cloud, par `${ownerId}:${projectId}` : son id (trouvé à
 * la lecture ou écrit ici), null s'il n'existe pas, pas d'entrée si on ne sait
 * pas (lecture échouée, projet tout juste créé). Une écriture va droit au bon
 * appel : un `updateDocument` à l'aveugle répondait 404 à chaque projet encore
 * sans vue, en rouge dans la console, avant le `createDocument`.
 */
const cloudViewIds = new Map<string, string | null>();
let cloudViewsUnavailable = false;

function viewKey(ownerId: string, projectId: string): string {
  return `${ownerId}:${projectId}`;
}

function isCloudless(projectId: string, ownerId: string): boolean {
  return isLocalFallbackUser(ownerId) || projectId.startsWith('local-');
}

/** Hachage 53 bits déterministe (cyrb53) : même id de document sur tous les appareils. */
function hash53(value: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Id du document `project_views` d'un utilisateur sur un projet (≤ 36 car., [a-z0-9]). */
export function projectViewDocumentId(projectId: string, userId: string): string {
  const key = `${projectId}:${userId}`;
  return `pv${hash53(key, 1).toString(16).padStart(14, '0')}${hash53(key, 2).toString(16).padStart(14, '0')}`;
}

function errorCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
}

function errorType(error: unknown): string {
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : '';
}

/** 404 dû à la collection ou à la base absente (et non au document). */
function isMissingCollection(error: unknown): boolean {
  if (errorCode(error) !== 404) return false;
  const type = errorType(error);
  return type === 'collection_not_found' || type === 'database_not_found';
}

function markCloudViewsUnavailable(error: unknown): void {
  if (cloudViewsUnavailable) return;
  cloudViewsUnavailable = true;
  logger.projects.warn(
    `Collection Appwrite « ${PROJECT_VIEWS_COLLECTION_ID} » introuvable : la vue des projets reste sur cet appareil (scripts/appwrite/setup-appwrite-schema.mjs)`,
    error,
  );
}

function isNewerRecord(candidate: StoredProjectView | null, reference: StoredProjectView | null): boolean {
  if (!candidate) return false;
  if (!reference) return true;
  return Date.parse(candidate.updatedAt) > Date.parse(reference.updatedAt);
}

type CommentReads = NonNullable<NonNullable<ProjectViewState['commentsView']>['reads']>;

/**
 * Repères de lecture de `own`, complétés par ceux de `other` : un fil absent
 * de `own`, ou lu plus loin dans `other` (date du dernier message vu plus
 * récente), prend le repère de `other`. Sinon `own` gagne, « marqué non lu »
 * compris (ce repère n'a pas de date). `own` tel quel si rien ne change.
 */
function mergeReads(own: CommentReads | undefined, other: CommentReads | undefined): CommentReads | undefined {
  if (!other) return own;
  let merged: CommentReads | undefined;
  for (const [threadId, mark] of Object.entries(other)) {
    const current = own?.[threadId];
    const otherIsFurther = !current || (current.t !== undefined && mark.t !== undefined && mark.t > current.t);
    if (!otherIsFurther) continue;
    merged ??= { ...own };
    merged[threadId] = mark;
  }
  return merged ?? own;
}

/** `view` avec les repères de lecture de `other` fusionnés (la même vue si rien ne change). */
function mergeViewReads(view: ProjectViewState, other: ProjectViewState | undefined): ProjectViewState {
  const reads = mergeReads(view.commentsView?.reads, other?.commentsView?.reads);
  if (reads === view.commentsView?.reads) return view;
  return { ...view, commentsView: { ...view.commentsView, reads } };
}

function parseCloudView(doc: { data?: unknown; project_id?: unknown; user_id?: unknown }, projectId: string, ownerId: string): StoredProjectView | null {
  if (typeof doc.data !== 'string') return null;
  try {
    const parsed = JSON.parse(doc.data) as { updatedAt?: unknown; view?: unknown };
    if (typeof parsed.updatedAt !== 'string' || !parsed.view || typeof parsed.view !== 'object') return null;
    const view = parsed.view as ProjectViewState;
    if (!view.itineraries || typeof view.itineraries !== 'object') view.itineraries = {};
    return { projectId, ownerId, updatedAt: parsed.updatedAt, view };
  } catch {
    return null;
  }
}

/**
 * Mon document de vue d'un projet, retrouvé par requête (`project_id` +
 * `user_id`, gardé seulement s'il est bien à moi : `isOwnDocument`) — à l'id
 * déterministe, ou ailleurs si un collaborateur a pris cet id
 * (accessQueries.ts). Une liste vide répond 200 : un `getDocument` sur l'id
 * déterministe répondait 404 à chaque projet encore sans vue.
 */
async function findOwnCloudView(projectId: string, ownerId: string): Promise<CloudViewDoc | null> {
  const doc = await (await loadAccessQueries()).listOwnCloudView(projectId, ownerId);
  const key = viewKey(ownerId, projectId);
  if (doc) cloudViewIds.set(key, doc.$id);
  // Un id écrit entre-temps par cette session (écriture en cours) reste le bon.
  else if (!cloudViewIds.has(key)) cloudViewIds.set(key, null);
  return doc;
}

/** JSON envoyé au cloud ; null (journalisé) au-delà de la taille de l'attribut. */
function serializeCloudView(record: StoredProjectView, view: ProjectViewState): string | null {
  const data = JSON.stringify({ updatedAt: record.updatedAt, view });
  if (data.length <= MAX_PROJECT_VIEW_CHARS) return data;
  logger.projects.warn('Project view too large for the cloud, kept on this device', {
    projectId: record.projectId,
    chars: data.length,
  });
  return null;
}

async function upsertCloudView(record: StoredProjectView, createOnly: boolean): Promise<void> {
  if (cloudViewsUnavailable) return;
  const data = serializeCloudView(record, record.view);
  if (data == null) return;
  const key = viewKey(record.ownerId, record.projectId);
  const knownId = cloudViewIds.get(key);
  if (typeof knownId === 'string') {
    // Une vraie vue existe : l'amorce ne la remplace jamais.
    if (createOnly) return;
    try {
      // Relue juste avant : ses repères de lecture (autre appareil) sont fusionnés, pas écrasés.
      const current = await databases.getDocument(APPWRITE_DATABASE_ID, PROJECT_VIEWS_COLLECTION_ID, knownId);
      const merged = serializeCloudView(
        record,
        mergeViewReads(record.view, parseCloudView(current as CloudViewDoc, record.projectId, record.ownerId)?.view),
      );
      if (merged == null) return;
      await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECT_VIEWS_COLLECTION_ID, knownId, { data: merged });
      return;
    } catch (error) {
      if (isMissingCollection(error)) {
        markCloudViewsUnavailable(error);
        return;
      }
      if (errorCode(error) !== 404) throw error;
      cloudViewIds.delete(key); // effacée ailleurs : recréée ci-dessous
    }
  }
  // Vue absente du cloud, ou inconnue (projet tout juste créé, importé ou
  // dupliqué ; lecture échouée) : création, et un 409 si elle existait.
  const documentId = projectViewDocumentId(record.projectId, record.ownerId);
  try {
    await databases.createDocument(
      APPWRITE_DATABASE_ID,
      PROJECT_VIEWS_COLLECTION_ID,
      documentId,
      { project_id: record.projectId, user_id: record.ownerId, data },
      [
        Permission.read(Role.user(record.ownerId)),
        Permission.update(Role.user(record.ownerId)),
        Permission.delete(Role.user(record.ownerId)),
      ],
    );
    cloudViewIds.set(key, documentId);
  } catch (error) {
    if (isMissingCollection(error)) {
      markCloudViewsUnavailable(error);
      return;
    }
    // Créé entre-temps par un autre onglet / appareil (une vue d'amorçage
    // s'efface), ou id pris par un autre compte (accessQueries.ts).
    if (errorCode(error) !== 409) throw error;
    if (createOnly) return;
    // Créée entre-temps ailleurs : ses repères de lecture sont fusionnés.
    const existing = await findOwnCloudView(record.projectId, record.ownerId);
    const merged = existing
      ? serializeCloudView(record, mergeViewReads(record.view, parseCloudView(existing, record.projectId, record.ownerId)?.view))
      : data;
    if (merged == null) return;
    cloudViewIds.set(
      key,
      await (await loadAccessQueries()).writeConflictedCloudView(documentId, record.projectId, record.ownerId, merged),
    );
  }
}

function clearTimers(entry: PendingView): void {
  if (entry.localTimer != null) clearTimeout(entry.localTimer);
  if (entry.cloudTimer != null) clearTimeout(entry.cloudTimer);
  entry.localTimer = null;
  entry.cloudTimer = null;
}

function settle(projectId: string, entry: PendingView): void {
  if (entry.localWritten && entry.cloudWritten && pendingViews.get(projectId) === entry) {
    clearTimers(entry);
    pendingViews.delete(projectId);
  }
}

async function writeLocal(projectId: string, entry: PendingView): Promise<void> {
  if (entry.localTimer != null) {
    clearTimeout(entry.localTimer);
    entry.localTimer = null;
  }
  if (entry.localWritten) return;
  const record = entry.record;
  try {
    await idbSaveProjectView(record);
    if (entry.record === record) entry.localWritten = true;
  } catch (error) {
    logger.projects.warn('IndexedDB project view not written', error);
    if (entry.record === record) entry.localWritten = true; // rien de mieux à faire localement
  }
  settle(projectId, entry);
}

function writeCloud(projectId: string, entry: PendingView): Promise<void> {
  if (entry.cloudTimer != null) {
    clearTimeout(entry.cloudTimer);
    entry.cloudTimer = null;
  }
  if (entry.cloudWritten) return Promise.resolve();
  return enqueue(cloudViewQueues, projectId, async () => {
    if (entry.cloudWritten) return;
    const record = entry.record;
    try {
      await upsertCloudView(record, entry.createOnly);
      if (entry.record === record) {
        entry.cloudWritten = true;
        entry.firstQueuedAt = Date.now();
      }
      settle(projectId, entry);
    } catch (error) {
      logger.projects.warn('Project view not synced to the cloud, will retry', error);
      if (pendingViews.get(projectId) === entry && entry.cloudTimer == null) {
        entry.cloudTimer = setTimeout(() => {
          entry.cloudTimer = null;
          void writeCloud(projectId, entry);
        }, CLOUD_RETRY_DELAY_MS);
      }
    }
  });
}

export interface QueueProjectViewOptions {
  /**
   * Amorçage depuis la vue d'un projet au format précédent : horodatée à la
   * dernière sauvegarde de ce projet et créée seulement si aucune vue cloud
   * n'existe (une vraie vue gagne toujours).
   */
  seed?: { updatedAt: string };
}

/**
 * Enregistre la vue de l'utilisateur courant sur un projet : copie locale
 * quasi immédiate, envoi cloud regroupé. À appeler à chaque changement de vue.
 */
export function queueProjectViewSave(
  projectId: string,
  view: ProjectViewState,
  options: QueueProjectViewOptions = {},
): void {
  const ownerId = getCachedCurrentUserIdSync();
  if (!projectId || ownerId === ANONYMOUS_OWNER) return;
  // Vue inchangée (effets rejoués à l'ouverture, mutateur sans effet) : rien à écrire.
  const json = JSON.stringify(view);
  if (lastKnownViews.get(viewKey(ownerId, projectId)) === json) return;
  lastKnownViews.set(viewKey(ownerId, projectId), json);
  const updatedAt = options.seed?.updatedAt ?? new Date().toISOString();
  const record: StoredProjectView = { projectId, ownerId, updatedAt, view };
  const now = Date.now();
  let entry = pendingViews.get(projectId);
  if (!entry || entry.record.ownerId !== ownerId) {
    if (entry) clearTimers(entry);
    entry = {
      record,
      createOnly: false,
      localWritten: false,
      cloudWritten: false,
      localTimer: null,
      cloudTimer: null,
      firstQueuedAt: now,
    };
    pendingViews.set(projectId, entry);
  }
  const current = entry;
  current.record = record;
  current.createOnly = Boolean(options.seed);
  current.localWritten = false;
  current.cloudWritten = isCloudless(projectId, ownerId) || cloudViewsUnavailable;

  if (current.localTimer != null) clearTimeout(current.localTimer);
  current.localTimer = setTimeout(() => {
    current.localTimer = null;
    void writeLocal(projectId, current);
  }, LOCAL_WRITE_DELAY_MS);

  if (!current.cloudWritten) {
    if (current.cloudTimer != null) clearTimeout(current.cloudTimer);
    const waited = now - current.firstQueuedAt;
    const delay = Math.max(0, Math.min(CLOUD_WRITE_DELAY_MS, CLOUD_WRITE_MAX_WAIT_MS - waited));
    current.cloudTimer = setTimeout(() => {
      current.cloudTimer = null;
      void writeCloud(projectId, current);
    }, delay);
  }
}

/**
 * Écrit tout de suite les vues en attente (fermeture du projet, onglet masqué
 * ou fermé). `projectId` : seulement celle de ce projet.
 */
export async function flushProjectViews(projectId?: string): Promise<void> {
  const entries = projectId
    ? [[projectId, pendingViews.get(projectId)] as const]
    : [...pendingViews.entries()];
  await Promise.all(entries.map(async ([id, entry]) => {
    if (!entry) return;
    await writeLocal(id, entry);
    await writeCloud(id, entry);
  }));
}

/**
 * Enregistre une vue sans attendre (projet importé ou dupliqué : il arrive
 * avec la vue de sa source).
 */
export async function saveProjectViewNow(projectId: string, view: ProjectViewState): Promise<void> {
  queueProjectViewSave(projectId, view);
  await flushProjectViews(projectId);
}

/**
 * Vue la plus récente de l'utilisateur courant sur un projet : en attente
 * d'écriture, copie locale ou cloud (mise en cache localement si plus
 * récente). Null si aucune n'est connue ; hors-ligne, la copie locale sert.
 */
export async function readProjectView(projectId: string): Promise<StoredProjectView | null> {
  const ownerId = getCachedCurrentUserIdSync();
  if (!projectId || ownerId === ANONYMOUS_OWNER) return null;

  const pending = pendingViews.get(projectId)?.record ?? null;
  const localPromise = idbGetProjectView(projectId)
    .then((entry) => (entry && entry.ownerId === ownerId ? entry : null))
    .catch(() => null);
  const cloudPromise = (async (): Promise<StoredProjectView | null> => {
    if (isCloudless(projectId, ownerId) || cloudViewsUnavailable) return null;
    try {
      const doc = await withTimeout(findOwnCloudView(projectId, ownerId), CLOUD_READ_TIMEOUT_MS);
      return doc ? parseCloudView(doc, projectId, ownerId) : null;
    } catch (error) {
      if (isMissingCollection(error)) markCloudViewsUnavailable(error);
      return null;
    }
  })();

  const [local, cloud] = await Promise.all([localPromise, cloudPromise]);
  const ownPending = pending && pending.ownerId === ownerId ? pending : null;
  let best: StoredProjectView | null = ownPending;
  if (isNewerRecord(local, best)) best = local;
  if (isNewerRecord(cloud, best)) {
    best = cloud;
    void idbSaveProjectView(cloud!).catch(() => undefined);
  }
  if (best) {
    // La vue la plus récente gagne, mais chaque fil garde le repère de lecture le plus avancé des copies.
    let view = best.view;
    for (const candidate of [ownPending, local, cloud]) {
      if (candidate && candidate !== best) view = mergeViewReads(view, candidate.view);
    }
    if (view !== best.view) best = { ...best, view };
  }
  if (best && !pendingViews.has(projectId)) {
    lastKnownViews.set(viewKey(ownerId, projectId), JSON.stringify(best.view));
  }
  return best;
}

/** Supprime la vue de l'utilisateur courant sur un projet (locale et cloud). */
export async function deleteProjectView(projectId: string): Promise<void> {
  const entry = pendingViews.get(projectId);
  if (entry) {
    clearTimers(entry);
    pendingViews.delete(projectId);
  }
  await idbDeleteProjectView(projectId).catch(() => undefined);
  const ownerId = getCachedCurrentUserIdSync();
  lastKnownViews.delete(viewKey(ownerId, projectId));
  if (ownerId === ANONYMOUS_OWNER || isCloudless(projectId, ownerId) || cloudViewsUnavailable) return;
  await enqueue(cloudViewQueues, projectId, async () => {
    const key = viewKey(ownerId, projectId);
    try {
      // Id connu, sinon retrouvé : pas de suppression à l'aveugle (404 sans vue).
      const documentId = cloudViewIds.has(key)
        ? cloudViewIds.get(key)
        : (await findOwnCloudView(projectId, ownerId))?.$id;
      if (documentId) await databases.deleteDocument(APPWRITE_DATABASE_ID, PROJECT_VIEWS_COLLECTION_ID, documentId);
      cloudViewIds.set(key, null);
    } catch (error) {
      cloudViewIds.delete(key);
      if (isMissingCollection(error)) markCloudViewsUnavailable(error);
      else if (errorCode(error) !== 404) logger.projects.warn('Cloud project view not deleted', error);
    }
  });
}
