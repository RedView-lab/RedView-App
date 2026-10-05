import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { Permission, Query, Role } from 'node-appwrite';

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
import { PublicError } from './errors.js';

/**
 * Partage d'un projet (co-édition) : une équipe Appwrite par projet
 * (`p<projectId>`), le propriétaire (`owner`) et des éditeurs (`editor`),
 * comptes RedView existants seulement (invitation par e-mail). L'équipe
 * reçoit lecture + écriture sur le document du projet, lecture sur ses
 * fichiers (.fit, miniature, charge utile du bucket) ; la suppression reste
 * au propriétaire. Le serveur temps réel vérifie l'appartenance à l'équipe à
 * chaque connexion et toutes les minutes (server/multiplayer/auth.ts).
 */

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

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MEMBERS = 50;

export function assertProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) throw new PublicError('Invalid project id', 400);
  return value;
}

/** Équipe d'un projet : `p<projectId>` (id Appwrite ≤ 36 car.). */
export function projectTeamId(projectId: string): string {
  const id = `p${projectId}`;
  return id.length <= 36 ? id : `p${createHash('sha256').update(projectId).digest('hex').slice(0, 35)}`;
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
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

async function membershipOf(teamId: string, userId: string) {
  try {
    const list = await getAppwriteTeams().listMemberships(teamId, [Query.equal('userId', userId), Query.limit(1)]);
    return list.memberships.find((membership) => membership.userId === userId) ?? null;
  } catch (error) {
    if (errorCode(error) === 404) return null;
    throw error;
  }
}

async function stateFor(row: ProjectRowAccess, user: AuthenticatedUser): Promise<ShareState> {
  const isOwner = row.user_id === user.id;
  const teamId = row.team_id || null;
  const members = teamId ? await listMembers(teamId) : [];
  if (!isOwner && !members.some((member) => member.userId === user.id)) throw new PublicError('Project not found', 404);
  return { projectId: row.$id, isOwner, shared: members.some((member) => member.role === 'editor'), members };
}

export async function getShareState(user: AuthenticatedUser, projectId: string): Promise<ShareState> {
  return stateFor(await readProject(projectId), user);
}

/** Ajoute `permissions` à un fichier s'il en manque (sans lever : fichier absent, bucket refusé). */
async function grantFile(bucketId: string, fileId: string, permissions: string[]): Promise<void> {
  const storage = getAppwriteStorage();
  try {
    const file = await storage.getFile(bucketId, fileId);
    const missing = permissions.filter((permission) => !file.$permissions.includes(permission));
    if (missing.length > 0) await storage.updateFile(bucketId, fileId, file.name, [...file.$permissions, ...missing]);
  } catch (error) {
    if (errorCode(error) !== 404) console.warn('[projects/share] permissions du fichier non mises à jour', bucketId, fileId, error);
  }
}

/** Fichiers .fit référencés par le document (`fitUploads[].path`). */
function fitFileIds(data: unknown): string[] {
  let value: unknown = data;
  if (typeof value === 'string') {
    if (value.startsWith('file:')) return [];
    try {
      value = value.startsWith('gz:')
        ? JSON.parse(gunzipSync(Buffer.from(value.slice(3), 'base64'), { maxOutputLength: 200 * 1024 * 1024 }).toString('utf8'))
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
      if (typeof path === 'string' && /^[A-Za-z0-9._-]{1,36}$/.test(path)) ids.add(path);
    }
  }
  return [...ids];
}

/** Équipe créée au premier partage, propriétaire dedans, document et fichiers ouverts à l'équipe. */
async function ensureShared(row: ProjectRowAccess, owner: AuthenticatedUser): Promise<string> {
  const teamId = projectTeamId(row.$id);
  const teams = getAppwriteTeams();
  try {
    await teams.get(teamId);
  } catch (error) {
    if (errorCode(error) !== 404) throw error;
    await teams.create(teamId, (row.name || 'Projet RedView').slice(0, 128));
  }
  if (!(await membershipOf(teamId, owner.id))) {
    await teams.createMembership(teamId, ['owner'], undefined, owner.id);
  }

  const team = Role.team(teamId);
  const documentPermissions = [Permission.read(team), Permission.update(team)];
  const missing = documentPermissions.filter((permission) => !row.$permissions.includes(permission));
  if (missing.length > 0 || row.team_id !== teamId) {
    await getAppwriteDatabases().updateDocument(
      APPWRITE_DATABASE_ID,
      PROJECTS_COLLECTION_ID,
      row.$id,
      { team_id: teamId },
      [...row.$permissions, ...missing],
    );
  }

  const read = [Permission.read(team)];
  const full = await readProject(row.$id, true);
  await Promise.all([
    ...fitFileIds(full.data).map((fileId) => grantFile(FIT_FILES_BUCKET_ID, fileId, read)),
    grantFile(THUMBNAILS_BUCKET_ID, row.$id.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 36) || 'thumbnail', read),
    typeof full.data === 'string' && full.data.startsWith('file:')
      ? grantFile(PROJECT_PAYLOADS_BUCKET_ID, full.data.slice('file:'.length), read)
      : Promise.resolve(),
  ]);
  return teamId;
}

export async function inviteToProject(user: AuthenticatedUser, projectId: string, rawEmail: unknown): Promise<ShareState> {
  if (typeof rawEmail !== 'string' || !EMAIL_PATTERN.test(rawEmail.trim()) || rawEmail.length > 320) {
    throw new PublicError('Invalid email', 400);
  }
  const email = rawEmail.trim().toLowerCase();
  const row = await readProject(projectId);
  if (row.user_id !== user.id) throw new PublicError('Only the owner can share this project', 403);
  if (user.email && user.email.toLowerCase() === email) throw new PublicError('You already own this project', 400);

  const found = await getAppwriteUsers().list([Query.equal('email', email), Query.limit(1)]);
  const invitee = found.users[0];
  if (!invitee) throw new PublicError('No RedView account uses this email', 404);

  const teamId = await ensureShared(row, user);
  const members = await listMembers(teamId);
  if (!members.some((member) => member.userId === invitee.$id)) {
    if (members.length >= MAX_MEMBERS) throw new PublicError('Too many editors on this project', 409);
    try {
      await getAppwriteTeams().createMembership(teamId, ['editor'], undefined, invitee.$id);
    } catch (error) {
      if (errorCode(error) !== 409) throw error;
    }
  }
  return stateFor({ ...row, team_id: teamId }, user);
}

export async function removeFromProject(user: AuthenticatedUser, projectId: string, memberId: unknown): Promise<ShareState> {
  if (typeof memberId !== 'string' || !memberId) throw new PublicError('Invalid member', 400);
  const row = await readProject(projectId);
  if (row.user_id !== user.id) throw new PublicError('Only the owner can remove an editor', 403);
  if (memberId === user.id) throw new PublicError('The owner cannot be removed', 400);
  if (row.team_id) {
    const membership = await membershipOf(row.team_id, memberId);
    if (membership) await getAppwriteTeams().deleteMembership(row.team_id, membership.$id);
  }
  return stateFor(row, user);
}

export async function leaveProject(user: AuthenticatedUser, projectId: string): Promise<void> {
  const row = await readProject(projectId);
  if (row.user_id === user.id) throw new PublicError('The owner cannot leave their own project', 400);
  const membership = row.team_id ? await membershipOf(row.team_id, user.id) : null;
  if (!membership) throw new PublicError('Project not found', 404);
  await getAppwriteTeams().deleteMembership(row.team_id!, membership.$id);
}
