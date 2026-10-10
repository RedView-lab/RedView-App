import type { CollabLocalChange } from '@/features/itineraryPanel/context/ProjectStore/collab';
import { deepEqual } from '@/features/itineraryPanel/lib/project/deepEqual';

import type { ObjectStore } from '../model/objects';
import type { Op } from '../model/ops';
import { decodePath, itineraryIdOf, itineraryObjectId } from '../model/paths';
import { DERIVED_INPUTS } from '../schema';

/**
 * Annuler / rétablir d'un éditeur, côté client comme chez Figma : chaque
 * étape garde l'inverse de ses opérations ; annuler applique cet inverse comme
 * une nouvelle modification (envoyée à tous) et range l'inverse de l'inverse
 * dans « rétablir ».
 *
 *  - Chacun n'annule que ses propres modifications : une propriété qu'un autre
 *    éditeur a changée depuis n'est pas remise à l'ancienne valeur, une
 *    position qu'il a changée non plus.
 *  - Un objet supprimé est recréé avec toutes ses propriétés (gardées ici,
 *    pas dans le document).
 *  - Les actions rapprochées (`user`, < 600 ms) forment une seule étape ; un
 *    résultat calculé (`background` : tracé, altimétrie, POI, prédiction) est
 *    rattaché à la dernière étape qui touche le même itinéraire : annuler un
 *    déplacement de point remet aussi l'ancien tracé, sans recalcul.
 *  - Un commentaire (`comment`) n'est jamais une étape : annuler ne touche pas
 *    aux fils de discussion, comme chez Figma.
 */

const USER_COALESCE_MS = 600;
const MAX_UNDO_STEPS = 200;

interface Write {
  present: boolean;
  value?: unknown;
}

interface Step {
  /** Opérations qui défont l'étape, dans l'ordre d'application. */
  inverse: Op[];
  /** Valeur laissée par l'étape, par propriété (`id` + clé). */
  writes: Map<string, Write>;
  /** Position laissée par l'étape, par objet. */
  positions: Map<string, string>;
  /** Objets supprimés par l'étape. */
  deletions: Set<string>;
  itineraries: Set<string>;
  coalescable: boolean;
  at: number;
}

type ApplyLocal = (ops: Op[]) => { applied: Op[]; inverse: Op[] };

const propKey = (id: string, key: string) => `${id}\u0000${key}`;

function buildStep(ops: readonly Op[], inverse: Op[], coalescable: boolean, at: number): Step {
  const step: Step = { inverse, writes: new Map(), positions: new Map(), deletions: new Set(), itineraries: new Set(), coalescable, at };
  recordWrites(step, ops);
  return step;
}

function recordWrites(step: Step, ops: readonly Op[]): void {
  for (const op of ops) {
    const itineraryId = itineraryIdOf(op.id);
    if (itineraryId) step.itineraries.add(itineraryId);
    switch (op.t) {
      case 's':
        step.writes.set(propKey(op.id, op.k), 'v' in op ? { present: true, value: op.v } : { present: false });
        break;
      case 'c':
        for (const [key, value] of op.props) step.writes.set(propKey(op.id, key), { present: true, value });
        step.positions.set(op.id, op.pos);
        step.deletions.delete(op.id);
        break;
      case 'm':
        step.positions.set(op.id, op.pos);
        break;
      case 'd': {
        step.deletions.add(op.id);
        // Objet supprimé : sa recréation remet ses propriétés sans condition.
        const prefix = `${op.id}/`;
        for (const key of [...step.writes.keys()]) {
          const id = key.slice(0, key.indexOf('\u0000'));
          if (id === op.id || id.startsWith(prefix)) step.writes.delete(key);
        }
        for (const id of [...step.positions.keys()]) {
          if (id === op.id || id.startsWith(prefix)) step.positions.delete(id);
        }
        break;
      }
    }
  }
}

/**
 * Inverse d'une étape qui grossit (actions rapprochées regroupées, résultat
 * d'arrière-plan rattaché) : dans une suite d'écritures (`s`), seule la
 * dernière sur une même propriété compte (l'inverse s'applique dans l'ordre).
 * Un glisser continu ne garde ainsi qu'une écriture par propriété au lieu
 * d'une par événement — sinon annuler renvoyait des centaines d'opérations
 * redondantes à tous les éditeurs. Une création, suppression ou un
 * déplacement coupe la suite (l'ordre compte alors).
 */
function compactInverse(ops: readonly Op[]): Op[] {
  const kept: Array<Op | null> = [];
  const lastInRun = new Map<string, number>();
  for (const op of ops) {
    if (op.t !== 's') {
      lastInRun.clear();
      kept.push(op);
      continue;
    }
    const key = propKey(op.id, op.k);
    const previous = lastInRun.get(key);
    if (previous !== undefined) kept[previous] = null;
    lastInRun.set(key, kept.length);
    kept.push(op);
  }
  return kept.filter((op): op is Op => op !== null);
}

/** Champs d'un itinéraire dont un résultat calculé dépend (tracé, prédiction, POI). */
const DERIVED_INPUT_FIELDS: ReadonlySet<string> = new Set(Object.values(DERIVED_INPUTS).flat());

/** Champ de premier niveau de l'itinéraire touché par l'écriture `key` de l'objet `objectId`. */
function itineraryFieldOf(objectId: string, key: string | null): string | null {
  const itineraryId = itineraryIdOf(objectId);
  if (!itineraryId) return null;
  const base = itineraryObjectId(itineraryId);
  if (objectId === base) return key === null ? null : decodePath(key)[0] ?? null;
  const segment = objectId.slice(base.length + 1).split('/')[0];
  const colon = segment.indexOf(':');
  return decodePath(colon < 0 ? segment : segment.slice(0, colon))[0] ?? null;
}

/**
 * L'étape a-t-elle causé un résultat calculé de ces itinéraires ? Oui si elle
 * a écrit (ou déplacé) une entrée du calcul et que cette valeur est encore
 * celle de l'état visible : personne ne l'a changée depuis.
 */
function causedBy(step: Step, itineraries: ReadonlySet<string>, store: ObjectStore): boolean {
  const relevant = (id: string, key: string | null) => {
    const itineraryId = itineraryIdOf(id);
    const field = itineraryFieldOf(id, key);
    return itineraryId !== null && itineraries.has(itineraryId) && field !== null && DERIVED_INPUT_FIELDS.has(field);
  };
  for (const [prop, write] of step.writes) {
    const separator = prop.indexOf('\u0000');
    const id = prop.slice(0, separator);
    const key = prop.slice(separator + 1);
    if (!relevant(id, key)) continue;
    const object = store.get(id);
    const current = object?.props.has(key) ? { present: true, value: object.props.get(key) } : { present: false };
    if (current.present === write.present && (!write.present || deepEqual(current.value, write.value))) return true;
  }
  for (const [id, pos] of step.positions) {
    if (relevant(id, null) && store.get(id)?.pos === pos) return true;
  }
  for (const id of step.deletions) {
    if (relevant(id, null) && !store.has(id)) return true;
  }
  return false;
}

/** Opérations de l'inverse encore applicables : rien de ce qu'un autre a changé depuis. */
function applicableInverse(step: Step, store: ObjectStore): Op[] {
  return step.inverse.filter((op) => {
    if (op.t === 's') {
      const write = step.writes.get(propKey(op.id, op.k));
      if (!write) return true;
      const object = store.get(op.id);
      if (!object) return false;
      return write.present
        ? object.props.has(op.k) && deepEqual(object.props.get(op.k), write.value)
        : !object.props.has(op.k);
    }
    if (op.t === 'm') {
      const pos = step.positions.get(op.id);
      return pos === undefined || store.get(op.id)?.pos === pos;
    }
    return true;
  });
}

export class UndoHistory {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * Modification locale appliquée (`ops`), avec son inverse calculé sur l'état
   * d'avant (`invertOps`).
   */
  record(change: CollabLocalChange, ops: readonly Op[], inverse: Op[], now: number, store: ObjectStore): void {
    if (ops.length === 0 || change === 'comment') return;
    if (change === 'background') {
      const itineraries = new Set(ops.map((op) => itineraryIdOf(op.id)).filter((id): id is string => !!id));
      for (let index = this.undoStack.length - 1; index >= 0; index -= 1) {
        const step = this.undoStack[index];
        if (![...itineraries].some((id) => step.itineraries.has(id))) continue;
        // Seulement à l'étape qui l'a causé : la dernière à toucher cet
        // itinéraire, si elle a écrit des entrées du calcul qui n'ont pas
        // changé depuis. Sinon (renommage, entrées changées depuis par un
        // autre éditeur), annuler cette étape remettrait un tracé qui ne
        // correspond plus aux points (C1-2) : le résultat n'est rattaché à rien.
        if (causedBy(step, itineraries, store)) {
          step.inverse = compactInverse([...inverse, ...step.inverse]);
          recordWrites(step, ops);
        }
        return;
      }
      // Résultat sans action d'origine (projet ouvert, recalcul) : pas une étape.
      return;
    }
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (change === 'user' && top?.coalescable && now - top.at < USER_COALESCE_MS) {
      top.inverse = compactInverse([...inverse, ...top.inverse]);
      recordWrites(top, ops);
      top.at = now;
      return;
    }
    this.undoStack.push(buildStep(ops, inverse, change === 'user', now));
    if (this.undoStack.length > MAX_UNDO_STEPS) this.undoStack.shift();
  }

  /**
   * Annule la dernière étape : `apply` applique ses opérations comme
   * modification locale (lues sur `store`, l'état visible) et renvoie leur
   * propre inverse, rangé dans « rétablir ». false : rien à annuler.
   */
  undo(store: ObjectStore, apply: ApplyLocal, now: number): boolean {
    return this.move(this.undoStack, this.redoStack, store, apply, now);
  }

  redo(store: ObjectStore, apply: ApplyLocal, now: number): boolean {
    return this.move(this.redoStack, this.undoStack, store, apply, now);
  }

  private move(from: Step[], to: Step[], store: ObjectStore, apply: ApplyLocal, now: number): boolean {
    while (from.length > 0) {
      const step = from.pop()!;
      const { applied, inverse } = apply(applicableInverse(step, store));
      // Étape entièrement recouverte par d'autres éditeurs : on passe à la précédente.
      if (applied.length === 0) continue;
      const back = buildStep(applied, inverse, false, now);
      for (const id of step.itineraries) back.itineraries.add(id);
      to.push(back);
      return true;
    }
    return false;
  }
}
