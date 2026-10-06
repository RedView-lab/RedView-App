import { Account, Client, Query, Teams } from 'node-appwrite';

import type { RoomStorage } from './storage.ts';

/**
 * Qui peut entrer dans une salle : le propriétaire du projet ou un membre
 * (confirmé) de son équipe. Le jeton est le JWT Appwrite de l'utilisateur,
 * vérifié comme `requireAuthenticatedUser` (api/_lib/appwrite.ts) à la
 * connexion (un JWT expire après 15 min : seule la connexion le présente).
 * Les droits sont revérifiés toutes les minutes (`checkAccess`, cache court) :
 * un éditeur retiré du projet perd l'accès.
 *
 * Développement seulement (`devAuth`, jamais en production) : jeton
 * `dev:<utilisateur>`, accès à tous les projets du stockage de fichiers.
 */

type AccessResult = 'ok' | 'forbidden' | 'not-found';

export interface Authenticator {
  /** Utilisateur du jeton, null s'il est invalide ou expiré. */
  verifyToken(token: string): Promise<string | null>;
  checkAccess(userId: string, projectId: string): Promise<AccessResult>;
}

export interface AuthOptions {
  storage: RoomStorage;
  appwrite: { endpoint: string; projectId: string; apiKey: string } | null;
  devAuth: boolean;
}

const TOKEN_CACHE_MS = 60_000;
const MEMBERSHIP_CACHE_MS = 60_000;
const DEV_TOKEN = /^dev:([A-Za-z0-9_-]{1,64})$/;

/** Réponse d'Appwrite qui refuse le jeton lui-même (et non une panne). */
function isTokenRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 400 || code === 401 || code === 403;
}

export function createAuthenticator(options: AuthOptions): Authenticator {
  const tokens = new Map<string, { userId: string | null; at: number }>();
  const memberships = new Map<string, { member: boolean; at: number }>();
  const admin = options.appwrite
    ? new Client().setEndpoint(options.appwrite.endpoint).setProject(options.appwrite.projectId).setKey(options.appwrite.apiKey)
    : null;
  const teams = admin ? new Teams(admin) : null;

  async function userOf(token: string): Promise<string | null> {
    if (options.devAuth) {
      const dev = DEV_TOKEN.exec(token);
      if (dev) return dev[1];
    }
    if (!options.appwrite) return null;
    const cached = tokens.get(token);
    if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.userId;
    let userId: string | null = null;
    try {
      const client = new Client().setEndpoint(options.appwrite.endpoint).setProject(options.appwrite.projectId).setJWT(token);
      userId = (await new Account(client).get()).$id;
    } catch (error) {
      // Jeton refusé (expiré, révoqué, mal formé) : refus, gardé en cache. Une
      // panne d'Appwrite (réseau, 5xx, 429) n'en est pas un : l'erreur remonte
      // (fermeture 1011, le client réessaie) — un refus mis en cache éjectait
      // l'éditeur de la session au troisième essai.
      if (!isTokenRejection(error)) throw error;
      userId = null;
    }
    tokens.set(token, { userId, at: Date.now() });
    if (tokens.size > 10_000) tokens.delete(tokens.keys().next().value!);
    return userId;
  }

  async function isMember(teamId: string, userId: string): Promise<boolean> {
    if (!teams) return false;
    const key = `${teamId}|${userId}`;
    const cached = memberships.get(key);
    if (cached && Date.now() - cached.at < MEMBERSHIP_CACHE_MS) return cached.member;
    const list = await teams.listMemberships(teamId, [Query.equal('userId', userId), Query.limit(1)]);
    const member = list.memberships.some((membership) => membership.userId === userId && membership.confirm);
    memberships.set(key, { member, at: Date.now() });
    if (memberships.size > 10_000) memberships.delete(memberships.keys().next().value!);
    return member;
  }

  return {
    async verifyToken(token: string): Promise<string | null> {
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
      return userOf(token);
    },

    async checkAccess(userId: string, projectId: string): Promise<AccessResult> {
      if (options.devAuth && options.storage.kind === 'file') return 'ok';
      const access = await options.storage.access(projectId);
      if (!access) return 'not-found';
      if (access.ownerId === userId) return 'ok';
      if (access.teamId && await isMember(access.teamId, userId)) return 'ok';
      return 'forbidden';
    },
  };
}
