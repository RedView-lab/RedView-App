import type {
  ProjectCommentAnchor,
  ProjectCommentCamera,
  ProjectCommentMessage,
  ProjectCommentThread,
  ProjectCommentZone,
} from '@/features/itineraryPanel/types';

import {
  MAX_COMMENT_MENTIONS,
  MAX_COMMENT_MESSAGES,
  MAX_COMMENT_TEXT_CHARS,
  MAX_COMMENT_THREADS,
  MAX_COMMENT_ZONE_VERTICES,
  MIN_COMMENT_ZONE_VERTICES,
} from './limits';

/**
 * Fils de commentaires venus d'ailleurs (fichier `.redview` d'un tiers,
 * document d'une ancienne version) : un fil ou un message invalide est
 * écarté, un champ facultatif invalide retiré, le reste passe tel quel.
 */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmptyString(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function sanitizeAnchor(raw: unknown): ProjectCommentAnchor | null {
  if (!isRecord(raw)) return null;
  const { lng, lat, elevationM } = raw;
  if (!isFiniteNumber(lng) || Math.abs(lng) > 180 || !isFiniteNumber(lat) || Math.abs(lat) > 90) return null;
  return { lng, lat, elevationM: isFiniteNumber(elevationM) ? elevationM : null };
}

function sanitizeZone(raw: unknown): ProjectCommentZone | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.ring)) return undefined;
  const ring = raw.ring.filter((vertex): vertex is [number, number] => Array.isArray(vertex)
    && vertex.length === 2
    && isFiniteNumber(vertex[0]) && Math.abs(vertex[0]) <= 180
    && isFiniteNumber(vertex[1]) && Math.abs(vertex[1]) <= 90);
  if (ring.length < MIN_COMMENT_ZONE_VERTICES || ring.length > MAX_COMMENT_ZONE_VERTICES) return undefined;
  return { ring: ring.map(([lng, lat]) => [lng, lat]) };
}

function sanitizeCamera(raw: unknown): ProjectCommentCamera | undefined {
  if (!isRecord(raw) || !isFiniteNumber(raw.zoom) || !isFiniteNumber(raw.pitch) || !isFiniteNumber(raw.bearing)) return undefined;
  return { zoom: raw.zoom, pitch: raw.pitch, bearing: raw.bearing };
}

function sanitizeMessage(raw: unknown, seen: Set<string>): ProjectCommentMessage | null {
  if (!isRecord(raw)) return null;
  const { id, authorId, authorName, text, createdAt } = raw;
  if (!nonEmptyString(id) || seen.has(id) || !nonEmptyString(authorId) || !nonEmptyString(createdAt, 64)) return null;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_COMMENT_TEXT_CHARS) return null;
  seen.add(id);
  const message: ProjectCommentMessage = {
    id,
    authorId,
    authorName: typeof authorName === 'string' ? authorName.slice(0, 256) : '',
    text,
    createdAt,
  };
  if (nonEmptyString(raw.editedAt, 64)) message.editedAt = raw.editedAt;
  if (Array.isArray(raw.mentions)) {
    const mentions = raw.mentions.filter((value): value is string => nonEmptyString(value)).slice(0, MAX_COMMENT_MENTIONS);
    if (mentions.length > 0) message.mentions = mentions;
  }
  if (isRecord(raw.reactions)) {
    const reactions: Record<string, true> = {};
    for (const [key, value] of Object.entries(raw.reactions)) {
      if (value === true && key.includes('~') && key.length <= 300) reactions[key] = true;
    }
    if (Object.keys(reactions).length > 0) message.reactions = reactions;
  }
  return message;
}

function sanitizeThread(raw: unknown, seen: Set<string>): ProjectCommentThread | null {
  if (!isRecord(raw)) return null;
  const { id, createdBy, createdAt } = raw;
  if (!nonEmptyString(id) || seen.has(id) || !nonEmptyString(createdBy) || !nonEmptyString(createdAt, 64)) return null;
  const anchor = sanitizeAnchor(raw.anchor);
  if (!anchor || !Array.isArray(raw.messages)) return null;
  const messageIds = new Set<string>();
  const messages = raw.messages.slice(0, MAX_COMMENT_MESSAGES)
    .map((message) => sanitizeMessage(message, messageIds))
    .filter((message): message is ProjectCommentMessage => message !== null);
  if (messages.length === 0) return null;
  seen.add(id);
  const thread: ProjectCommentThread = { id, anchor, createdBy, createdAt, messages };
  const zone = sanitizeZone(raw.zone);
  if (zone) thread.zone = zone;
  const camera = sanitizeCamera(raw.camera);
  if (camera) thread.camera = camera;
  if (nonEmptyString(raw.resolvedAt, 64)) {
    thread.resolvedAt = raw.resolvedAt;
    if (nonEmptyString(raw.resolvedBy)) thread.resolvedBy = raw.resolvedBy;
  }
  return thread;
}

/** Fils valables (undefined : aucun). */
export function sanitizeCommentThreads(raw: unknown): ProjectCommentThread[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const threads = raw.slice(0, MAX_COMMENT_THREADS)
    .map((thread) => sanitizeThread(thread, seen))
    .filter((thread): thread is ProjectCommentThread => thread !== null);
  return threads.length > 0 ? threads : undefined;
}
