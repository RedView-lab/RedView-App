import { Account, Client, Query, Teams } from 'node-appwrite';

import { createOldestKeyTaker } from '../lib/oldest-key.mjs';
import { APPWRITE_ID_PATTERN, projectTeamId } from '../lib/project-access.mjs';
import type { RoomStorage } from './storage.ts';

/**
 * Qui peut entrer dans une salle : le propriétaire du projet ou un membre
 * (confirmé) de son équipe — tels que les établit le stockage
 * (server/lib/project-access.mjs : jamais les attributs de la ligne seuls). Le
 * jeton est le JWT Appwrite de l'utilisateur, vérifié comme
 * `requireAuthenticatedUser` (api/_lib/appwrite.ts) à l'ouverture de la
 * WebSocket, puis à chaque relève (`auth`) : une connexion ne survit pas à
 * l'expiration de son jeton (une session fermée ne peut plus en produire).
 * Les droits sont revérifiés sans cache à la connexion, puis toutes les 15 s
 * (cache 10 s), et tout de suite quand l'API de partage signale un retrait
 * (`forgetProject`). Sans cache, la ligne du projet et l'appartenance à son
 * équipe (`p<projectId>`, connue d'avance) sont lues en parallèle : un
 * aller-retour vers Appwrite au lieu de deux à l'entrée dans une salle.
 * L'appartenance ne compte que si la ligne partage bien le projet avec cette
 * équipe.
 *
 * Développement seulement (`devAuth`, jamais en production) : jeton
 * `dev:<utilisateur>`, accès à tous les projets du stockage de fichiers.
 */

type AccessResult = 'ok' | 'forbidden' | 'not-found';

export interface Identity {
  userId: string;
  /** Nom du compte (ou son e-mail) ; en développement, l'identifiant du jeton. */
  name?: string;
  /** Expiration du jeton (ms) ; `Infinity` en développement. */
  expiresAt: number;
}

export interface Authenticator {
  /** Utilisateur du jeton, null s'il est invalide ou expiré ; lève si Appwrite est injoignable. */
  verifyToken(token: string): Promise<Identity | null>;
  /**
   * Utilisateur que le jeton DÉCLARE, sans rien vérifier (null : illisible,
   * ou déjà refusé) : sert seulement à lire ses droits pendant que le jeton
   * est vérifié — jamais à décider (server.ts n'utilise ces droits que si le
   * jeton vérifié désigne le même utilisateur). Absent : rien n'est préparé.
   */
  claimedUserId?(token: string): string | null;
  /** `fresh` : sans cache (connexion, révocation signalée). */
  checkAccess(userId: string, projectId: string, options?: { fresh?: boolean }): Promise<AccessResult>;
  /** Oublie ce qui est gardé des droits d'un projet (retrait signalé par l'API de partage). */
  forgetProject(projectId: string): void;
}

export interface AuthOptions {
  storage: RoomStorage;
  appwrite: { endpoint: string; projectId: string; apiKey: string } | null;
  devAuth: boolean;
}

const TOKEN_CACHE_MS = 60_000;
const MEMBERSHIP_CACHE_MS = 10_000;
const DEV_TOKEN = /^dev:([A-Za-z0-9_-]{1,64})$/;
/** Forme d'un JWT (trois parties base64url) : un jeton qui ne l'a pas n'est même pas présenté à Appwrite. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** JWT Appwrite : 15 min (expiration supposée si le jeton ne la dit pas). */
const DEFAULT_TOKEN_LIFETIME_MS = 15 * 60_000;

/** Réponse d'Appwrite qui refuse le jeton lui-même (et non une panne). */
function isTokenRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 400 || code === 401 || code === 403;
}

/** Expiration lue dans le JWT (déjà vérifié par Appwrite : seule sa date sert ici). */
function tokenExpiry(token: string, now: number): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch {
    // Charge illisible : durée de vie par défaut.
  }
  return now + DEFAULT_TOKEN_LIFETIME_MS;
}

/** `userId` de la charge d'un JWT Appwrite (non vérifié), null s'il n'y en a pas. */
function claimedJwtUser(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { userId?: unknown };
    return typeof payload.userId === 'string' && APPWRITE_ID_PATTERN.test(payload.userId) ? payload.userId : null;
  } catch {
    return null;
  }
}

export function createAuthenticator(options: AuthOptions): Authenticator {
  const tokens = new Map<string, { identity: Identity | null; at: number }>();
  const memberships = new Map<string, { member: boolean; at: number }>();
  const oldestToken = createOldestKeyTaker(tokens);
  const oldestMembership = createOldestKeyTaker(memberships);
  const admin = options.appwrite
    ? new Client().setEndpoint(options.appwrite.endpoint).setProject(options.appwrite.projectId).setKey(options.appwrite.apiKey)
    : null;
  const teams = admin ? new Teams(admin) : null;
  /** Équipe de chaque projet vu (révocation : oublier ses appartenances). */
  const teamOfProject = new Map<string, string>();
  const oldestProject = createOldestKeyTaker(teamOfProject);

  async function identityOf(token: string): Promise<Identity | null> {
    if (options.devAuth) {
      const dev = DEV_TOKEN.exec(token);
      // Nom imposé comme en production (celui du compte) : ici l'identifiant du jeton de dev.
      if (dev) return { userId: dev[1], name: dev[1], expiresAt: Number.POSITIVE_INFINITY };
    }
    if (!options.appwrite || !JWT_SHAPE.test(token)) return null;
    const cached = tokens.get(token);
    if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.identity;
    let identity: Identity | null = null;
    try {
      const client = new Client().setEndpoint(options.appwrite.endpoint).setProject(options.appwrite.projectId).setJWT(token);
      const user = await new Account(client).get();
      identity = { userId: user.$id, name: user.name?.trim() || user.email || undefined, expiresAt: tokenExpiry(token, Date.now()) };
    } catch (error) {
      // Jeton refusé (expiré, révoqué, mal formé) : refus, gardé en cache. Une
      // panne d'Appwrite (réseau, 5xx, 429) n'en est pas un : l'erreur remonte
      // (fermeture 1011, le client réessaie) — un refus mis en cache éjectait
      // l'éditeur de la session au troisième essai.
      if (!isTokenRejection(error)) throw error;
      identity = null;
    }
    tokens.set(token, { identity, at: Date.now() });
    if (tokens.size > 10_000) tokens.delete(oldestToken()!);
    return identity;
  }

  async function isMember(teamId: string, userId: string, fresh: boolean): Promise<boolean> {
    if (!teams) return false;
    const key = `${teamId}|${userId}`;
    const cached = memberships.get(key);
    if (!fresh && cached && Date.now() - cached.at < MEMBERSHIP_CACHE_MS) return cached.member;
    const list = await teams.listMemberships(teamId, [Query.equal('userId', userId), Query.limit(1)]);
    const member = list.memberships.some((membership) => membership.userId === userId && membership.confirm);
    memberships.set(key, { member, at: Date.now() });
    if (memberships.size > 10_000) memberships.delete(oldestMembership()!);
    return member;
  }

  return {
    async verifyToken(token: string): Promise<Identity | null> {
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
      return identityOf(token);
    },

    claimedUserId(token: string): string | null {
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
      if (options.devAuth) {
        const dev = DEV_TOKEN.exec(token);
        if (dev) return dev[1];
      }
      if (!options.appwrite || !JWT_SHAPE.test(token)) return null;
      // Jeton déjà refusé (gardé en cache) : rien à préparer.
      const cached = tokens.get(token);
      if (cached && cached.identity === null && Date.now() - cached.at < TOKEN_CACHE_MS) return null;
      return claimedJwtUser(token);
    },

    async checkAccess(userId: string, projectId: string, { fresh = false } = {}): Promise<AccessResult> {
      if (options.devAuth && options.storage.kind === 'file') return 'ok';
      if (fresh) options.storage.forgetAccess?.(projectId);
      // Sans cache : l'appartenance à l'équipe du projet est lue en même temps que la ligne
      // (résultat ou erreur gardés pour plus tard), utilisée seulement si la ligne la demande.
      const teamId = projectTeamId(projectId);
      const membership = fresh && teams
        ? isMember(teamId, userId, true).then((member) => ({ member }), (error: unknown) => ({ error }))
        : null;
      const access = await options.storage.access(projectId);
      if (!access) return 'not-found';
      if (access.teamId) {
        teamOfProject.set(projectId, access.teamId);
        if (teamOfProject.size > 10_000) teamOfProject.delete(oldestProject()!);
      }
      if (access.ownerId && access.ownerId === userId) return 'ok';
      if (!access.teamId) return 'forbidden';
      if (membership && access.teamId === teamId) {
        const outcome = await membership;
        if ('error' in outcome) throw outcome.error;
        return outcome.member ? 'ok' : 'forbidden';
      }
      return await isMember(access.teamId, userId, fresh) ? 'ok' : 'forbidden';
    },

    forgetProject(projectId: string): void {
      options.storage.forgetAccess?.(projectId);
      const teamId = teamOfProject.get(projectId);
      if (!teamId) return;
      for (const key of [...memberships.keys()]) if (key.startsWith(`${teamId}|`)) memberships.delete(key);
    },
  };
}
