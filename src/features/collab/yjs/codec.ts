import * as Y from 'yjs';

import { deepEqual } from '@/features/itineraryPanel/lib/project/deepEqual';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { chunkRoutePoints, joinRouteChunks } from '../routeChunks';
import { fieldSpec, PROJECT_DOCUMENT_SPEC, type ListSpec, type MergeSpec, type RecordSpec } from '../schema';

/**
 * Codage du document partagé dans un `Y.Doc`, selon le modèle de fusion
 * (schema.ts) :
 *  - `record` → `Y.Map` (une entrée par clé) ;
 *  - `list`   → `Y.Map { $order: Y.Array<clé>, $items: Y.Map<clé, élément> }` :
 *    l'ordre et le contenu sont séparés, un déplacement ne recrée pas
 *    l'élément (une édition concurrente de l'élément est gardée) ;
 *  - `route`  → en-tête atomique `{ v, meta, points: ids, originalPoints? }`
 *    + magasin de segments `${clé}$chunks` (Y.Map id → JSON), en ajout seul ;
 *  - `atomic` → valeur JSON.
 * Une valeur qui ne correspond pas à sa spécification (liste sans ids,
 * objet attendu mais absent…) est stockée atomique : rien n'est perdu.
 *
 * Écriture (`writeDocument`) : différence entre le document précédent (tel
 * que relu du Y.Doc) et le suivant ; une sous-partie de même référence n'est
 * pas parcourue, une valeur égale n'est pas réécrite.
 * Lecture (`DocumentReader`) : matérialise le document en réutilisant les
 * objets des parties inchangées depuis la lecture précédente.
 */

export const ROOT_MAP_NAME = 'project';
const LIST_ORDER = '$order';
const LIST_ITEMS = '$items';
const CHUNKS_SUFFIX = '$chunks';
const ROUTE_HEADER_VERSION = 1;

type PlainRecord = Record<string, unknown>;

export interface RouteHeader {
  v: number;
  meta: PlainRecord;
  points: string[];
  originalPoints?: string[];
}

export function rootMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(ROOT_MAP_NAME);
}

/** Clé réservée au codage (jamais une clé du document). */
export function isReservedKey(key: string): boolean {
  return key.includes('$');
}

export function chunkStoreKey(routeKey: string): string {
  return `${routeKey}${CHUNKS_SUFFIX}`;
}

/** Magasin de segments de tracé (pour `deleteFilter` de l'undo : jamais supprimés). */
export function isRouteChunkStore(type: Y.AbstractType<unknown> | null | undefined): boolean {
  const key = type?._item?.parentSub;
  return typeof key === 'string' && key.endsWith(CHUNKS_SUFFIX);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Y.AbstractType || value instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isListContainer(value: unknown): value is Y.Map<unknown> {
  return value instanceof Y.Map && value.get(LIST_ORDER) instanceof Y.Array && value.get(LIST_ITEMS) instanceof Y.Map;
}

export function isRouteHeader(value: unknown): value is RouteHeader {
  return isPlainRecord(value)
    && value.v === ROUTE_HEADER_VERSION
    && isPlainRecord(value.meta)
    && Array.isArray(value.points);
}

/** Clés d'une liste, ou null si un élément n'est pas identifiable / est en double. */
function listKeys(items: readonly unknown[], keyOf: ListSpec['keyOf']): string[] | null {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || seen.has(key) || isReservedKey(key)) return null;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// ── Écriture ────────────────────────────────────────────────────────────────

/**
 * Écrit dans `root` la différence `prev` → `next`. `prev` doit être le
 * document tel que relu de `root` (null : `root` vide). À appeler dans une
 * transaction (`ydoc.transact`).
 */
export function writeDocument(root: Y.Map<unknown>, prev: ProjectDocument | null, next: ProjectDocument): void {
  writeRecord(root, PROJECT_DOCUMENT_SPEC, (prev ?? {}) as PlainRecord, next as unknown as PlainRecord);
}

function writeRecord(target: Y.Map<unknown>, spec: RecordSpec, prev: PlainRecord, next: PlainRecord): void {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (isReservedKey(key)) continue;
    const before = prev[key];
    const after = next[key];
    if (before === after && (after === undefined) === !target.has(key)) continue;
    writeField(target, key, fieldSpec(spec, key), before, after);
  }
}

function writeAtomic(parent: Y.Map<unknown>, key: string, prev: unknown, next: unknown): void {
  const current = parent.get(key);
  if (!parent.has(key) || current instanceof Y.AbstractType || !deepEqual(prev, next)) {
    parent.set(key, next);
  }
}

function writeField(parent: Y.Map<unknown>, key: string, spec: MergeSpec, prev: unknown, next: unknown): void {
  if (next === undefined) {
    if (parent.has(key)) parent.delete(key);
    return;
  }
  switch (spec.kind) {
    case 'atomic':
      writeAtomic(parent, key, prev, next);
      return;
    case 'record': {
      if (!isPlainRecord(next)) {
        writeAtomic(parent, key, prev, next);
        return;
      }
      let target = parent.get(key);
      let before = isPlainRecord(prev) ? prev : {};
      if (!(target instanceof Y.Map)) {
        target = new Y.Map<unknown>();
        parent.set(key, target);
        before = {};
      }
      writeRecord(target as Y.Map<unknown>, spec, before, next);
      return;
    }
    case 'list': {
      const nextKeys = Array.isArray(next) ? listKeys(next, spec.keyOf) : null;
      if (!Array.isArray(next) || !nextKeys) {
        writeAtomic(parent, key, prev, next);
        return;
      }
      let container = parent.get(key);
      let before: readonly unknown[] = Array.isArray(prev) && listKeys(prev, spec.keyOf) ? prev : [];
      if (!isListContainer(container)) {
        const created = new Y.Map<unknown>();
        parent.set(key, created);
        created.set(LIST_ORDER, new Y.Array<string>());
        created.set(LIST_ITEMS, new Y.Map<unknown>());
        container = created;
        before = [];
      }
      writeList(container as Y.Map<unknown>, spec, before, next, nextKeys);
      return;
    }
    case 'route':
      writeRoute(parent, key, prev, next);
      return;
  }
}

function writeList(
  container: Y.Map<unknown>,
  spec: ListSpec,
  prev: readonly unknown[],
  next: readonly unknown[],
  nextKeys: string[],
): void {
  const order = container.get(LIST_ORDER) as Y.Array<string>;
  const items = container.get(LIST_ITEMS) as Y.Map<unknown>;
  const prevKeys = listKeys(prev, spec.keyOf) ?? [];
  const prevByKey = new Map(prevKeys.map((key, index) => [key, prev[index]]));
  const nextKeySet = new Set(nextKeys);

  for (const key of prevKeys) {
    if (!nextKeySet.has(key)) items.delete(key);
  }
  next.forEach((item, index) => {
    const key = nextKeys[index];
    const before = prevByKey.get(key);
    if (before === item && items.has(key)) return;
    writeField(items, key, spec.item, items.has(key) ? before : undefined, item);
  });

  if (sameStrings(prevKeys, nextKeys)) return;
  // Ordre réel (doublons possibles après des déplacements concurrents) :
  // seule la partie qui diffère, entre préfixe et suffixe communs, est réécrite.
  const current = order.toArray();
  let start = 0;
  while (start < current.length && start < nextKeys.length && current[start] === nextKeys[start]) start += 1;
  let endCurrent = current.length;
  let endNext = nextKeys.length;
  while (endCurrent > start && endNext > start && current[endCurrent - 1] === nextKeys[endNext - 1]) {
    endCurrent -= 1;
    endNext -= 1;
  }
  if (endCurrent > start) order.delete(start, endCurrent - start);
  if (endNext > start) order.insert(start, nextKeys.slice(start, endNext));
}

function addRouteChunks(store: Y.Map<unknown>, points: readonly unknown[]): string[] {
  const chunks = chunkRoutePoints(points as readonly { lat?: unknown; lon?: unknown }[]);
  for (const chunk of chunks) {
    if (!store.has(chunk.id)) store.set(chunk.id, chunk.json);
  }
  return chunks.map((chunk) => chunk.id);
}

function writeRoute(parent: Y.Map<unknown>, key: string, prev: unknown, next: unknown): void {
  if (!isPlainRecord(next) || !Array.isArray(next.points)) {
    writeAtomic(parent, key, prev, next);
    return;
  }
  const storeKey = chunkStoreKey(key);
  let store = parent.get(storeKey);
  if (!(store instanceof Y.Map)) {
    store = new Y.Map<unknown>();
    parent.set(storeKey, store);
  }
  const { points, originalPoints, ...meta } = next;
  const header: RouteHeader = {
    v: ROUTE_HEADER_VERSION,
    meta,
    points: addRouteChunks(store as Y.Map<unknown>, points as unknown[]),
  };
  if (Array.isArray(originalPoints)) header.originalPoints = addRouteChunks(store as Y.Map<unknown>, originalPoints);
  const current = parent.get(key);
  if (!isRouteHeader(current) || !deepEqual(current, header)) parent.set(key, header);
}

// ── Lecture ─────────────────────────────────────────────────────────────────

const JOINED_ROUTE_CACHE_SIZE = 32;

/**
 * Matérialise le document d'un Y.Doc. Les objets des parties inchangées sont
 * réutilisés d'une lecture à l'autre (`invalidate` après chaque transaction) :
 * un itinéraire non touché par une modification distante garde sa référence,
 * comme dans le ProjectStore.
 */
export class DocumentReader {
  /** Par type Yjs (objet) : sa forme matérialisée. */
  private readonly cache = new Map<object, unknown>();
  private readonly chunkCache = new Map<string, readonly unknown[]>();
  private readonly joinedRoutes = new Map<string, unknown[]>();
  /** Segments introuvables rencontrés (document incohérent : jamais attendu). */
  missingChunks = 0;

  invalidate(transaction: Y.Transaction): void {
    for (const type of transaction.changedParentTypes.keys()) this.cache.delete(type);
    for (const type of transaction.changed.keys()) this.cache.delete(type);
  }

  read(root: Y.Map<unknown>): ProjectDocument {
    return this.readRecord(root, PROJECT_DOCUMENT_SPEC) as unknown as ProjectDocument;
  }

  private readRecord(source: Y.Map<unknown>, spec: RecordSpec): PlainRecord {
    const cached = this.cache.get(source);
    if (cached) return cached as PlainRecord;
    const out: PlainRecord = {};
    source.forEach((value, key) => {
      if (isReservedKey(key)) return;
      const read = this.readField(source, key, fieldSpec(spec, key), value);
      if (read !== undefined) out[key] = read;
    });
    this.cache.set(source, out);
    return out;
  }

  private readField(parent: Y.Map<unknown>, key: string, spec: MergeSpec, value: unknown): unknown {
    switch (spec.kind) {
      case 'record':
        return value instanceof Y.Map ? this.readRecord(value, spec) : plainValue(value);
      case 'list':
        return isListContainer(value) ? this.readList(value, spec) : plainValue(value);
      case 'route':
        return isRouteHeader(value) ? this.readRoute(parent, key, value) : plainValue(value);
      default:
        return plainValue(value);
    }
  }

  private readList(container: Y.Map<unknown>, spec: ListSpec): unknown[] {
    const cached = this.cache.get(container);
    if (cached) return cached as unknown[];
    const order = container.get(LIST_ORDER) as Y.Array<string>;
    const items = container.get(LIST_ITEMS) as Y.Map<unknown>;
    const out: unknown[] = [];
    const seen = new Set<string>();
    // Doublons (déplacements concurrents) : la première occurrence compte.
    for (const key of order.toArray()) {
      if (seen.has(key) || !items.has(key)) continue;
      seen.add(key);
      out.push(this.readField(items, key, spec.item, items.get(key)));
    }
    // Élément sans place dans l'ordre (jamais attendu) : gardé, à la fin, dans un ordre stable.
    const orphans = [...items.keys()].filter((key) => !seen.has(key) && !isReservedKey(key)).sort();
    for (const key of orphans) out.push(this.readField(items, key, spec.item, items.get(key)));
    this.cache.set(container, out);
    return out;
  }

  private readChunk(store: Y.Map<unknown> | undefined, id: string): readonly unknown[] | null {
    const cached = this.chunkCache.get(id);
    if (cached) return cached;
    const json = store?.get(id);
    if (typeof json !== 'string') return null;
    const points = JSON.parse(json) as unknown[];
    this.chunkCache.set(id, points);
    return points;
  }

  private joinPoints(store: Y.Map<unknown> | undefined, ids: readonly string[]): unknown[] {
    const cacheKey = ids.join(',');
    const cached = this.joinedRoutes.get(cacheKey);
    if (cached) return cached;
    const points = joinRouteChunks(ids, (id) => this.readChunk(store, id));
    if (!points) {
      this.missingChunks += 1;
      return [];
    }
    if (this.joinedRoutes.size >= JOINED_ROUTE_CACHE_SIZE) {
      this.joinedRoutes.delete(this.joinedRoutes.keys().next().value as string);
    }
    this.joinedRoutes.set(cacheKey, points);
    return points;
  }

  private readRoute(parent: Y.Map<unknown>, key: string, header: RouteHeader): PlainRecord {
    const store = parent.get(chunkStoreKey(key));
    const chunks = store instanceof Y.Map ? (store as Y.Map<unknown>) : undefined;
    const route: PlainRecord = { ...header.meta, points: this.joinPoints(chunks, header.points) };
    if (header.originalPoints) route.originalPoints = this.joinPoints(chunks, header.originalPoints);
    return route;
  }
}

function plainValue(value: unknown): unknown {
  return value instanceof Y.AbstractType ? (value.toJSON() as unknown) : value;
}

/** Lecture ponctuelle (sans cache entre lectures). */
export function readDocument(ydoc: Y.Doc): ProjectDocument {
  return new DocumentReader().read(rootMap(ydoc));
}
