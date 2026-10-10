import { promisify } from 'node:util';
import { gunzip, gunzipSync } from 'node:zlib';

import { Query } from 'node-appwrite';

import { createRateLimiter } from '../../server/lib/http-security.mjs';
import {
  APPWRITE_ID_PATTERN,
  canonicalSharedPermissions,
  corroboratedOwnerId,
  fileReadableBy,
  grantsTeamWrite,
  isTeamShared,
  permission,
  projectPayloadFileName,
  projectTeamId,
  samePermissions,
} from '../../server/lib/project-access.mjs';
import {
  APPWRITE_DATABASE_ID,
  FIT_FILES_BUCKET_ID,
  getAppwriteDatabases,
  getAppwriteStorage,
  getAppwriteTeams,
  getAppwriteUsers,
  PROJECT_PAYLOADS_BUCKET_ID,
  PROJECTS_COLLECTION_ID,
  THUMBNAILS_BUCKET_ID,
  type AuthenticatedUser,
} from './appwrite.js';
import { parseEmailAddress } from './email.js';
import { PublicError } from './errors.js';
import { createKeyedLock } from './keyedLock.js';
import { notifyProjectAccessChanged } from './multiplayerNotify.js';

/**
 * Partage d'un projet (co-édition) : une équipe Appwrite par projet
 * (`p<projectId>`), le propriétaire (`owner`) et des éditeurs (`editor`),
 * comptes RedView existants et vérifiés seulement (invitation par e-mail).
 * L'équipe reçoit la LECTURE du document du projet et de ses fichiers (.fit,
 * miniature, charge utile du bucket) : le document partagé n'est écrit que
 * par le serveur temps réel (clé admin), la suppression reste au propriétaire.
 * Le serveur temps réel vérifie l'appartenance à l'équipe à chaque connexion
 * et toutes les 15 s, et tout de suite quand on retire un éditeur
 * (server/multiplayer/auth.ts).
 *
 * Qui est propriétaire, quelle équipe : server/lib/project-access.mjs — jamais
 * les attributs `user_id` / `team_id` seuls, que le client écrit.
 *
 * Supprimer un projet partagé passe par ici (`deleteSharedProject`) : son
 * journal et ses points de sauvegarde de co-édition sont écrits par le
 * serveur temps réel avec la clé admin, que le client ne peut ni lire ni
 * effacer, et son équipe aussi.
 */

export { projectTeamId };

export type ShareRole = 'owner' | 'editor';

export interface ShareMember {
  userId: string;
  name: string;
  email: string;
  role: ShareRole;
}

export interface ShareState {
  projectId: string;
  isOwner: boolean;
  shared: boolean;
  members: ShareMember[];
}

interface ProjectRowAccess {
  $id: string;
  $permissions: string[];
  user_id: string;
  team_id?: string | null;
  name?: string;
  data?: unknown;
}

interface Membership {
  $id: string;
  userId: string;
  roles: string[];
  confirm: boolean;
}

const JOURNAL_COLLECTION_ID = 'project_journal';
const PROJECT_VIEWS_COLLECTION_ID = 'project_views';
/** Garde-fou des purges (pages de 100 lignes). */
const MAX_PURGE_PAGES = 1_000;
const MAX_MEMBERS = 50;
/**
 * Invitations : chacune dit si un compte existe pour cet e-mail. Bornées par
 * compte (et par IP dans api/projects/share.ts) pour qu'on ne puisse ni
 * énumérer les comptes RedView, ni inonder des inconnus de projets partagés.
 */
const INVITE_WINDOW_MS = 10 * 60_000;
const MAX_INVITES_PER_USER = 20;
const inviteLimiter = createRateLimiter({ windowMs: INVITE_WINDOW_MS, maxKeys: 20_000 });

export function assertProjectId(value: unknown): string {
  if (typeof value !== 'string' || !APPWRITE_ID_PATTERN.test(value)) throw new PublicError('Invalid project id', 400);
  return value;
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

async function readProject(projectId: string, withData = false): Promise<ProjectRowAccess> {
  try {
    const queries = withData ? [] : [Query.select(['$id', '$permissions', 'user_id', 'team_id', 'name'])];
    return await getAppwriteDatabases().getDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, projectId, queries) as unknown as ProjectRowAccess;
  } catch (error) {
    if (errorCode(error) === 404) throw new PublicError('Project not found', 404);
    throw error;
  }
}

async function listMemberships(teamId: string): Promise<Membership[]> {
  try {
    const list = await getAppwriteTeams().listMemberships(teamId, [Query.limit(100)]);
    return list.memberships as unknown as Membership[];
  } catch (error) {
    if (errorCode(error) === 404) return [];
    throw error;
  }
}

async function listMembers(teamId: string): Promise<ShareMember[]> {
  try {
    const list = await getAppwriteTeams().listMemberships(teamId, [Query.limit(100)]);
    return list.memberships
      .filter((membership) => membership.confirm)
      .map((membership) => ({
        userId: membership.userId,
        name: membership.userName,
        email: membership.userEmail,
        role: membership.roles.includes('owner') ? 'owner' as const : 'editor' as const,
      }));
  } catch (error) {
    if (errorCode(error) === 404) return [];
    throw error;
  }
}

async function membershipOf(teamId: string, userId: string): Promise<Membership | null> {
  try {
    const list = await getAppwriteTeams().listMemberships(teamId, [Query.equal('userId', userId), Query.limit(1)]);
    return (list.memberships as unknown as Membership[]).find((membership) => membership.userId === userId) ?? null;
  } catch (error) {
    if (errorCode(error) === 404) return null;
    throw error;
  }
}

/**
 * Propriétaire du projet, ou null s'il n'est pas établi. `user_id` doit être
 * corroboré par les permissions de la ligne (server/lib/project-access.mjs). Une
 * ligne de l'ancien format, qui donnait l'écriture à l'équipe, a pu être
 * réécrite par un éditeur : il faut en plus le rôle `owner` dans l'équipe,
 * donné par ce serveur au premier partage.
 */
async function ownerOf(row: ProjectRowAccess): Promise<string | null> {
  const ownerId = corroboratedOwnerId(row);
  if (!ownerId) return null;
  if (grantsTeamWrite(row.$permissions)) {
    const membership = await membershipOf(projectTeamId(row.$id), ownerId);
    if (!membership?.confirm || !membership.roles.includes('owner')) return null;
  }
  return ownerId;
}

/** Équipe du projet s'il est partagé (permission de lecture donnée par la ligne), sinon null. */
function sharedTeamOf(row: ProjectRowAccess): string | null {
  return isTeamShared(row) ? projectTeamId(row.$id) : null;
}

/**
 * Le propriétaire passe ; un membre de l'équipe reçoit 403 (`message`) ; tout
 * autre compte 404, comme si le projet n'existait pas.
 */
async function requireOwner(row: ProjectRowAccess, user: AuthenticatedUser, message: string): Promise<string> {
  const ownerId = await ownerOf(row);
  if (ownerId && ownerId === user.id) return ownerId;
  const teamId = sharedTeamOf(row);
  const membership = teamId ? await membershipOf(teamId, user.id) : null;
  if (membership?.confirm) throw new PublicError(message, 403);
  throw new PublicError('Project not found', 404);
}

async function stateFor(row: ProjectRowAccess, user: AuthenticatedUser): Promise<ShareState> {
  const isOwner = (await ownerOf(row)) === user.id;
  const teamId = sharedTeamOf(row);
  const members = teamId ? await listMembers(teamId) : [];
  if (!isOwner && !members.some((member) => member.userId === user.id)) throw new PublicError('Project not found', 404);
  return { projectId: row.$id, isOwner, shared: members.some((member) => member.role === 'editor'), members };
}

export async function getShareState(user: AuthenticatedUser, projectId: string): Promise<ShareState> {
  return stateFor(await readProject(projectId), user);
}

/**
 * Ajoute la lecture de l'équipe à un fichier, SEULEMENT s'il est déjà lisible
 * par le propriétaire en propre (et porte le nom attendu, s'il y en a un) :
 * les ids viennent du document, que la clé admin ne doit jamais suivre vers
 * le fichier d'un autre compte. Sans lever (fichier absent, bucket refusé).
 */
async function grantFile(bucketId: string, fileId: string, ownerId: string, teamId: string, expectedName?: string): Promise<void> {
  const storage = getAppwriteStorage();
  try {
    const file = await storage.getFile(bucketId, fileId);
    if (!fileReadableBy(file.$permissions, ownerId, null) || (expectedName !== undefined && file.name !== expectedName)) {
      console.warn('[projects/share] fichier étranger au projet, droits non accordés', bucketId, fileId);
      return;
    }
    const read = permission('read', `team:${teamId}`);
    if (!file.$permissions.includes(read)) await storage.updateFile(bucketId, fileId, file.name, [...file.$permissions, read]);
  } catch (error) {
    if (errorCode(error) !== 404) console.warn('[projects/share] permissions du fichier non mises à jour', bucketId, fileId, error);
  }
}

const gunzipAsync = promisify(gunzip);
const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;

/**
 * Document d'un gros projet, rangé dans le bucket des charges utiles (`data`
 * = `file:<id>`). Le pointeur n'est suivi que vers la charge utile du projet,
 * lisible par son propriétaire (même règle que le serveur temps réel) ; null
 * sinon, ou si elle est illisible.
 */
async function readPayloadDocument(projectId: string, data: string, ownerId: string): Promise<unknown> {
  const fileId = data.slice('file:'.length);
  if (!APPWRITE_ID_PATTERN.test(fileId)) return null;
  const storage = getAppwriteStorage();
  try {
    const file = await storage.getFile(PROJECT_PAYLOADS_BUCKET_ID, fileId);
    if (file.name !== projectPayloadFileName(projectId) || !fileReadableBy(file.$permissions, ownerId, null)) return null;
    const bytes = Buffer.from(await storage.getFileDownload(PROJECT_PAYLOADS_BUCKET_ID, fileId));
    return JSON.parse((await gunzipAsync(bytes, { maxOutputLength: MAX_DOCUMENT_BYTES })).toString('utf8'));
  } catch (error) {
    console.warn('[projects/share] charge utile illisible, .fit non ouverts à l’équipe', projectId, error);
    return null;
  }
}

/** Fichiers .fit référencés par le document (`fitUploads[].path`). */
function fitFileIds(data: unknown): string[] {
  let value: unknown = data;
  if (typeof value === 'string') {
    if (value.startsWith('file:')) return [];
    try {
      value = value.startsWith('gz:')
        ? JSON.parse(gunzipSync(Buffer.from(value.slice(3), 'base64'), { maxOutputLength: MAX_DOCUMENT_BYTES }).toString('utf8'))
        : JSON.parse(value);
    } catch {
      return [];
    }
  }
  const itineraries = (value as { itineraries?: unknown } | null)?.itineraries;
  if (!Array.isArray(itineraries)) return [];
  const ids = new Set<string>();
  for (const itinerary of itineraries) {
    const uploads = (itinerary as { fitUploads?: unknown } | null)?.fitUploads;
    if (!Array.isArray(uploads)) continue;
    for (const upload of uploads) {
      const path = (upload as { path?: unknown } | null)?.path;
      if (typeof path === 'string' && APPWRITE_ID_PATTERN.test(path)) ids.add(path);
    }
  }
  return [...ids];
}

/**
 * Équipe prête, propriétaire dedans (rôle `owner`), ligne aux permissions
 * canoniques (équipe en lecture seule).
 *
 * Premier partage (la ligne ne donne encore rien à l'équipe) :
 *  - une équipe `p<projectId>` qui existe déjà est supprimée puis recréée :
 *    n'importe quel compte peut créer une équipe d'id choisi et s'en faire
 *    propriétaire en attendant le partage (ou partage interrompu) ;
 *  - les fichiers du document (.fit, miniature, charge utile) s'ouvrent à
 *    l'équipe — lus maintenant, tant que seul le propriétaire a écrit le
 *    document (charge utile comprise pour un gros projet). Ensuite, chaque
 *    .fit ajouté à un projet partagé porte déjà la lecture de l'équipe (en
 *    session ou non : uploadProjectItineraryFitFiles), et un nouveau membre
 *    l'hérite par son rôle.
 */
/**
 * Opérations de partage d'un même projet, l'une après l'autre. Deux
 * invitations lancées ensemble au premier partage lisaient toutes deux « pas
 * encore partagé » : la seconde supprimait l'équipe que la première venait de
 * créer, invité compris (ou échouait en 409 à la recréer). Chaque opération
 * relit la ligne une fois la précédente terminée.
 */
const withProjectLock = createKeyedLock('project-sharing');

async function ensureShared(row: ProjectRowAccess, ownerId: string): Promise<string> {
  const teamId = projectTeamId(row.$id);
  const teams = getAppwriteTeams();
  const firstShare = !isTeamShared(row);
  let teamExists = true;
  try {
    await teams.get(teamId);
  } catch (error) {
    if (errorCode(error) !== 404) throw error;
    teamExists = false;
  }
  if (teamExists && firstShare) {
    const strangers = (await listMemberships(teamId)).filter((membership) => membership.userId !== ownerId).length;
    console.warn('[projects/share] équipe préexistante au premier partage : recréée', { projectId: row.$id, strangers });
    await ignoreNotFound(() => teams.delete(teamId));
    teamExists = false;
  }
  if (!teamExists) await teams.create(teamId, (row.name || 'Projet RedView').slice(0, 128));

  const ownerMembership = await membershipOf(teamId, ownerId);
  if (!ownerMembership) {
    await teams.createMembership(teamId, ['owner'], undefined, ownerId);
  } else if (!ownerMembership.roles.includes('owner')) {
    await teams.updateMembership(teamId, ownerMembership.$id, ['owner']);
  }

  const permissions = canonicalSharedPermissions(ownerId, teamId);
  if (!samePermissions(row.$permissions, permissions) || row.team_id !== teamId) {
    await getAppwriteDatabases().updateDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, row.$id, { team_id: teamId }, permissions);
  }

  if (firstShare) {
    const full = await readProject(row.$id, true);
    // Gros projet : le document (et donc ses .fit) est dans la charge utile.
    // Sans lui, les éditeurs recevaient un 404 sur chaque .fit.
    const document = typeof full.data === 'string' && full.data.startsWith('file:')
      ? await readPayloadDocument(row.$id, full.data, ownerId)
      : full.data;
    await Promise.all([
      ...fitFileIds(document).map((fileId) => grantFile(FIT_FILES_BUCKET_ID, fileId, ownerId, teamId)),
      grantFile(THUMBNAILS_BUCKET_ID, row.$id, ownerId, teamId),
      typeof full.data === 'string' && full.data.startsWith('file:')
        ? grantFile(PROJECT_PAYLOADS_BUCKET_ID, full.data.slice('file:'.length), ownerId, teamId, projectPayloadFileName(row.$id))
        : Promise.resolve(),
    ]);
  }
  return teamId;
}

export async function inviteToProject(user: AuthenticatedUser, projectId: string, rawEmail: unknown): Promise<ShareState> {
  const email = parseEmailAddress(rawEmail);
  if (!email) throw new PublicError('Invalid email', 400);
  if (!inviteLimiter(`invite:${user.id}`, MAX_INVITES_PER_USER)) throw new PublicError('Too many invitations, try again later', 429);
  return withProjectLock(projectId, () => inviteLocked(user, projectId, email));
}

async function inviteLocked(user: AuthenticatedUser, projectId: string, email: string): Promise<ShareState> {
  const row = await readProject(projectId);
  const ownerId = await requireOwner(row, user, 'Only the owner can share this project');
  if (user.email && user.email.toLowerCase() === email) throw new PublicError('You already own this project', 400);

  const found = await getAppwriteUsers().list([Query.equal('email', email), Query.limit(1)]);
  const invitee = found.users[0];
  // Compte à l'e-mail non vérifié (créé ou modifié côté client par n'importe
  // qui) ou bloqué : comme s'il n'existait pas.
  if (!invitee || invitee.emailVerification !== true || invitee.status === false) {
    throw new PublicError('No RedView account uses this email', 404);
  }
  if (invitee.$id === ownerId) throw new PublicError('You already own this project', 400);

  const teamId = await ensureShared(row, ownerId);
  const members = await listMembers(teamId);
  if (!members.some((member) => member.userId === invitee.$id)) {
    if (members.length >= MAX_MEMBERS) throw new PublicError('Too many editors on this project', 409);
    try {
      await getAppwriteTeams().createMembership(teamId, ['editor'], undefined, invitee.$id);
    } catch (error) {
      if (errorCode(error) !== 409) throw error;
    }
  }
  return stateFor(await readProject(projectId), user);
}

export async function removeFromProject(user: AuthenticatedUser, projectId: string, memberId: unknown): Promise<ShareState> {
  if (typeof memberId !== 'string' || !APPWRITE_ID_PATTERN.test(memberId)) throw new PublicError('Invalid member', 400);
  return withProjectLock(projectId, () => removeLocked(user, projectId, memberId));
}

async function removeLocked(user: AuthenticatedUser, projectId: string, memberId: string): Promise<ShareState> {
  const row = await readProject(projectId);
  await requireOwner(row, user, 'Only the owner can remove an editor');
  if (memberId === user.id) throw new PublicError('The owner cannot be removed', 400);
  const membership = await membershipOf(projectTeamId(projectId), memberId);
  if (membership) {
    await getAppwriteTeams().deleteMembership(projectTeamId(projectId), membership.$id);
    await notifyProjectAccessChanged(projectId);
  }
  return stateFor(row, user);
}

/**
 * Supprime un projet partagé (propriétaire seulement) : journal, points de
 * sauvegarde et vues de la co-édition, équipe, puis la ligne. Une salle
 * encore ouverte est fermée par le serveur temps réel (4404), prévenu tout de
 * suite. Déjà supprimé : rien à faire.
 */
export function deleteSharedProject(user: AuthenticatedUser, projectId: string): Promise<void> {
  return withProjectLock(projectId, () => deleteLocked(user, projectId));
}

async function deleteLocked(user: AuthenticatedUser, projectId: string): Promise<void> {
  let row: ProjectRowAccess;
  try {
    row = await readProject(projectId);
  } catch (error) {
    if (error instanceof PublicError && error.status === 404) return;
    throw error;
  }
  await requireOwner(row, user, 'Only the owner can delete this project');
  await purgeCollabData(projectId);
  await ignoreNotFound(() => getAppwriteTeams().delete(projectTeamId(projectId)));
  await ignoreNotFound(() => getAppwriteDatabases().deleteDocument(APPWRITE_DATABASE_ID, PROJECTS_COLLECTION_ID, projectId));
  await notifyProjectAccessChanged(projectId);
}

/** Supprime les lignes `project_id = projectId` d'une collection (absente : rien à faire). */
async function purgeProjectRows(
  collectionId: string,
  projectId: string,
  onRow?: (row: { $id: string; payload?: unknown }) => Promise<void>,
): Promise<void> {
  const databases = getAppwriteDatabases();
  for (let page = 0; page < MAX_PURGE_PAGES; page += 1) {
    let rows: Array<{ $id: string; payload?: unknown }>;
    try {
      const list = await databases.listDocuments(APPWRITE_DATABASE_ID, collectionId, [
        Query.equal('project_id', projectId),
        ...(onRow ? [Query.select(['$id', 'payload'])] : [Query.select(['$id'])]),
        Query.limit(100),
      ]);
      rows = list.documents as unknown as Array<{ $id: string; payload?: unknown }>;
    } catch (error) {
      // Collection absente (co-édition ou vues jamais installées) : rien à purger.
      if (errorCode(error) === 404) return;
      throw error;
    }
    if (rows.length === 0) return;
    await Promise.all(rows.map(async (row) => {
      await onRow?.(row);
      await ignoreNotFound(() => databases.deleteDocument(APPWRITE_DATABASE_ID, collectionId, row.$id));
    }));
  }
}

/** Journal (et ses gros paquets en fichiers), points de sauvegarde exacts et vues des éditeurs. */
async function purgeCollabData(projectId: string): Promise<void> {
  const storage = getAppwriteStorage();
  await purgeProjectRows(JOURNAL_COLLECTION_ID, projectId, async (row) => {
    if (typeof row.payload === 'string' && row.payload.startsWith('file:')) {
      await ignoreNotFound(() => storage.deleteFile(PROJECT_PAYLOADS_BUCKET_ID, (row.payload as string).slice('file:'.length)));
    }
  });
  await purgeProjectRows(PROJECT_VIEWS_COLLECTION_ID, projectId);
  for (const name of [`${projectId}.collab.gz`, projectPayloadFileName(projectId)]) {
    const list = await storage.listFiles(PROJECT_PAYLOADS_BUCKET_ID, [Query.equal('name', name), Query.limit(100)]);
    await Promise.all(list.files.map((file) => ignoreNotFound(() => storage.deleteFile(PROJECT_PAYLOADS_BUCKET_ID, file.$id))));
  }
}

export function leaveProject(user: AuthenticatedUser, projectId: string): Promise<void> {
  return withProjectLock(projectId, () => leaveLocked(user, projectId));
}

async function leaveLocked(user: AuthenticatedUser, projectId: string): Promise<void> {
  const row = await readProject(projectId);
  if ((await ownerOf(row)) === user.id) throw new PublicError('The owner cannot leave their own project', 400);
  const teamId = projectTeamId(projectId);
  const membership = await membershipOf(teamId, user.id);
  if (!membership) throw new PublicError('Project not found', 404);
  await getAppwriteTeams().deleteMembership(teamId, membership.$id);
  await notifyProjectAccessChanged(projectId);
}
