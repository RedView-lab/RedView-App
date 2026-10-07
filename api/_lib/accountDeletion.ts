import { Query } from 'node-appwrite';

import { corroboratedOwnerId, permission, projectTeamId } from '../../server/lib/project-access.mjs';
import {
  APPWRITE_DATABASE_ID,
  CUSTOMERS_COLLECTION_ID,
  FIT_FILES_BUCKET_ID,
  FOLDERS_COLLECTION_ID,
  getAppwriteDatabases,
  getAppwriteStorage,
  getAppwriteTeams,
  getAppwriteUsers,
  PROJECT_PAYLOADS_BUCKET_ID,
  PROJECTS_COLLECTION_ID,
  SUBSCRIPTIONS_COLLECTION_ID,
  THUMBNAILS_BUCKET_ID,
} from './appwrite.js';
import { getCustomerRow } from './billing/customers.js';
import { PublicError } from './errors.js';
import { notifyProjectAccessChanged } from './multiplayerNotify.js';
import { deleteSharedProject } from './projectSharing.js';
import { getStripeServer } from './stripe.js';

/**
 * Suppression d'un compte et de toutes ses données (RGPD, art. 17) — appelée
 * par api/auth/delete-account.ts après confirmation par code e-mail, et par
 * scripts/appwrite/account-deletions.ts pour reprendre une suppression interrompue ou
 * la rejouer après la restauration d'une sauvegarde.
 *
 * Ordre :
 *  1. Le compte est bloqué (plus aucune session ne peut écrire pendant la
 *     purge) et marqué `deletionpending` ; la suppression est inscrite au
 *     registre `account_deletions` (id du compte et dates, rien d'autre).
 *  2. Facturation : le client Stripe est supprimé, ce qui annule tout de suite
 *     ses abonnements (aucun prélèvement après la demande).
 *  3. Projets possédés (propriétaire établi par les permissions de la ligne,
 *     jamais par `user_id` seul) : ligne, équipe de partage, journal, points
 *     de sauvegarde et vues de la co-édition, charge utile (deleteSharedProject).
 *  4. Équipes d'autres projets : le compte les quitte, le serveur temps réel
 *     est prévenu.
 *  5. Fichiers dont le compte est propriétaire dans les trois buckets
 *     (miniatures, .fit, charges utiles), y compris les orphelins.
 *  6. Vues, dossiers, lignes client/abonnement.
 *  7. Le compte Appwrite (sessions, identités, préférences — dont la
 *     bibliothèque de profils de tracé).
 *
 * Chaque étape est idempotente : relancer reprend là où une panne s'est
 * arrêtée. Restent, par choix : les commentaires et modifications du compte
 * dans les projets partagés d'autres personnes (ils appartiennent à ces
 * projets), et les sauvegardes chiffrées, effacées par rotation (≤ 12 mois).
 */

export const ACCOUNT_DELETIONS_COLLECTION_ID = 'account_deletions';
/** Labels Appwrite : alphanumériques seulement. */
export const DELETION_PENDING_LABEL = 'deletionpending';
const PROJECT_VIEWS_COLLECTION_ID = 'project_views';
const PAGE_SIZE = 100;
/** Garde-fou des parcours paginés (100 000 lignes ou fichiers). */
const MAX_PAGES = 1_000;

export interface AccountDeletionSummary {
  projects: number;
  sharedProjectsLeft: number;
  files: number;
  views: number;
  folders: number;
  billingDeleted: boolean;
}

interface Row {
  $id: string;
  $permissions?: string[];
  user_id?: string;
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

async function ignoreNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (errorCode(error) !== 404) throw error;
  }
}

/** Écriture ou suppression accordée au compte : il en est le propriétaire (client ou serveur l'a créé pour lui). */
function ownedBy(permissions: readonly string[] | undefined, userId: string): boolean {
  const role = `user:${userId}`;
  return Array.isArray(permissions)
    && (permissions.includes(permission('update', role)) || permissions.includes(permission('delete', role)));
}

/** Lignes d'une collection (pagination par curseur) ; collection absente : aucune. */
async function listRows(collectionId: string, queries: string[]): Promise<Row[]> {
  const databases = getAppwriteDatabases();
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let documents: Row[];
    try {
      const list = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [
        ...queries,
        Query.limit(PAGE_SIZE),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ]);
      documents = list.documents as unknown as Row[];
    } catch (error) {
      if (errorCode(error) === 404) return rows;
      throw error;
    }
    rows.push(...documents);
    if (documents.length < PAGE_SIZE) return rows;
    cursor = documents[documents.length - 1].$id;
  }
  throw new Error(`[account-deletion] ${collectionId} : plus de ${MAX_PAGES * PAGE_SIZE} lignes`);
}

async function deleteRows(collectionId: string, ids: readonly string[]): Promise<void> {
  const databases = getAppwriteDatabases();
  for (const id of ids) {
    await ignoreNotFound(() => databases.deleteDocument(APPWRITE_DATABASE_ID, collectionId, id));
  }
}

async function recordDeletion(userId: string, status: 'pending' | 'done'): Promise<void> {
  const databases = getAppwriteDatabases();
  const now = new Date().toISOString();
  try {
    if (status === 'pending') {
      try {
        await databases.createDocument(APPWRITE_DATABASE_ID, ACCOUNT_DELETIONS_COLLECTION_ID, userId, {
          user_id: userId,
          status,
          requested_at: now,
        }, []);
      } catch (error) {
        if (errorCode(error) !== 409) throw error;
        await databases.updateDocument(APPWRITE_DATABASE_ID, ACCOUNT_DELETIONS_COLLECTION_ID, userId, { status });
      }
    } else {
      await databases.updateDocument(APPWRITE_DATABASE_ID, ACCOUNT_DELETIONS_COLLECTION_ID, userId, { status, completed_at: now });
    }
  } catch (error) {
    // Registre absent (schéma pas encore créé) : la suppression continue, sa
    // trace reste dans les journaux du serveur.
    if (errorCode(error) === 404) {
      console.warn('[account-deletion] collection account_deletions absente : suppression non inscrite au registre', userId, status);
      return;
    }
    throw error;
  }
}

/** Étape 1 : plus aucune écriture du compte pendant la purge. */
async function blockAccount(userId: string): Promise<void> {
  const users = getAppwriteUsers();
  const user = await users.get(userId);
  const labels = Array.isArray(user.labels) ? user.labels : [];
  if (!labels.includes(DELETION_PENDING_LABEL)) await users.updateLabels(userId, [...labels, DELETION_PENDING_LABEL]);
  if (user.status !== false) await users.updateStatus(userId, false);
}

/** Étape 2 : supprimer le client Stripe annule immédiatement ses abonnements. */
async function deleteBilling(userId: string): Promise<boolean> {
  const row = await getCustomerRow(userId);
  if (!row?.stripe_customer_id) return false;
  try {
    await getStripeServer().customers.del(row.stripe_customer_id);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 'resource_missing') throw error;
  }
  return true;
}

/** Étape 3 : projets dont le compte est le propriétaire établi. */
async function deleteOwnedProjects(userId: string): Promise<number> {
  const rows = await listRows(PROJECTS_COLLECTION_ID, [
    Query.equal('user_id', userId),
    Query.select(['$id', '$permissions', 'user_id']),
  ]);
  let deleted = 0;
  for (const row of rows) {
    if (corroboratedOwnerId(row) !== userId) continue;
    try {
      await deleteSharedProject({ id: userId, email: null }, row.$id);
      deleted += 1;
    } catch (error) {
      // Ancienne ligne partagée en écriture dont la propriété n'est plus établie :
      // pas la sienne, on n'y touche pas.
      if (error instanceof PublicError && (error.status === 403 || error.status === 404)) {
        console.warn('[account-deletion] projet ignoré (propriété non établie)', row.$id, error.message);
        continue;
      }
      throw error;
    }
  }
  return deleted;
}

/** Étape 4 : quitter les équipes des projets partagés par d'autres. */
async function leaveSharedProjects(userId: string): Promise<number> {
  const users = getAppwriteUsers();
  const teams = getAppwriteTeams();
  let left = 0;
  // Chaque page lue est supprimée : on relit toujours la première.
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { memberships } = await users.listMemberships(userId, [Query.limit(PAGE_SIZE)]);
    for (const membership of memberships) {
      await ignoreNotFound(() => teams.deleteMembership(membership.teamId, membership.$id));
      // Équipe `p<projectId>` : le serveur temps réel ferme tout de suite la
      // connexion du compte au lieu d'attendre sa revérification (15 s).
      const projectId = membership.teamId.startsWith('p') ? membership.teamId.slice(1) : '';
      if (projectId && projectTeamId(projectId) === membership.teamId) {
        await notifyProjectAccessChanged(projectId);
        left += 1;
      }
    }
    if (memberships.length < PAGE_SIZE) return left;
  }
  return left;
}

/** Étape 5 : fichiers du compte dans un bucket (parcours complet : les orphelins aussi). */
async function deleteOwnedFiles(bucketId: string, userId: string): Promise<number> {
  const storage = getAppwriteStorage();
  const owned: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let files: Array<{ $id: string; $permissions: string[] }>;
    try {
      const list = await storage.listFiles(bucketId, [Query.limit(PAGE_SIZE), ...(cursor ? [Query.cursorAfter(cursor)] : [])]);
      files = list.files;
    } catch (error) {
      if (errorCode(error) === 404) return 0;
      throw error;
    }
    for (const file of files) if (ownedBy(file.$permissions, userId)) owned.push(file.$id);
    if (files.length < PAGE_SIZE) break;
    cursor = files[files.length - 1].$id;
  }
  for (const fileId of owned) await ignoreNotFound(() => storage.deleteFile(bucketId, fileId));
  return owned.length;
}

/** Étape 6 : lignes rattachées au compte. Vues et dossiers : seulement celles qu'il possède. */
async function deleteUserRows(userId: string): Promise<{ views: number; folders: number }> {
  const views = (await listRows(PROJECT_VIEWS_COLLECTION_ID, [Query.equal('user_id', userId)]))
    .filter((row) => ownedBy(row.$permissions, userId));
  await deleteRows(PROJECT_VIEWS_COLLECTION_ID, views.map((row) => row.$id));
  const folders = (await listRows(FOLDERS_COLLECTION_ID, [Query.equal('user_id', userId)]))
    .filter((row) => ownedBy(row.$permissions, userId));
  await deleteRows(FOLDERS_COLLECTION_ID, folders.map((row) => row.$id));
  // Écrites par le serveur seul (aucune permission client) : `user_id` fait foi.
  const subscriptions = await listRows(SUBSCRIPTIONS_COLLECTION_ID, [Query.equal('user_id', userId)]);
  await deleteRows(SUBSCRIPTIONS_COLLECTION_ID, subscriptions.map((row) => row.$id));
  await deleteRows(CUSTOMERS_COLLECTION_ID, [userId]);
  return { views: views.length, folders: folders.length };
}

/**
 * Supprime le compte `userId` et ses données. Idempotent ; un compte déjà
 * supprimé ne fait que compléter le registre.
 */
export async function deleteAccount(userId: string): Promise<AccountDeletionSummary> {
  const users = getAppwriteUsers();
  let exists = true;
  try {
    await users.get(userId);
  } catch (error) {
    if (errorCode(error) !== 404) throw error;
    exists = false;
  }

  await recordDeletion(userId, 'pending');
  if (exists) await blockAccount(userId);
  const billingDeleted = await deleteBilling(userId);
  const projects = await deleteOwnedProjects(userId);
  const sharedProjectsLeft = exists ? await leaveSharedProjects(userId) : 0;
  let files = 0;
  for (const bucketId of [THUMBNAILS_BUCKET_ID, FIT_FILES_BUCKET_ID, PROJECT_PAYLOADS_BUCKET_ID]) {
    files += await deleteOwnedFiles(bucketId, userId);
  }
  const { views, folders } = await deleteUserRows(userId);
  if (exists) await ignoreNotFound(() => users.delete(userId));
  await recordDeletion(userId, 'done');

  const summary = { projects, sharedProjectsLeft, files, views, folders, billingDeleted };
  console.log('[account-deletion] compte supprimé', userId, summary);
  return summary;
}
