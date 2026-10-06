import type { ProjectCommentsView, ProjectCommentThread } from '@/features/itineraryPanel/types';

import type { CommentAction, CommentAuthor } from '../lib/commentActions';
import type { MentionCandidate } from '../lib/messageText';
import { sanitizeCommentThreads } from '../lib/sanitize';

/**
 * Pont des commentaires entre l'app et le viewer LiDAR (autre onglet), sur le
 * modèle des tracés (lidar/lib/routeOverlaySync.ts) : BroadcastChannel +
 * dernière copie dans localStorage.
 *  - l'app publie l'état du projet ouvert (fils, auteur, membres, lu / non lu) ;
 *  - le viewer envoie ses actions (`COMMENT_ACTION`, mêmes actions que le
 *    réducteur de l'app) : l'app les applique et les fait suivre à la session
 *    temps réel (le seul écrivain reste l'onglet de l'app) ;
 *  - `HELLO` (viewer) : l'app republie ; sans réponse, le viewer montre la
 *    dernière copie en lecture seule ; `CLOSED` : projet fermé dans l'app.
 */

export const LIDAR_COMMENTS_CHANNEL = 'redview:lidar:comments';
export const LIDAR_COMMENTS_STORAGE_KEY = 'redview:lidar:comments';

export interface LidarCommentState {
  version: 1;
  type: 'STATE';
  projectId: string;
  updatedAt: string;
  me: CommentAuthor;
  members: MentionCandidate[];
  threads: ProjectCommentThread[];
  reads: NonNullable<ProjectCommentsView['reads']>;
}

export type LidarCommentMessage =
  | LidarCommentState
  | { version: 1; type: 'CLOSED'; projectId: string }
  | { version: 1; type: 'HELLO' }
  | { version: 1; type: 'COMMENT_ACTION'; projectId: string; action: CommentAction }
  | { version: 1; type: 'MARK_READ'; projectId: string; threadId: string }
  | { version: 1; type: 'MARK_UNREAD'; projectId: string; threadId: string };

const STORAGE_DEBOUNCE_MS = 300;

let sharedChannel: BroadcastChannel | null = null;

function channel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!sharedChannel) {
    try {
      sharedChannel = new BroadcastChannel(LIDAR_COMMENTS_CHANNEL);
    } catch {
      return null;
    }
  }
  return sharedChannel;
}

export function postLidarCommentMessage(message: LidarCommentMessage): void {
  try {
    channel()?.postMessage(message);
  } catch {
    // Canal indisponible : le viewer garde sa dernière copie.
  }
}

let storageTimer: ReturnType<typeof setTimeout> | null = null;
let pendingStored: LidarCommentState | null = null;

/** État publié pour le viewer (et gardé pour un viewer ouvert plus tard). */
export function publishLidarCommentState(state: LidarCommentState): void {
  postLidarCommentMessage(state);
  pendingStored = state;
  if (storageTimer) return;
  storageTimer = setTimeout(() => {
    storageTimer = null;
    const stored = pendingStored;
    pendingStored = null;
    if (!stored) return;
    try {
      window.localStorage.setItem(LIDAR_COMMENTS_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Stockage plein ou indisponible : la diffusion suffit tant que l'app est ouverte.
    }
  }, STORAGE_DEBOUNCE_MS);
}

/**
 * Projet fermé dans l'app (autre projet, retour aux projets, accès retiré,
 * projet supprimé) : sa copie locale est effacée — les fils et les membres
 * d'un projet ne restent pas dans le navigateur après qu'on l'a quitté.
 */
export function clearStoredLidarCommentState(projectId: string): void {
  if (pendingStored?.projectId === projectId) pendingStored = null;
  try {
    const raw = window.localStorage.getItem(LIDAR_COMMENTS_STORAGE_KEY);
    if (raw && (JSON.parse(raw) as { projectId?: unknown }).projectId === projectId) {
      window.localStorage.removeItem(LIDAR_COMMENTS_STORAGE_KEY);
    }
  } catch {
    // Stockage indisponible : rien à effacer.
  }
}

export function subscribeLidarComments(listener: (message: LidarCommentMessage) => void): () => void {
  const bc = channel();
  if (!bc) return () => undefined;
  const handle = (event: MessageEvent) => {
    const message = event.data as LidarCommentMessage | null;
    if (message && typeof message === 'object' && message.version === 1 && typeof message.type === 'string') listener(message);
  };
  bc.addEventListener('message', handle);
  return () => bc.removeEventListener('message', handle);
}

/** État reçu, fils vérifiés (le viewer ne fait confiance à rien de stocké). */
export function readLidarCommentState(raw: unknown): LidarCommentState | null {
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as Partial<LidarCommentState>;
  if (state.type !== 'STATE' || typeof state.projectId !== 'string' || !state.me || typeof state.me.userId !== 'string') return null;
  return {
    version: 1,
    type: 'STATE',
    projectId: state.projectId,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    me: { userId: state.me.userId, name: typeof state.me.name === 'string' ? state.me.name : '' },
    members: Array.isArray(state.members)
      ? state.members.filter((member): member is MentionCandidate => Boolean(member) && typeof member.userId === 'string' && typeof member.name === 'string')
      : [],
    threads: sanitizeCommentThreads(state.threads) ?? [],
    reads: state.reads && typeof state.reads === 'object' ? state.reads : {},
  };
}

export function readStoredLidarCommentState(): LidarCommentState | null {
  try {
    const raw = window.localStorage.getItem(LIDAR_COMMENTS_STORAGE_KEY);
    return raw ? readLidarCommentState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
