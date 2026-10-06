import { generateKeyBetween } from 'fractional-indexing';

import { isSafeCssColor } from '@/shared/lib/cssColor';

import { ROUTE_CHUNK_MAX_POINTS, routeChunkId } from '../routeChunks';
import type { MergeSpec } from '../schema';
import { checkCommentOp } from './commentRules';
import { ATOMIC_VALUE_KEY, isPlainRecord, isRouteHeader, objectSpec, specAtPath } from './diff';
import type { ObjectStore } from './objects';
import { applyOp, type Op } from './ops';
import { childKey, decodePath, isCanonicalChildId, isCanonicalPath, itineraryIdOf, itineraryObjectId, ROOT_OBJECT_ID } from './paths';

/**
 * Contrôles du serveur sur un lot d'un client, avant de l'appliquer (le
 * serveur fait foi : un lot invalide est refusé en entier, jamais appliqué à
 * moitié). N'importe quel client peut envoyer n'importe quoi ; un client
 * honnête n'est jamais refusé (son lot refusé serait perdu) — vérifié par
 * validate.test.ts sur les opérations de `diffDocument` et par le simulateur
 * (aucun lot refusé) :
 *  - forme des opérations, tailles maximales ;
 *  - ids, champs et clés sous leur seule forme canonique (paths.ts) : une
 *    autre écriture de la même clé (`tex%74`) échapperait aux règles ;
 *  - la racine ne se supprime, ne se déplace ni ne se recrée ;
 *  - un élément créé l'est dans une liste prévue par le modèle (schema.ts),
 *    avec un id cohérent avec son parent ; une propriété écrite l'est à un
 *    chemin prévu par le modèle (jamais « à travers » une valeur atomique) ;
 *  - valeurs : profondeur et taille bornées, aucune clé `__proto__` ;
 *  - quelques champs dont un mauvais type ferait planter l'interface des
 *    autres éditeurs (nom, couleur, coordonnées) : type vérifié ;
 *  - positions fractionnaires valides ; une position déjà prise par un
 *    autre élément de la même liste (deux insertions concurrentes au même
 *    endroit) est remplacée par une position libre juste après, comme chez
 *    Figma ;
 *  - un en-tête de tracé ne référence que des segments connus ou fournis ;
 *    chaque segment fourni est un tableau de points au JSON canonique dont
 *    l'id est bien le hachage (routeChunks.ts) — il est recollé tel quel dans
 *    `projects.data` ; un segment qu'aucun en-tête du lot ne référence est
 *    écarté ;
 *  - avec l'auteur du lot (`userId`), les règles d'auteur des commentaires
 *    (commentRules.ts).
 */

export const MAX_OPS_PER_BATCH = 20_000;
const MAX_VALUE_CHARS = 2_000_000;
const MAX_BATCH_BLOB_CHARS = 24_000_000;
/** Profondeur d'une valeur JSON (les plus profondes du document en ont moins de 10). */
const MAX_VALUE_DEPTH = 64;
/** Objets et tableaux d'une valeur (borne le temps de parcours). */
const MAX_VALUE_NODES = 1_000_000;
/** Segments d'un en-tête de tracé (2 M de points ≈ 8 000 segments). */
const MAX_ROUTE_HEADER_CHUNKS = 100_000;
const ROUTE_CHUNK_ID_PATTERN = /^c[0-9a-z]{2,24}$/;
const FORBIDDEN_KEY = '__proto__';

export type BatchCheck =
  | { ok: true; ops: Op[]; blobs: Record<string, string> }
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

/**
 * Valeur JSON acceptable : profondeur et nombre de nœuds bornés (parcours
 * itératif, jamais de dépassement de pile), aucune clé `__proto__`, taille
 * bornée. Raison du refus, ou null.
 */
function inspectValue(value: unknown, measure = true): string | null {
  const stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    nodes += 1;
    if (nodes > MAX_VALUE_NODES) return 'value-too-large';
    if (depth >= MAX_VALUE_DEPTH) return 'value-too-deep';
    if (Array.isArray(node)) {
      for (const item of node) stack.push([item, depth + 1]);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (key === FORBIDDEN_KEY) return 'forbidden-key';
      stack.push([(node as Record<string, unknown>)[key], depth + 1]);
    }
  }
  return measure && valueChars(value) > MAX_VALUE_CHARS ? 'value-too-large' : null;
}

/** En-tête de tracé bien formé : ids de segments au bon format, en nombre borné. */
function inspectRouteHeader(value: unknown): string | null {
  if (!isRouteHeader(value)) return null;
  const lists = value.originalPoints === undefined ? [value.points] : [value.points, value.originalPoints];
  for (const ids of lists) {
    if (!Array.isArray(ids) || ids.length > MAX_ROUTE_HEADER_CHUNKS) return 'bad-route-header';
    for (const id of ids) if (typeof id !== 'string' || !ROUTE_CHUNK_ID_PATTERN.test(id)) return 'bad-route-header';
  }
  return null;
}

/** Point d'un segment : objet simple, `lat` / `lon` numériques (ou null) quand présents. */
function isRoutePoint(point: unknown): boolean {
  if (!isPlainRecord(point)) return false;
  for (const key of ['lat', 'lon'] as const) {
    const coordinate = point[key];
    if (coordinate !== undefined && coordinate !== null && typeof coordinate !== 'number') return false;
  }
  return true;
}

/** Segment de tracé fourni par un client : raison du refus, ou null. */
function inspectRouteChunk(id: string, json: string): string | null {
  if (!ROUTE_CHUNK_ID_PATTERN.test(id) || routeChunkId(json) !== id) return 'bad-blob-id';
  let points: unknown;
  try {
    points = JSON.parse(json);
  } catch {
    return 'bad-blob';
  }
  if (!Array.isArray(points) || points.length === 0 || points.length > ROUTE_CHUNK_MAX_POINTS) return 'bad-blob';
  // JSON canonique : le serveur recolle le texte tel quel dans le document (materializeJson).
  if (JSON.stringify(points) !== json || !points.every(isRoutePoint)) return 'bad-blob';
  // Taille déjà bornée par celle du texte (lot ≤ MAX_BATCH_BLOB_CHARS).
  return inspectValue(points, false);
}

/** Clé de propriété permise sur un objet de spécification `spec`. */
function isValidPropKey(spec: MergeSpec, key: string): boolean {
  if (key === ATOMIC_VALUE_KEY) return true;
  if (spec.kind !== 'record' || !isCanonicalPath(key)) return false;
  return specAtPath(spec, decodePath(key)) !== null;
}

/**
 * Valeur posée telle quelle sur un champ de liste (liste vide, ou éléments
 * sans identifiant) : un tableau, ou null — jamais un texte ou un objet que
 * l'application itérerait (`itineraries: "x"` plantait tous les éditeurs).
 */
function checkListValue(spec: MergeSpec, key: string, value: unknown): string | null {
  if (key === ATOMIC_VALUE_KEY || spec.kind !== 'record') return null;
  const field = specAtPath(spec, decodePath(key));
  if (field?.kind === 'list' && value !== null && !Array.isArray(value)) return 'bad-list-value';
  // Tracé : un en-tête (points en segments) ou null, jamais un objet que l'app lirait comme un tracé.
  if (field?.kind === 'route' && value !== null && !isRouteHeader(value)) return 'bad-route-value';
  return null;
}

// ── Champs typés ────────────────────────────────────────────────────────────

type TypedKind = 'root' | 'itinerary' | 'timeline' | 'forbiddenZone';

const isString = (value: unknown) => typeof value === 'string';
const isOptionalString = (value: unknown) => value === null || typeof value === 'string';
const isOptionalNumber = (value: unknown) => value === null || (typeof value === 'number' && Number.isFinite(value));
const isOptionalColor = (value: unknown) => value === null || isSafeCssColor(value);
const isLatLonList = (value: unknown) => Array.isArray(value) && value.every((point) => isPlainRecord(point)
  && typeof point.lat === 'number' && Number.isFinite(point.lat)
  && typeof point.lon === 'number' && Number.isFinite(point.lon));

/** Champs dont un mauvais type fait planter l'interface des autres éditeurs (rendu React, carte). */
const TYPED_FIELDS: Record<TypedKind, Readonly<Record<string, (value: unknown) => boolean>>> = {
  root: { name: isOptionalString },
  itinerary: { id: isString, name: isOptionalString, color: isOptionalColor },
  timeline: { id: isString, kind: isString, label: isOptionalString, lat: isOptionalNumber, lon: isOptionalNumber, distanceKm: isOptionalNumber },
  forbiddenZone: { id: isString, points: isLatLonList },
};

function isItineraryObjectId(id: string): boolean {
  const itineraryId = itineraryIdOf(id);
  return itineraryId !== null && id === itineraryObjectId(itineraryId);
}

/** Nature d'un objet d'après son parent et son champ de liste (null : sans champ typé). */
function typedKindOf(id: string, parent: string | null, field: string | null): TypedKind | null {
  if (id === ROOT_OBJECT_ID) return 'root';
  if (parent === ROOT_OBJECT_ID && field === 'itineraries') return 'itinerary';
  if (parent !== null && isItineraryObjectId(parent)) {
    if (field === 'timeline') return 'timeline';
    if (field === 'forbiddenZones') return 'forbiddenZone';
  }
  return null;
}

/** Valeur d'un champ typé : raison du refus, ou null. L'`id` d'un élément est sa clé dans la liste. */
function checkTypedProp(kind: TypedKind | null, objectId: string, key: string, value: unknown): string | null {
  if (!kind) return null;
  const valid = TYPED_FIELDS[kind][key];
  if (valid && !valid(value)) return `bad-${kind}-${key}`;
  if (key === 'id' && kind !== 'root' && value !== childKey(objectId)) return `bad-${kind}-id`;
  return null;
}

// ── Lot ─────────────────────────────────────────────────────────────────────

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

export interface BatchCheckOptions {
  /** Auteur du lot : les règles d'auteur des commentaires s'appliquent. */
  userId?: string;
}

/** Valeur écrite (création ou `s`) : forme, taille, en-tête de tracé, segments référencés. */
function checkWrittenValue(value: unknown, referenced: Set<string>): string | null {
  const reason = inspectValue(value) ?? inspectRouteHeader(value);
  if (reason) return reason;
  if (isRouteHeader(value)) {
    for (const id of value.points) referenced.add(id);
    for (const id of value.originalPoints ?? []) referenced.add(id);
  }
  return null;
}

export function checkBatch(
  store: ObjectStore,
  ops: unknown,
  blobs: Readonly<Record<string, string>>,
  options: BatchCheckOptions = {},
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
  const referenced = new Set<string>();
  const specs = new Map<string, MergeSpec>();

  for (const raw of ops as unknown[]) {
    if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'op-not-object' };
    const op = raw as Op;
    if (typeof op.id !== 'string' || op.id.length === 0 || op.id.length > 1024) return { ok: false, reason: 'bad-id' };
    switch (op.t) {
      case 'c': {
        if (typeof op.parent !== 'string' || typeof op.field !== 'string' || !Array.isArray(op.props)) {
          return { ok: false, reason: 'bad-create' };
        }
        if (op.id === ROOT_OBJECT_ID || !isCanonicalChildId(op.id, op.parent, op.field)) return { ok: false, reason: 'bad-create-id' };
        if (!isValidPosition(op.pos)) return { ok: false, reason: 'bad-position' };
        let itemSpec: MergeSpec | null = null;
        if (scratch.has(op.parent)) {
          const listSpec = specAtPath(objectSpec(scratch, op.parent, specs), decodePath(op.field));
          if (listSpec?.kind !== 'list') return { ok: false, reason: 'not-a-list' };
          itemSpec = listSpec.item;
        }
        const kind = typedKindOf(op.id, op.parent, op.field);
        for (const entry of op.props) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
            return { ok: false, reason: 'bad-prop' };
          }
          const [key, value] = entry as [string, unknown];
          if (key.length === 0 || key.length > 1024 || (itemSpec && !isValidPropKey(itemSpec, key))) return { ok: false, reason: 'bad-key' };
          const reason = checkWrittenValue(value, referenced)
            ?? checkTypedProp(kind, op.id, key, value)
            ?? (itemSpec ? checkListValue(itemSpec, key, value) : null);
          if (reason) return { ok: false, reason };
          collectMissingBlobs(value, scratch, blobs, missing);
        }
        const fixed: Op = scratch.has(op.parent)
          ? { t: 'c', id: op.id, parent: op.parent, field: op.field, pos: freePosition(scratch, op.parent, op.field, op.id, op.pos), props: op.props }
          : { t: 'c', id: op.id, parent: op.parent, field: op.field, pos: op.pos, props: op.props };
        const denied = deniedByRules(scratch, fixed, options);
        if (denied) return { ok: false, reason: denied };
        out.push(fixed);
        applyForValidation(scratch, fixed);
        break;
      }
      case 'd': {
        if (op.id === ROOT_OBJECT_ID) return { ok: false, reason: 'root-protected' };
        const fixed: Op = { t: 'd', id: op.id };
        const denied = deniedByRules(scratch, fixed, options);
        if (denied) return { ok: false, reason: denied };
        out.push(fixed);
        applyForValidation(scratch, fixed);
        break;
      }
      case 's': {
        if (typeof op.k !== 'string' || op.k.length === 0 || op.k.length > 1024) return { ok: false, reason: 'bad-key' };
        const present = 'v' in op;
        const object = scratch.get(op.id);
        // Retirer une propriété existante est toujours permis (nettoyage d'un
        // état ancien) ; écrire suit le modèle.
        const removingExisting = !present && object?.props.has(op.k) === true;
        if (object && !removingExisting && !isValidPropKey(objectSpec(scratch, op.id, specs), op.k)) {
          return { ok: false, reason: 'bad-key' };
        }
        if (present) {
          const kind = object ? typedKindOf(op.id, object.parent, object.field) : null;
          const reason = checkWrittenValue(op.v, referenced)
            ?? checkTypedProp(kind, op.id, op.k, op.v)
            ?? (object ? checkListValue(objectSpec(scratch, op.id, specs), op.k, op.v) : null);
          if (reason) return { ok: false, reason };
          collectMissingBlobs(op.v, scratch, blobs, missing);
        }
        const fixed: Op = present ? { t: 's', id: op.id, k: op.k, v: op.v } : { t: 's', id: op.id, k: op.k };
        const denied = deniedByRules(scratch, fixed, options);
        if (denied) return { ok: false, reason: denied };
        out.push(fixed);
        applyForValidation(scratch, fixed);
        break;
      }
      case 'm': {
        if (op.id === ROOT_OBJECT_ID) return { ok: false, reason: 'root-protected' };
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
  // Segments gardés : ceux que les en-têtes du lot référencent (un client
  // honnête n'en envoie pas d'autres), vérifiés un par un.
  const kept: Record<string, string> = {};
  for (const id of referenced) {
    if (!Object.hasOwn(blobs, id)) continue;
    const json = blobs[id];
    const reason = inspectRouteChunk(id, json);
    if (reason) return { ok: false, reason };
    kept[id] = json;
  }
  return { ok: true, ops: out, blobs: kept };
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
    if (!store.hasBlob(id) && !Object.hasOwn(blobs, id)) missing.add(id);
  }
}

function applyForValidation(store: ObjectStore, op: Op): void {
  applyOp(store, op);
}

/** Refus d'une opération par les règles d'auteur (avant de l'appliquer au brouillon). */
function deniedByRules(store: ObjectStore, op: Op, options: BatchCheckOptions): string | null {
  return options.userId === undefined ? null : checkCommentOp(store, op, options.userId);
}
