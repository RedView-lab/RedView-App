import { generateKeyBetween } from 'fractional-indexing';

import { isRouteHeader, objectSpec, specAtPath } from './diff';
import type { ObjectStore } from './objects';
import { applyOp, type Op } from './ops';
import { decodePath } from './paths';

/**
 * Contrôles du serveur sur un lot d'un client, avant de l'appliquer (le
 * serveur fait foi : un lot invalide est refusé en entier, jamais appliqué à
 * moitié) :
 *  - forme des opérations, tailles maximales ;
 *  - un élément créé l'est dans une liste prévue par le modèle (schema.ts),
 *    avec un id cohérent avec son parent ;
 *  - positions fractionnaires valides ; une position déjà prise par un
 *    autre élément de la même liste (deux insertions concurrentes au même
 *    endroit) est remplacée par une position libre juste après, comme chez
 *    Figma ;
 *  - un en-tête de tracé ne référence que des segments connus ou fournis.
 */

export const MAX_OPS_PER_BATCH = 20_000;
const MAX_VALUE_CHARS = 2_000_000;
const MAX_BATCH_BLOB_CHARS = 24_000_000;

export type BatchCheck =
  | { ok: true; ops: Op[] }
  | { ok: false; reason: string; missingBlobs?: string[] };

function isValidPosition(pos: unknown): pos is string {
  if (typeof pos !== 'string' || pos.length === 0 || pos.length > 2048) return false;
  try {
    generateKeyBetween(pos, null);
    return true;
  } catch {
    return false;
  }
}

function valueChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Position libre dans la liste : `pos` si personne d'autre ne l'a, sinon juste après. */
function freePosition(store: ObjectStore, parent: string, field: string, id: string, pos: string): string {
  const siblings = store.childrenOf(parent, field).filter((sibling) => sibling.id !== id);
  if (!siblings.some((sibling) => sibling.pos === pos)) return pos;
  const above = siblings
    .map((sibling) => sibling.pos!)
    .filter((siblingPos) => siblingPos > pos)
    .sort()[0] ?? null;
  return generateKeyBetween(pos, above);
}

export function checkBatch(
  store: ObjectStore,
  ops: unknown,
  blobs: Readonly<Record<string, string>>,
): BatchCheck {
  if (!Array.isArray(ops)) return { ok: false, reason: 'ops-not-array' };
  if (ops.length > MAX_OPS_PER_BATCH) return { ok: false, reason: 'too-many-ops' };
  let blobChars = 0;
  for (const json of Object.values(blobs)) {
    if (typeof json !== 'string') return { ok: false, reason: 'blob-not-string' };
    blobChars += json.length;
  }
  if (blobChars > MAX_BATCH_BLOB_CHARS) return { ok: false, reason: 'blobs-too-large' };

  // Les positions se corrigent sur un état où les opérations précédentes du
  // lot sont appliquées (un lot peut créer plusieurs éléments voisins).
  const scratch = store.clone();
  const out: Op[] = [];
  const missing = new Set<string>();
  const specs = new Map();

  for (const raw of ops as unknown[]) {
    if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'op-not-object' };
    const op = raw as Op;
    if (typeof op.id !== 'string' || op.id.length === 0 || op.id.length > 1024) return { ok: false, reason: 'bad-id' };
    switch (op.t) {
      case 'c': {
        if (typeof op.parent !== 'string' || typeof op.field !== 'string' || !Array.isArray(op.props)) {
          return { ok: false, reason: 'bad-create' };
        }
        if (!op.id.startsWith(`${op.parent}/${op.field}:`)) return { ok: false, reason: 'bad-create-id' };
        if (!isValidPosition(op.pos)) return { ok: false, reason: 'bad-position' };
        if (scratch.has(op.parent)) {
          const listSpec = specAtPath(objectSpec(scratch, op.parent, specs), decodePath(op.field));
          if (listSpec?.kind !== 'list') return { ok: false, reason: 'not-a-list' };
        }
        for (const entry of op.props) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
            return { ok: false, reason: 'bad-prop' };
          }
          if (valueChars(entry[1]) > MAX_VALUE_CHARS) return { ok: false, reason: 'value-too-large' };
          collectMissingBlobs(entry[1], scratch, blobs, missing);
        }
        const fixed: Op = scratch.has(op.parent)
          ? { ...op, pos: freePosition(scratch, op.parent, op.field, op.id, op.pos) }
          : op;
        out.push(fixed);
        applyForValidation(scratch, fixed);
        break;
      }
      case 'd':
        out.push({ t: 'd', id: op.id });
        applyForValidation(scratch, out[out.length - 1]);
        break;
      case 's': {
        if (typeof op.k !== 'string' || op.k.length === 0 || op.k.length > 1024) return { ok: false, reason: 'bad-key' };
        if ('v' in op) {
          if (valueChars(op.v) > MAX_VALUE_CHARS) return { ok: false, reason: 'value-too-large' };
          collectMissingBlobs(op.v, scratch, blobs, missing);
          out.push({ t: 's', id: op.id, k: op.k, v: op.v });
        } else {
          out.push({ t: 's', id: op.id, k: op.k });
        }
        applyForValidation(scratch, out[out.length - 1]);
        break;
      }
      case 'm': {
        if (!isValidPosition(op.pos)) return { ok: false, reason: 'bad-position' };
        const object = scratch.get(op.id);
        const fixed: Op = object?.parent && object.field !== null
          ? { t: 'm', id: op.id, pos: freePosition(scratch, object.parent, object.field, op.id, op.pos) }
          : { t: 'm', id: op.id, pos: op.pos };
        out.push(fixed);
        applyForValidation(scratch, fixed);
        break;
      }
      default:
        return { ok: false, reason: 'unknown-op' };
    }
  }
  if (missing.size > 0) return { ok: false, reason: 'missing-blobs', missingBlobs: [...missing] };
  return { ok: true, ops: out };
}

function collectMissingBlobs(
  value: unknown,
  store: ObjectStore,
  blobs: Readonly<Record<string, string>>,
  missing: Set<string>,
): void {
  if (!isRouteHeader(value)) return;
  for (const id of [...value.points, ...(value.originalPoints ?? [])]) {
    if (typeof id !== 'string') continue;
    if (!store.hasBlob(id) && !(id in blobs)) missing.add(id);
  }
}

function applyForValidation(store: ObjectStore, op: Op): void {
  applyOp(store, op);
}
