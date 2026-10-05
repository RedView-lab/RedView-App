import { deepEqual } from '@/features/itineraryPanel/lib/project/deepEqual';

import { newChildObject, type DocObject, type ObjectStore } from './objects';

/**
 * Opérations sur le document à plat (cf. objects.ts), appliquées à
 * l'identique par le serveur (dans son ordre, qui fait foi) et par les
 * clients. Sémantique de Figma :
 *  - `s` (set) : dernier écrit gagne, propriété par propriété ; `v` absent =
 *    propriété retirée ;
 *  - `c` (create) / `d` (delete) explicites ; supprimer retire l'objet et ses
 *    descendants, sans rien en garder (l'annuler du client sait les recréer) ;
 *  - `m` (move) : nouvelle position dans la même liste (jamais de changement
 *    de parent : pas de cycle possible).
 * Une opération sur un objet absent (supprimé entre-temps par un autre
 * éditeur) est sans effet. Créer un objet qui existe déjà (deux éditeurs
 * ajoutent le même POI) fusionne ses propriétés.
 */
export type Op =
  | { t: 'c'; id: string; parent: string; field: string; pos: string; props: Array<[string, unknown]> }
  | { t: 'd'; id: string }
  | { t: 's'; id: string; k: string; v?: unknown }
  | { t: 'm'; id: string; pos: string };

function isSetDelete(op: Extract<Op, { t: 's' }>): boolean {
  return !('v' in op);
}

/** Applique une opération ; false si elle est sans effet (objet absent, valeur identique…). */
export function applyOp(store: ObjectStore, op: Op): boolean {
  switch (op.t) {
    case 'c': {
      const parent = store.get(op.parent);
      if (!parent) return false;
      const existing = store.get(op.id);
      if (existing) {
        if (existing.parent !== op.parent || existing.field !== op.field) return false;
        let changed = false;
        const props = new Map(existing.props);
        for (const [key, value] of op.props) {
          if (!props.has(key) || !deepEqual(props.get(key), value)) {
            props.set(key, value);
            changed = true;
          }
        }
        if (changed) store.replace({ ...existing, props });
        if (existing.pos !== op.pos) {
          store.movePosition(op.id, op.pos);
          changed = true;
        }
        return changed;
      }
      store.insertChild(newChildObject(op.id, op.parent, op.field, op.pos, op.props));
      return true;
    }
    case 'd':
      return store.removeSubtree(op.id).length > 0;
    case 's': {
      const object = store.get(op.id);
      if (!object) return false;
      if (isSetDelete(op)) {
        if (!object.props.has(op.k)) return false;
        const props = new Map(object.props);
        props.delete(op.k);
        store.replace({ ...object, props });
        return true;
      }
      if (object.props.has(op.k) && deepEqual(object.props.get(op.k), op.v)) return false;
      const props = new Map(object.props);
      props.set(op.k, op.v);
      store.replace({ ...object, props });
      return true;
    }
    case 'm': {
      const object = store.get(op.id);
      if (!object || object.parent === null || object.pos === op.pos) return false;
      store.movePosition(op.id, op.pos);
      return true;
    }
  }
}

/** Applique un lot ; renvoie les opérations qui ont eu un effet. */
export function applyOps(store: ObjectStore, ops: readonly Op[]): Op[] {
  const applied: Op[] = [];
  for (const op of ops) if (applyOp(store, op)) applied.push(op);
  return applied;
}

/** Opérations qui recréent un objet supprimé et ses descendants (parent d'abord). */
function recreateOps(store: ObjectStore, id: string): Op[] {
  const out: Op[] = [];
  const visit = (object: DocObject) => {
    if (object.parent === null || object.field === null || object.pos === null) return;
    out.push({ t: 'c', id: object.id, parent: object.parent, field: object.field, pos: object.pos, props: [...object.props] });
    for (const ids of object.children.values()) {
      for (const childId of ids) {
        const child = store.get(childId);
        if (child) visit(child);
      }
    }
  };
  const target = store.get(id);
  if (target) visit(target);
  return out;
}

/**
 * Opérations qui défont `op`, lues sur l'état juste avant son application
 * (dans l'ordre d'application).
 */
function inverseOf(store: ObjectStore, op: Op): Op[] {
  switch (op.t) {
    case 'c': {
      const existing = store.get(op.id);
      if (!existing) return store.has(op.parent) ? [{ t: 'd', id: op.id }] : [];
      const before: Op[] = op.props.map(([key]) => (existing.props.has(key)
        ? { t: 's', id: op.id, k: key, v: existing.props.get(key) }
        : { t: 's', id: op.id, k: key }));
      if (existing.pos !== null && existing.pos !== op.pos) before.push({ t: 'm', id: op.id, pos: existing.pos });
      return before;
    }
    case 'd':
      return recreateOps(store, op.id);
    case 's': {
      const object = store.get(op.id);
      if (!object) return [];
      return [object.props.has(op.k) ? { t: 's', id: op.id, k: op.k, v: object.props.get(op.k) } : { t: 's', id: op.id, k: op.k }];
    }
    case 'm': {
      const pos = store.get(op.id)?.pos;
      return pos ? [{ t: 'm', id: op.id, pos }] : [];
    }
  }
}

/**
 * Applique un lot en calculant son inverse (seulement pour les opérations qui
 * ont eu un effet) : appliquer ensuite `inverse` redonne l'état de départ.
 */
export function applyOpsWithInverse(store: ObjectStore, ops: readonly Op[]): { applied: Op[]; inverse: Op[] } {
  const applied: Op[] = [];
  const groups: Op[][] = [];
  for (const op of ops) {
    const before = inverseOf(store, op);
    if (!applyOp(store, op)) continue;
    applied.push(op);
    groups.push(before);
  }
  // L'inverse se lit à l'envers : la dernière opération est défaite en premier.
  return { applied, inverse: groups.reverse().flat() };
}

/** Inverse d'un lot sans modifier `store` (calculé sur une copie). */
export function invertOps(store: ObjectStore, ops: readonly Op[]): Op[] {
  return applyOpsWithInverse(store.clone(), ops).inverse;
}
