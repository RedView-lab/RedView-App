import { generateNKeysBetween } from 'fractional-indexing';

import { deepEqual } from '@/features/itineraryPanel/lib/project/deepEqual';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { chunkRoutePoints } from '../routeChunks';
import { fieldSpec, PROJECT_DOCUMENT_SPEC, type ListSpec, type MergeSpec, type RecordSpec } from '../schema';
import { comparePositions, type DocObject, type ObjectStore } from './objects';
import type { Op } from './ops';
import { childKey, childObjectId, decodePath, encodePath, ROOT_OBJECT_ID } from './paths';

/**
 * Document → opérations (cf. ops.ts), guidé par le modèle de fusion
 * (schema.ts) :
 *  - réglages (`record`) : une propriété par clé (`priorities.elevation`) ;
 *  - listes : un objet par élément, à sa position fractionnaire ;
 *  - tracé : en-tête (métadonnées + ids de segments) en propriété, segments
 *    en blobs adressés par leur contenu ;
 *  - le reste : une propriété atomique.
 * Une valeur qui ne correspond pas à sa spécification (liste vide ou sans
 * ids, objet vide, null…) est une propriété atomique : rien n'est perdu.
 *
 * `diffDocument` compare deux versions par références (une partie inchangée
 * n'est pas parcourue) et produit le minimum d'opérations : une valeur égale
 * n'est jamais réécrite, un élément déplacé ne produit qu'un `m` (les
 * éléments de la plus longue sous-suite déjà ordonnée gardent leur position).
 */

/** Propriété d'un objet dont la spécification est atomique (fichier .fit…). */
export const ATOMIC_VALUE_KEY = '$v';
const ROUTE_HEADER_VERSION = 1;

type PlainRecord = Record<string, unknown>;

export interface RouteHeader {
  v: number;
  meta: PlainRecord;
  points: string[];
  originalPoints?: string[];
}

export interface DocumentChanges {
  ops: Op[];
  /** Segments de tracé introduits par ces opérations (id → JSON). */
  blobs: Map<string, string>;
}

export function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyRecord(value: unknown): value is PlainRecord {
  return isPlainRecord(value) && Object.keys(value).some((key) => value[key] !== undefined);
}

/** Clés d'une liste stockable en objets (non vide, clés présentes et uniques), sinon null. */
function listKeys(value: unknown, spec: ListSpec): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const key = spec.keyOf(item);
    if (key === null || seen.has(key)) return null;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function isRouteValue(value: unknown): value is PlainRecord & { points: unknown[] } {
  return isPlainRecord(value) && Array.isArray(value.points);
}

export function isRouteHeader(value: unknown): value is RouteHeader {
  return isPlainRecord(value)
    && value.v === ROUTE_HEADER_VERSION
    && isPlainRecord(value.meta)
    && Array.isArray(value.points);
}

/** Segments référencés par les en-têtes de tracé du magasin (les autres peuvent être purgés). */
export function referencedRouteBlobs(store: ObjectStore): Set<string> {
  const ids = new Set<string>();
  for (const object of store.values()) {
    for (const value of object.props.values()) {
      if (!isRouteHeader(value)) continue;
      for (const id of value.points) ids.add(id);
      for (const id of value.originalPoints ?? []) ids.add(id);
    }
  }
  return ids;
}

function addChunks(points: readonly unknown[], blobs: Map<string, string>, isKnown: (id: string) => boolean): string[] {
  const chunks = chunkRoutePoints(points as readonly { lat?: unknown; lon?: unknown }[]);
  for (const chunk of chunks) {
    if (!isKnown(chunk.id)) blobs.set(chunk.id, chunk.json);
  }
  return chunks.map((chunk) => chunk.id);
}

/**
 * En-tête d'un tracé ; ses segments pas encore connus (`isKnown`) sont
 * ajoutés à `blobs` : une fenêtre de tracé modifiée n'envoie que ses segments.
 */
function routeHeader(
  route: PlainRecord & { points: unknown[] },
  blobs: Map<string, string>,
  isKnown: (id: string) => boolean = () => false,
): RouteHeader {
  const { points, originalPoints, ...meta } = route;
  const header: RouteHeader = { v: ROUTE_HEADER_VERSION, meta, points: addChunks(points, blobs, isKnown) };
  if (Array.isArray(originalPoints)) header.originalPoints = addChunks(originalPoints, blobs, isKnown);
  return header;
}

/** Spécification d'un objet du document à plat (racine, ou élément d'une liste). */
export function objectSpec(store: ObjectStore, id: string, cache?: Map<string, MergeSpec>): MergeSpec {
  if (id === ROOT_OBJECT_ID) return PROJECT_DOCUMENT_SPEC;
  const cached = cache?.get(id);
  if (cached) return cached;
  const object = store.get(id);
  if (!object || object.parent === null || object.field === null) return { kind: 'atomic' };
  const parentSpec = objectSpec(store, object.parent, cache);
  const listSpec = specAtPath(parentSpec, decodePath(object.field));
  const spec = listSpec?.kind === 'list' ? listSpec.item : { kind: 'atomic' as const };
  cache?.set(id, spec);
  return spec;
}

/** Spécification au bout d'un chemin de clés dans un objet `record`. */
export function specAtPath(spec: MergeSpec, segments: readonly string[]): MergeSpec | null {
  let current: MergeSpec = spec;
  for (const segment of segments) {
    if (current.kind !== 'record') return null;
    current = fieldSpec(current, segment);
  }
  return current;
}

// ── Création ────────────────────────────────────────────────────────────────

interface Context {
  ops: Op[];
  blobs: Map<string, string>;
  /** Segment déjà connu (du magasin, donc du serveur ou d'un lot en attente). */
  isKnown: (id: string) => boolean;
}

interface Flattened {
  props: Array<[string, unknown]>;
  lists: Array<{ field: string; spec: ListSpec; items: unknown[]; keys: string[] }>;
}

function flattenRecord(spec: RecordSpec, value: PlainRecord, prefix: string[], out: Flattened, ctx: Context): void {
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    const field = fieldSpec(spec, key);
    const path = [...prefix, key];
    const encoded = encodePath(path);
    if (field.kind === 'record' && isNonEmptyRecord(inner)) {
      flattenRecord(field, inner, path, out, ctx);
    } else if (field.kind === 'list' && listKeys(inner, field)) {
      out.lists.push({ field: encoded, spec: field, items: inner as unknown[], keys: listKeys(inner, field)! });
    } else if (field.kind === 'route' && isRouteValue(inner)) {
      out.props.push([encoded, routeHeader(inner, ctx.blobs, ctx.isKnown)]);
    } else {
      out.props.push([encoded, inner]);
    }
  }
}

/** Opérations qui créent l'élément `value` (et ses listes) à la position `pos`. */
function createObjectOps(
  id: string,
  parent: string,
  field: string,
  pos: string,
  spec: MergeSpec,
  value: unknown,
  ctx: Context,
): void {
  if (spec.kind !== 'record' || !isPlainRecord(value)) {
    ctx.ops.push({ t: 'c', id, parent, field, pos, props: [[ATOMIC_VALUE_KEY, value]] });
    return;
  }
  const flat: Flattened = { props: [], lists: [] };
  flattenRecord(spec, value, [], flat, ctx);
  ctx.ops.push({ t: 'c', id, parent, field, pos, props: flat.props });
  for (const list of flat.lists) createListOps(id, list.field, list.spec, list.items, list.keys, null, null, ctx);
}

function createListOps(
  owner: string,
  field: string,
  spec: ListSpec,
  items: readonly unknown[],
  keys: readonly string[],
  after: string | null,
  before: string | null,
  ctx: Context,
): void {
  const positions = generateNKeysBetween(after, before, items.length);
  items.forEach((item, index) => {
    createObjectOps(childObjectId(owner, field, keys[index]), owner, field, positions[index], spec.item, item, ctx);
  });
}

// ── Différence ──────────────────────────────────────────────────────────────

/**
 * Opérations qui font passer `store` (relu en `prev`) à `next`. `prev` null :
 * `store` est vide (premier remplissage).
 */
export function diffDocument(store: ObjectStore, prev: ProjectDocument | null, next: ProjectDocument): DocumentChanges {
  const ctx: Context = { ops: [], blobs: new Map(), isKnown: (id) => store.hasBlob(id) };
  diffRecord(store, ROOT_OBJECT_ID, PROJECT_DOCUMENT_SPEC, [], (prev ?? {}) as unknown as PlainRecord, next as unknown as PlainRecord, ctx);
  return ctx;
}

/** Document complet → magasin vide : opérations de premier remplissage. */
export function documentOps(store: ObjectStore, document: ProjectDocument): DocumentChanges {
  return diffDocument(store, null, document);
}

function setProp(store: ObjectStore, id: string, key: string, value: unknown, ctx: Context): void {
  const object = store.get(id);
  if (object?.props.has(key) && deepEqual(object.props.get(key), value)) return;
  ctx.ops.push({ t: 's', id, k: key, v: value });
}

function deleteProp(store: ObjectStore, id: string, key: string, ctx: Context): void {
  if (store.get(id)?.props.has(key)) ctx.ops.push({ t: 's', id, k: key });
}

function deleteSubProps(store: ObjectStore, id: string, prefix: string, ctx: Context): void {
  const object = store.get(id);
  if (!object) return;
  for (const key of object.props.keys()) {
    if (key.startsWith(`${prefix}.`)) ctx.ops.push({ t: 's', id, k: key });
  }
}

function deleteChildren(store: ObjectStore, id: string, field: string, ctx: Context, nested = false): void {
  const object = store.get(id);
  if (!object) return;
  for (const [childField, ids] of object.children) {
    if (childField === field || (nested && childField.startsWith(`${field}.`))) {
      for (const childId of ids) ctx.ops.push({ t: 'd', id: childId });
    }
  }
}

/** Retire un champ sous toutes ses formes (valeur, clés, listes imbriquées). */
function removeField(store: ObjectStore, id: string, encoded: string, ctx: Context): void {
  deleteProp(store, id, encoded, ctx);
  deleteSubProps(store, id, encoded, ctx);
  deleteChildren(store, id, encoded, ctx, true);
}

function diffRecord(
  store: ObjectStore,
  id: string,
  spec: RecordSpec,
  prefix: string[],
  prev: PlainRecord,
  next: PlainRecord,
  ctx: Context,
): void {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const before = prev[key];
    const after = next[key];
    if (before === after) continue;
    const field = fieldSpec(spec, key);
    const path = [...prefix, key];
    const encoded = encodePath(path);
    if (after === undefined) {
      removeField(store, id, encoded, ctx);
      continue;
    }
    switch (field.kind) {
      case 'atomic':
        setProp(store, id, encoded, after, ctx);
        break;
      case 'record':
        if (isNonEmptyRecord(after)) {
          // Anciennes formes au même chemin (valeur atomique, liste) retirées ;
          // les listes imbriquées du réglage (`rhythm.pauseIntervals`) en font
          // partie : diffRecord s'en occupe.
          deleteProp(store, id, encoded, ctx);
          deleteChildren(store, id, encoded, ctx);
          diffRecord(store, id, field, path, isNonEmptyRecord(before) ? before : {}, after, ctx);
        } else {
          deleteSubProps(store, id, encoded, ctx);
          deleteChildren(store, id, encoded, ctx, true);
          setProp(store, id, encoded, after, ctx);
        }
        break;
      case 'list': {
        const nextKeys = listKeys(after, field);
        if (nextKeys) {
          deleteProp(store, id, encoded, ctx);
          diffList(store, id, encoded, field, listKeys(before, field) ? (before as unknown[]) : [], after as unknown[], nextKeys, ctx);
        } else {
          deleteChildren(store, id, encoded, ctx);
          setProp(store, id, encoded, after, ctx);
        }
        break;
      }
      case 'route':
        setProp(store, id, encoded, isRouteValue(after) ? routeHeader(after, ctx.blobs, ctx.isKnown) : after, ctx);
        break;
    }
  }
}

function diffObject(store: ObjectStore, id: string, spec: MergeSpec, prev: unknown, next: unknown, ctx: Context): void {
  if (spec.kind === 'record' && isPlainRecord(next)) {
    // Ancienne valeur atomique d'un élément devenu un objet : retirée.
    deleteProp(store, id, ATOMIC_VALUE_KEY, ctx);
    diffRecord(store, id, spec, [], isPlainRecord(prev) ? prev : {}, next, ctx);
    return;
  }
  const object = store.get(id);
  for (const key of object?.props.keys() ?? []) {
    if (key !== ATOMIC_VALUE_KEY) ctx.ops.push({ t: 's', id, k: key });
  }
  setProp(store, id, ATOMIC_VALUE_KEY, next, ctx);
}

/** Plus longue sous-suite croissante (indices dans `objects`), objets absents exclus. */
function longestOrderedRun(objects: ReadonlyArray<DocObject | undefined>): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(objects.length).fill(-1);
  objects.forEach((object, index) => {
    if (!object) return;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (comparePositions(objects[tails[mid]]!, object) < 0) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  const kept = new Set<number>();
  let cursor = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (cursor >= 0) {
    kept.add(cursor);
    cursor = previous[cursor];
  }
  return kept;
}

function diffList(
  store: ObjectStore,
  owner: string,
  field: string,
  spec: ListSpec,
  prev: readonly unknown[],
  next: readonly unknown[],
  nextKeys: readonly string[],
  ctx: Context,
): void {
  const nextKeySet = new Set(nextKeys);
  for (const child of store.childrenOf(owner, field)) {
    if (!nextKeySet.has(childKey(child.id))) ctx.ops.push({ t: 'd', id: child.id });
  }
  const prevByKey = new Map<string, unknown>();
  for (const item of prev) {
    const key = spec.keyOf(item);
    if (key !== null) prevByKey.set(key, item);
  }
  const ids = nextKeys.map((key) => childObjectId(owner, field, key));
  const existing = ids.map((id) => store.get(id));

  if (!assignPositions(owner, field, spec, next, ids, existing, longestOrderedRun(existing), ctx)) {
    // Positions concurrentes égales (jamais attendu après correction serveur) :
    // toute la liste est repositionnée.
    const positions = generateNKeysBetween(null, null, next.length);
    next.forEach((item, index) => {
      if (existing[index]) ctx.ops.push({ t: 'm', id: ids[index], pos: positions[index] });
      else createObjectOps(ids[index], owner, field, positions[index], spec.item, item, ctx);
    });
  }

  next.forEach((item, index) => {
    if (!existing[index]) return;
    const before = prevByKey.get(nextKeys[index]);
    if (before !== item) diffObject(store, ids[index], spec.item, before, item, ctx);
  });
}

/** Positions des éléments hors de la sous-suite gardée ; false si les bornes sont incohérentes. */
function assignPositions(
  owner: string,
  field: string,
  spec: ListSpec,
  next: readonly unknown[],
  ids: readonly string[],
  existing: ReadonlyArray<DocObject | undefined>,
  kept: ReadonlySet<number>,
  ctx: Context,
): boolean {
  const ops: Op[] = [];
  const created: Context = { ops: [], blobs: ctx.blobs, isKnown: ctx.isKnown };
  let lastPos: string | null = null;
  let index = 0;
  while (index < next.length) {
    if (kept.has(index)) {
      lastPos = existing[index]!.pos;
      index += 1;
      continue;
    }
    let end = index;
    while (end < next.length && !kept.has(end)) end += 1;
    const upper = end < next.length ? existing[end]!.pos : null;
    if (lastPos !== null && upper !== null && lastPos >= upper) return false;
    const positions = generateNKeysBetween(lastPos, upper, end - index);
    for (let cursor = index; cursor < end; cursor += 1) {
      const pos = positions[cursor - index];
      if (existing[cursor]) ops.push({ t: 'm', id: ids[cursor], pos });
      else createObjectOps(ids[cursor], owner, field, pos, spec.item, next[cursor], created);
    }
    lastPos = positions[positions.length - 1];
    index = end;
  }
  ctx.ops.push(...ops, ...created.ops);
  return true;
}
