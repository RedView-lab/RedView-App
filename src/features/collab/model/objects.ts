import { deepEqual } from '@/features/itineraryPanel/lib/project/deepEqual';

import { ROOT_OBJECT_ID } from './paths';

/**
 * Document à plat, comme celui de Figma : des objets identifiés, chacun avec
 * ses propriétés (`chemin → valeur JSON`), son parent, le champ de liste qui
 * le contient et sa position (index fractionnaire). L'ordre d'une liste est
 * celui des positions (départagé par l'id : déterministe partout).
 *
 * Les objets sont immuables : toute modification remplace l'objet et ses
 * ancêtres (profondeur ≤ 3). Une lecture mise en cache par objet reste donc
 * valable tant que l'objet n'a pas été remplacé (materialize.ts), et une copie
 * du magasin (`clone`) ne copie que les tables, jamais les objets.
 */
export interface DocObject {
  readonly id: string;
  readonly parent: string | null;
  /** Champ de liste du parent (chemin encodé), null pour la racine. */
  readonly field: string | null;
  /** Index fractionnaire dans la liste du parent, null pour la racine. */
  readonly pos: string | null;
  readonly props: ReadonlyMap<string, unknown>;
  /** Enfants par champ de liste, triés par (pos, id). */
  readonly children: ReadonlyMap<string, readonly string[]>;
}

export function comparePositions(a: DocObject, b: DocObject): number {
  const posA = a.pos ?? '';
  const posB = b.pos ?? '';
  if (posA < posB) return -1;
  if (posA > posB) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class ObjectStore {
  private objects: Map<string, DocObject>;
  /** Segments de tracé (et autres blobs) adressés par leur contenu. */
  private blobs: Map<string, string>;

  constructor(objects?: Map<string, DocObject>, blobs?: Map<string, string>) {
    this.objects = objects ?? new Map([[ROOT_OBJECT_ID, rootObject()]]);
    this.blobs = blobs ?? new Map();
  }

  /** Copie indépendante (les objets, immuables, sont partagés). */
  clone(): ObjectStore {
    return new ObjectStore(new Map(this.objects), new Map(this.blobs));
  }

  get(id: string): DocObject | undefined {
    return this.objects.get(id);
  }

  has(id: string): boolean {
    return this.objects.has(id);
  }

  get size(): number {
    return this.objects.size;
  }

  root(): DocObject {
    return this.objects.get(ROOT_OBJECT_ID)!;
  }

  values(): IterableIterator<DocObject> {
    return this.objects.values();
  }

  getBlob(id: string): string | undefined {
    return this.blobs.get(id);
  }

  hasBlob(id: string): boolean {
    return this.blobs.has(id);
  }

  putBlob(id: string, json: string): void {
    if (!this.blobs.has(id)) this.blobs.set(id, json);
  }

  blobIds(): IterableIterator<string> {
    return this.blobs.keys();
  }

  /** Retire les blobs qu'aucune propriété ne référence plus (`referenced`). */
  pruneBlobs(referenced: ReadonlySet<string>): number {
    let removed = 0;
    for (const id of [...this.blobs.keys()]) {
      if (!referenced.has(id)) {
        this.blobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Enfants d'un objet dans un champ de liste, dans l'ordre. */
  childrenOf(id: string, field: string): DocObject[] {
    const ids = this.objects.get(id)?.children.get(field) ?? [];
    return ids.map((childId) => this.objects.get(childId)!).filter(Boolean);
  }

  /**
   * Reprend les objets de `previous` dont le contenu est identique à ceux
   * d'ici (propriétés, position, enfants eux-mêmes repris) : après une
   * reconstruction (état confirmé + modifications en attente, sync client),
   * les lectures en cache par objet restent valables là où rien n'a changé.
   * Les plus profonds d'abord : un parent n'est repris que si tous ses
   * enfants l'ont été. Renvoie le nombre d'objets repris.
   */
  adoptEqual(previous: ObjectStore): number {
    const differing: DocObject[] = [];
    for (const object of this.objects.values()) {
      const before = previous.objects.get(object.id);
      if (before && before !== object) differing.push(object);
    }
    if (differing.length === 0) return 0;
    const depth = (object: DocObject) => {
      let count = 0;
      for (let parent = object.parent; parent; parent = this.objects.get(parent)?.parent ?? null) count += 1;
      return count;
    };
    differing.sort((a, b) => depth(b) - depth(a));
    let adopted = 0;
    for (const object of differing) {
      const before = previous.objects.get(object.id)!;
      if (this.sameContent(object, before, previous)) {
        this.objects.set(object.id, before);
        adopted += 1;
      }
    }
    return adopted;
  }

  /** Prend les objets de `source` (mêmes ids, contenu identique garanti par l'appelant) acceptés par `accept`. */
  shareObjects(source: ObjectStore, accept: (id: string) => boolean): void {
    for (const [id, object] of this.objects) {
      const shared = source.objects.get(id);
      if (shared && shared !== object && accept(id)) this.objects.set(id, shared);
    }
  }

  private sameContent(object: DocObject, before: DocObject, previous: ObjectStore): boolean {
    if (object.parent !== before.parent || object.field !== before.field || object.pos !== before.pos) return false;
    if (object.props.size !== before.props.size || object.children.size !== before.children.size) return false;
    for (const [field, ids] of object.children) {
      const beforeIds = before.children.get(field);
      if (!beforeIds || beforeIds.length !== ids.length) return false;
      for (let index = 0; index < ids.length; index += 1) {
        if (ids[index] !== beforeIds[index]) return false;
        if (this.objects.get(ids[index]) !== previous.objects.get(ids[index])) return false;
      }
    }
    for (const [key, value] of object.props) {
      if (!before.props.has(key) || !deepEqual(value, before.props.get(key))) return false;
    }
    return true;
  }

  // ── Écriture (appelée par ops.ts) ─────────────────────────────────────────

  /** Remplace un objet (et rafraîchit ses ancêtres pour invalider les lectures en cache). */
  replace(next: DocObject): void {
    this.objects.set(next.id, next);
    this.touchAncestors(next.parent);
  }

  insertChild(child: DocObject): void {
    if (!child.parent || child.field === null) throw new Error('insertChild: child without parent');
    const parent = this.objects.get(child.parent);
    if (!parent) throw new Error(`insertChild: missing parent ${child.parent}`);
    this.objects.set(child.id, child);
    const siblings = (parent.children.get(child.field) ?? []).filter((id) => id !== child.id);
    siblings.push(child.id);
    this.setChildren(parent, child.field, siblings);
  }

  /** Supprime un objet et ses descendants ; renvoie les objets supprimés (parent d'abord). */
  removeSubtree(id: string): DocObject[] {
    const target = this.objects.get(id);
    if (!target) return [];
    const removed: DocObject[] = [];
    const visit = (object: DocObject) => {
      removed.push(object);
      for (const ids of object.children.values()) {
        for (const childId of ids) {
          const child = this.objects.get(childId);
          if (child) visit(child);
        }
      }
    };
    visit(target);
    for (const object of removed) this.objects.delete(object.id);
    if (target.parent && target.field !== null) {
      const parent = this.objects.get(target.parent);
      if (parent) {
        const siblings = (parent.children.get(target.field) ?? []).filter((childId) => childId !== id);
        this.setChildren(parent, target.field, siblings);
      }
    }
    return removed;
  }

  /** Nouvelle position d'un objet dans sa liste. */
  movePosition(id: string, pos: string): void {
    const object = this.objects.get(id);
    if (!object || object.parent === null || object.field === null) return;
    this.objects.set(id, { ...object, pos });
    const parent = this.objects.get(object.parent)!;
    this.setChildren(parent, object.field, [...(parent.children.get(object.field) ?? [])]);
  }

  private setChildren(parent: DocObject, field: string, ids: string[]): void {
    const sorted = ids
      .map((id) => this.objects.get(id)!)
      .filter(Boolean)
      .sort(comparePositions)
      .map((object) => object.id);
    const children = new Map(parent.children);
    if (sorted.length > 0) children.set(field, sorted);
    else children.delete(field);
    this.objects.set(parent.id, { ...parent, children });
    this.touchAncestors(parent.parent);
  }

  private touchAncestors(id: string | null): void {
    let current = id;
    while (current) {
      const object = this.objects.get(current);
      if (!object) return;
      this.objects.set(current, { ...object });
      current = object.parent;
    }
  }
}

function rootObject(): DocObject {
  return { id: ROOT_OBJECT_ID, parent: null, field: null, pos: null, props: new Map(), children: new Map() };
}

/** Objet de liste neuf. */
export function newChildObject(
  id: string,
  parent: string,
  field: string,
  pos: string,
  props: Iterable<readonly [string, unknown]>,
): DocObject {
  return { id, parent, field, pos, props: new Map(props), children: new Map() };
}
