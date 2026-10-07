import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { joinRouteChunks } from '../routeChunks';
import type { MergeSpec } from '../schema';
import { ATOMIC_VALUE_KEY, isPlainRecord, isRouteHeader, isRouteValue, objectSpec, specAtPath, type RouteHeader } from './diff';
import type { DocObject, ObjectStore } from './objects';
import { childKey, decodePath } from './paths';

/**
 * Document à plat → `ProjectDocument`. Chaque objet matérialisé est mis en
 * cache par identité : un objet non remplacé (cf. objects.ts) redonne le même
 * objet JavaScript, de sorte qu'une modification distante d'un itinéraire ne
 * recrée ni les autres itinéraires ni les points des tracés inchangés (les
 * rendus mis en cache par référence restent valables).
 *
 * Précédence quand deux formes coexistent après une fusion (rare) : des clés
 * (`priorities.elevation`) l'emportent sur une valeur atomique au même chemin
 * (`priorities`), et une liste d'éléments sur une valeur atomique.
 */

type PlainRecord = Record<string, unknown>;

const ROUTE_CACHE_SIZE = 32;

export class Materializer {
  private readonly cache = new WeakMap<DocObject, unknown>();
  /** Tracé matérialisé par en-tête (même en-tête : même objet, mêmes points). */
  private readonly routeValues = new WeakMap<RouteHeader, PlainRecord>();
  private readonly specs = new Map<string, MergeSpec>();
  private readonly chunks: Map<string, readonly unknown[]>;
  private readonly routes = new Map<string, unknown[]>();
  /** Segments introuvables rencontrés (document incohérent : jamais attendu). */
  missingBlobs = 0;

  /**
   * `chunks` : segments décodés partagés entre matérialiseurs (adressés par leur
   * contenu, ils ne changent jamais) — le vérificateur du simulateur en refait
   * une neuve après chaque action. Par défaut, propres à ce matérialiseur.
   */
  constructor({ chunks }: { chunks?: Map<string, readonly unknown[]> } = {}) {
    this.chunks = chunks ?? new Map();
  }

  materialize(store: ObjectStore): ProjectDocument {
    return this.object(store, store.root()) as ProjectDocument;
  }

  /**
   * Déclare `document` comme matérialisation de `store` (modification locale :
   * les opérations ont été tirées de ce document, puis appliquées) : les
   * matérialisations suivantes redonnent ses propres objets là où rien n'a
   * changé, et l'application garde ses références (rendus, mémos).
   */
  adopt(store: ObjectStore, document: ProjectDocument): void {
    this.adoptObject(store, store.root(), document);
  }

  private adoptObject(store: ObjectStore, object: DocObject, value: unknown): void {
    this.cache.set(object, value);
    const spec = objectSpec(store, object.id, this.specs);
    if (spec.kind !== 'record' || !isPlainRecord(value)) return;
    for (const [path, raw] of object.props) {
      if (!isRouteHeader(raw)) continue;
      const segments = decodePath(path);
      if (specAtPath(spec, segments)?.kind !== 'route') continue;
      const route = valueAtPath(value, segments);
      if (isRouteValue(route)) this.routeValues.set(raw, route);
    }
    for (const [field, ids] of object.children) {
      const segments = decodePath(field);
      const listSpec = specAtPath(spec, segments);
      const list = valueAtPath(value, segments);
      if (listSpec?.kind !== 'list' || !Array.isArray(list) || list.length !== ids.length) continue;
      ids.forEach((id, index) => {
        const child = store.get(id);
        if (child && listSpec.keyOf(list[index]) === childKey(id)) this.adoptObject(store, child, list[index]);
      });
    }
  }

  private object(store: ObjectStore, object: DocObject): unknown {
    if (this.cache.has(object)) return this.cache.get(object);
    const spec = objectSpec(store, object.id, this.specs);
    let value: unknown;
    if (spec.kind !== 'record') {
      value = object.props.get(ATOMIC_VALUE_KEY);
    } else if (object.props.has(ATOMIC_VALUE_KEY) && object.props.size === 1 && object.children.size === 0) {
      value = object.props.get(ATOMIC_VALUE_KEY);
    } else {
      const out: PlainRecord = {};
      const built = new WeakSet<object>([out]);
      for (const [path, raw] of object.props) {
        if (path === ATOMIC_VALUE_KEY) continue;
        const segments = decodePath(path);
        const fieldSpec = specAtPath(spec, segments);
        const leaf = fieldSpec?.kind === 'route' && isRouteHeader(raw) ? this.route(store, raw) : raw;
        insert(out, segments, leaf, built);
      }
      for (const [field, ids] of object.children) {
        const items = ids.map((id) => store.get(id)).filter((child): child is DocObject => !!child);
        insertList(out, decodePath(field), items.map((child) => this.object(store, child)), built);
      }
      value = out;
    }
    this.cache.set(object, value);
    return value;
  }

  private chunk(store: ObjectStore, id: string): readonly unknown[] | null {
    const cached = this.chunks.get(id);
    if (cached) return cached;
    const json = store.getBlob(id);
    if (json === undefined) return null;
    const points = JSON.parse(json) as unknown[];
    this.chunks.set(id, points);
    return points;
  }

  private points(store: ObjectStore, ids: readonly string[]): unknown[] {
    const key = ids.join(',');
    const cached = this.routes.get(key);
    if (cached) return cached;
    const points = joinRouteChunks(ids, (id) => this.chunk(store, id));
    if (!points) {
      this.missingBlobs += 1;
      return [];
    }
    if (this.routes.size >= ROUTE_CACHE_SIZE) this.routes.delete(this.routes.keys().next().value as string);
    this.routes.set(key, points);
    return points;
  }

  private route(store: ObjectStore, header: RouteHeader): PlainRecord {
    const cached = this.routeValues.get(header);
    if (cached) return cached;
    const route: PlainRecord = { ...header.meta, points: this.points(store, header.points) };
    if (header.originalPoints) route.originalPoints = this.points(store, header.originalPoints);
    this.routeValues.set(header, route);
    return route;
  }
}

// ── JSON du document, sans le construire ─────────────────────────────────────

/** Valeur déjà au format JSON (feuille). `undefined` : absente (clé omise, `null` dans une liste). */
class RawJson {
  readonly json: string | undefined;

  constructor(json: string | undefined) {
    this.json = json;
  }
}

type JsonTree = RawJson | JsonTree[] | { [key: string]: JsonTree };

/**
 * JSON du document matérialisé, identique à
 * `JSON.stringify(new Materializer().materialize(store))`, mais sans en
 * construire les valeurs : les segments de tracé (JSON des points) sont
 * recollés tels quels, rien n'est relu ni gardé. Pour le point de sauvegarde
 * du serveur (`projects.data`) : ni le document ni ses points ne restent en
 * mémoire. Même construction que `Materializer.object` (précédences
 * comprises) ; l'égalité est vérifiée par model.test.ts.
 */
export function materializeJson(store: ObjectStore): string {
  const specs = new Map<string, MergeSpec>();
  return writeJson(jsonObject(store, store.root(), specs)) ?? 'null';
}

function jsonObject(store: ObjectStore, object: DocObject, specs: Map<string, MergeSpec>): JsonTree {
  const spec = objectSpec(store, object.id, specs);
  if (spec.kind !== 'record' || (object.props.has(ATOMIC_VALUE_KEY) && object.props.size === 1 && object.children.size === 0)) {
    return new RawJson(JSON.stringify(object.props.get(ATOMIC_VALUE_KEY)));
  }
  const out: { [key: string]: JsonTree } = {};
  const built = new WeakSet<object>([out]);
  for (const [path, raw] of object.props) {
    if (path === ATOMIC_VALUE_KEY) continue;
    const segments = decodePath(path);
    const leaf = specAtPath(spec, segments)?.kind === 'route' && isRouteHeader(raw)
      ? new RawJson(routeJson(store, raw))
      : new RawJson(JSON.stringify(raw));
    insert(out, segments, leaf, built);
  }
  for (const [field, ids] of object.children) {
    const items = ids.map((id) => store.get(id)).filter((child): child is DocObject => !!child);
    insertList(out, decodePath(field), items.map((child) => jsonObject(store, child, specs)), built);
  }
  return out;
}

/** Points d'un tracé : JSON des segments recollés (même texte que les points relus puis réécrits). */
function pointsJson(store: ObjectStore, ids: readonly string[]): string {
  const parts: string[] = [];
  for (const id of ids) {
    const json = store.getBlob(id);
    // Segment introuvable : tracé vide, comme `Materializer.points`.
    if (json === undefined) return '[]';
    if (json.length > 2) parts.push(json.slice(1, -1));
  }
  return `[${parts.join(',')}]`;
}

function routeJson(store: ObjectStore, header: RouteHeader): string {
  // Ordre des clés de `Materializer.route` : métadonnées, points, points d'origine.
  const shape: PlainRecord = { ...header.meta, points: null };
  if (header.originalPoints) shape.originalPoints = null;
  const parts: string[] = [];
  for (const key of Object.keys(shape)) {
    const json = key === 'points'
      ? pointsJson(store, header.points)
      : key === 'originalPoints' && header.originalPoints
        ? pointsJson(store, header.originalPoints)
        : JSON.stringify(shape[key]);
    if (json !== undefined) parts.push(`${JSON.stringify(key)}:${json}`);
  }
  return `{${parts.join(',')}}`;
}

function writeJson(tree: JsonTree): string | undefined {
  if (tree instanceof RawJson) return tree.json;
  if (Array.isArray(tree)) return `[${tree.map((item) => writeJson(item) ?? 'null').join(',')}]`;
  const parts: string[] = [];
  // Object.keys : même ordre que JSON.stringify (clés entières d'abord).
  for (const key of Object.keys(tree)) {
    const json = writeJson(tree[key]);
    if (json !== undefined) parts.push(`${JSON.stringify(key)}:${json}`);
  }
  return `{${parts.join(',')}}`;
}

function valueAtPath(value: PlainRecord, segments: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of segments) {
    if (!isPlainRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Pose `value` au chemin `segments` ; un objet construit par des clés n'est jamais écrasé. */
function insert(target: PlainRecord, segments: readonly string[], value: unknown, built: WeakSet<object>): void {
  let node = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = node[segment];
    if (next !== null && typeof next === 'object' && built.has(next)) {
      node = next as PlainRecord;
    } else {
      const created: PlainRecord = {};
      built.add(created);
      node[segment] = created;
      node = created;
    }
  }
  const last = segments[segments.length - 1];
  const existing = node[last];
  if (existing !== null && typeof existing === 'object' && built.has(existing)) return;
  node[last] = value;
}

function insertList(target: PlainRecord, segments: readonly string[], items: unknown[], built: WeakSet<object>): void {
  let node = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = node[segment];
    if (next !== null && typeof next === 'object' && built.has(next)) {
      node = next as PlainRecord;
    } else {
      const created: PlainRecord = {};
      built.add(created);
      node[segment] = created;
      node = created;
    }
  }
  const list = [...items];
  built.add(list);
  node[segments[segments.length - 1]] = list;
}
