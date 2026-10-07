import type { Models } from 'appwrite';

import {
  APPWRITE_DATABASE_ID,
  client,
  databases,
  ID,
  Permission,
  PROJECT_VIEWS_COLLECTION_ID,
  Query,
  Role,
} from '@/shared/services/appwrite';

import { isOwnDocument, sharingTeamOf, type AccessCheckedDoc } from './access';

/**
 * Les contrôles d'access.ts qui interrogent Appwrite, chargés à la demande
 * (import dynamique) : équipes de projet (`p<projet>`) dont l'utilisateur est
 * membre — projets d'un autre, liste « Partagés avec moi » — et vue
 * `project_views` dont l'id est pris par un autre compte. Rien de tout cela ne
 * sert au premier affichage (budget de npm run bundle:check). Équipes lues par
 * `GET /teams` sur le client déjà chargé, sans la classe `Teams` du SDK.
 */

/** Équipes gardées brièvement (une liste du navigateur de projets les relit). */
const TEAMS_CACHE_MS = 15_000;
const MAX_TEAM_PAGES = 20;
let teamsCache: { userId: string; at: number; teams: Promise<ReadonlySet<string>> } | null = null;

/**
 * `GET /teams` en appel brut. Le SDK web v26 n'ajoute plus `X-Appwrite-Project`
 * à `client.call` (chaque service le passe lui-même) : sans lui, Appwrite traite
 * la requête au nom de sa console et répond `Access-Control-Allow-Origin:
 * https://localhost`, le navigateur la bloque et « Partagés avec moi » restait
 * vide pour tout le monde (bench:collab-prod, 2026-10-07).
 */
function listTeams(queries: string[]): Promise<Models.TeamList<Models.Preferences>> {
  return client.call(
    'get',
    new URL(`${client.config.endpoint}/teams`),
    { 'content-type': 'application/json', 'X-Appwrite-Project': client.config.project },
    { queries },
  );
}

/** Équipes de projet (`p…`) dont l'utilisateur est membre ; une erreur remonte (rien n'est alors montré comme partagé). */
export function myProjectTeams(userId: string, { fresh = false }: { fresh?: boolean } = {}): Promise<ReadonlySet<string>> {
  if (!fresh && teamsCache && teamsCache.userId === userId && Date.now() - teamsCache.at < TEAMS_CACHE_MS) return teamsCache.teams;
  const loading = (async () => {
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TEAM_PAGES; page += 1) {
      const queries: string[] = [Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])];
      const list = await listTeams(queries);
      for (const team of list.teams) if (team.$id.startsWith('p')) ids.add(team.$id);
      if (list.teams.length < 100) break;
      cursor = list.teams[list.teams.length - 1].$id;
    }
    return ids as ReadonlySet<string>;
  })();
  const entry = { userId, at: Date.now(), teams: loading };
  teamsCache = entry;
  loading.catch(() => {
    if (teamsCache === entry) teamsCache = null;
  });
  return loading;
}

/** Oublie les équipes gardées (partage accepté, projet quitté, changement de compte). */
export function forgetMyProjectTeams(): void {
  teamsCache = null;
}

/** L'utilisateur est-il membre de cette équipe ? (relue une fois si elle n'y est pas encore : invitation récente) */
export async function isTeamMember(userId: string, teamId: string): Promise<boolean> {
  try {
    if ((await myProjectTeams(userId)).has(teamId)) return true;
    return (await myProjectTeams(userId, { fresh: true })).has(teamId);
  } catch {
    return false;
  }
}

/**
 * Lignes partagées avec moi : celles des équipes `p<projet>` dont je suis
 * membre (`listForTeams` reçoit au plus 100 équipes par appel), la ligne
 * accordant bien la lecture à son équipe (`sharingTeamOf`), les plus récentes
 * d'abord. Une ligne lisible par tous ne s'y invite pas.
 */
export async function listSharedWithMe<T extends AccessCheckedDoc & { $updatedAt: string }>(
  userId: string,
  listForTeams: (teamIds: string[]) => Promise<T[]>,
): Promise<T[]> {
  const teams = [...(await myProjectTeams(userId, { fresh: true }))];
  const documents: T[] = [];
  for (let index = 0; index < teams.length; index += 100) documents.push(...await listForTeams(teams.slice(index, index + 100)));
  const mine = new Set(teams);
  return documents
    .filter((doc) => {
      const teamId = sharingTeamOf(doc);
      return teamId !== null && mine.has(teamId);
    })
    .sort((a, b) => (a.$updatedAt < b.$updatedAt ? 1 : a.$updatedAt > b.$updatedAt ? -1 : 0));
}

export interface CloudViewDoc {
  $id: string;
  $updatedAt?: string;
  $permissions?: string[];
  user_id?: string;
  data?: unknown;
}

/**
 * Ma vue la plus récente du projet, retrouvée par requête. L'id déterministe
 * d'une vue se calcule à partir du projet et de l'utilisateur, qu'un
 * collaborateur connaît : il peut le créer avant moi (avec ses permissions).
 * Sa ligne n'est jamais lue comme ma vue (`isOwnDocument`), et la mienne vit
 * alors à un id aléatoire (`writeConflictedCloudView`).
 */
export async function listOwnCloudView(projectId: string, ownerId: string): Promise<CloudViewDoc | null> {
  const list = await databases.listDocuments(APPWRITE_DATABASE_ID, PROJECT_VIEWS_COLLECTION_ID, [
    Query.equal('project_id', projectId),
    Query.equal('user_id', ownerId),
    Query.limit(10),
  ]);
  const own = (list.documents as unknown as CloudViewDoc[]).filter((doc) => isOwnDocument(doc, ownerId));
  own.sort((a, b) => (String(a.$updatedAt) < String(b.$updatedAt) ? 1 : -1));
  return own[0] ?? null;
}

/**
 * Écrit ma vue quand sa création à l'id déterministe a répondu 409 : créée
 * entre-temps par un autre de mes onglets ou appareils (mise à jour), ou id
 * pris par un autre compte (introuvable pour moi) — elle vit alors ailleurs :
 * dans celle retrouvée, ou créée à un id aléatoire.
 */
export async function writeConflictedCloudView(documentId: string, projectId: string, ownerId: string, data: string): Promise<void> {
  try {
    await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECT_VIEWS_COLLECTION_ID, documentId, { data });
    return;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 404 && code !== 401) throw error;
  }
  const own = await listOwnCloudView(projectId, ownerId);
  if (own) {
    await databases.updateDocument(APPWRITE_DATABASE_ID, PROJECT_VIEWS_COLLECTION_ID, own.$id, { data });
    return;
  }
  await databases.createDocument(
    APPWRITE_DATABASE_ID,
    PROJECT_VIEWS_COLLECTION_ID,
    ID.unique(),
    { project_id: projectId, user_id: ownerId, data },
    [
      Permission.read(Role.user(ownerId)),
      Permission.update(Role.user(ownerId)),
      Permission.delete(Role.user(ownerId)),
    ],
  );
}
