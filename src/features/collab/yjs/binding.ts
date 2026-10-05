import * as Y from 'yjs';

import type {
  CollabChangeCause,
  CollabLocalChange,
  DerivedKind,
} from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { hash53 } from '../routeChunks';
import { DERIVED_INPUTS } from '../schema';
import { DocumentReader, isRouteChunkStore, rootMap, writeDocument } from './codec';

/**
 * Liaison entre le document partagé d'un projet et un `Y.Doc` : écriture des
 * modifications locales (différence → opérations Yjs), lecture de celles des
 * autres éditeurs, annuler/rétablir propre à chaque utilisateur, et suivi de
 * l'auteur de chaque modification (qui calcule les résultats dérivés).
 *
 * Annuler/rétablir (`Y.UndoManager`) ne concerne que les actions de cet
 * utilisateur (`user`/`step`) : jamais celles des autres. Un résultat calculé
 * en arrière-plan (tracé BRouter, altimétrie, POI, prédiction) est rattaché à
 * l'étape de l'action qui l'a provoqué : annuler un déplacement de point
 * remet aussi l'ancien tracé, sans nouveau routage. Les segments de tracé ne
 * sont jamais supprimés par une annulation (un autre éditeur peut les
 * référencer).
 */

/** Origines des transactions locales. */
const USER_ORIGIN = Object.freeze({ origin: 'rv-collab:user' });
const BACKGROUND_ORIGIN = Object.freeze({ origin: 'rv-collab:background' });
const SEED_ORIGIN = Object.freeze({ origin: 'rv-collab:seed' });

/** Itinéraires touchés par une étape d'annulation. */
const STACK_ITINERARIES = 'rv:itineraries';
/** Champ fictif : l'itinéraire lui-même (ajout / suppression). */
const WHOLE_ITINERARY = '*';
const ROUTE_CHUNKS_FIELD = /\$chunks$/;

export interface InputChange {
  /** Faite par cet appareil (action, résultat ou annuler/rétablir). */
  local: boolean;
  at: number;
}

export interface ProjectDocBindingOptions {
  ydoc?: Y.Doc;
  /** Regroupement des actions rapprochées en une étape d'annulation. */
  captureTimeoutMs?: number;
  now?: () => number;
}

type ExternalListener = (document: ProjectDocument, cause: CollabChangeCause) => void;

/** Id client du semis : dérivé du document semé (même document → mêmes structures Yjs). */
function seedClientId(json: string): number {
  return (hash53(json, 7) % 0x7ffffffe) + 1;
}

type DeleteSet = ReturnType<typeof Y.createDeleteSet>;
/** Type Yjs quelconque (forme utilisée par `Transaction.changed`). */
type YType = Parameters<Y.Transaction['changed']['get']>[0];
type DeleteItem = DeleteSet['clients'] extends Map<number, Array<infer Item>> ? Item : never;

function keepItem(item: Y.Item): void {
  let current: Y.Item | null = item;
  while (current && !current.keep) {
    current.keep = true;
    const parent: Y.AbstractType<unknown> | Y.ID | null = current.parent;
    current = parent instanceof Y.AbstractType ? parent._item : null;
  }
}

export class ProjectDocBinding {
  readonly ydoc: Y.Doc;
  readonly undoManager: Y.UndoManager;
  private readonly root: Y.Map<unknown>;
  private readonly reader = new DocumentReader();
  private readonly now: () => number;
  private document: ProjectDocument | null = null;
  private readonly externalListeners = new Set<ExternalListener>();
  private readonly historyListeners = new Set<() => void>();
  private readonly inputListeners = new Set<() => void>();
  private readonly lastChanges = new Map<string, Map<string, InputChange>>();
  private destroyed = false;

  constructor({ ydoc = new Y.Doc(), captureTimeoutMs = 600, now = Date.now }: ProjectDocBindingOptions = {}) {
    this.ydoc = ydoc;
    this.now = now;
    this.root = rootMap(ydoc);
    this.undoManager = new Y.UndoManager(this.root, {
      captureTimeout: captureTimeoutMs,
      trackedOrigins: new Set<unknown>([USER_ORIGIN]),
      deleteFilter: (item) => !isRouteChunkStore(item.parent instanceof Y.AbstractType ? item.parent : null),
    });
    const notifyHistory = () => this.emitHistory();
    this.undoManager.on('stack-item-added', notifyHistory);
    this.undoManager.on('stack-item-popped', notifyHistory);
    this.undoManager.on('stack-item-updated', notifyHistory);
    this.undoManager.on('stack-cleared', notifyHistory);
    // Après celui de l'UndoManager : l'étape de l'action vient d'être créée.
    this.ydoc.on('afterTransaction', this.onAfterTransaction);
  }

  /** Document prêt (semé, ou reçu d'un autre éditeur). */
  get ready(): boolean {
    return this.document !== null;
  }

  getDocument(): ProjectDocument {
    if (!this.document) throw new Error('ProjectDocBinding: document not ready');
    return this.document;
  }

  /**
   * Premier remplissage depuis le document enregistré. Déterministe : deux
   * appareils qui sèment le même document produisent les mêmes structures
   * Yjs (aucun doublon quand leurs états se rejoignent).
   */
  seed(document: ProjectDocument): void {
    if (this.document) throw new Error('ProjectDocBinding: already seeded');
    const clientId = this.ydoc.clientID;
    this.ydoc.clientID = seedClientId(JSON.stringify(document));
    try {
      this.ydoc.transact(() => writeDocument(this.root, null, document), SEED_ORIGIN);
    } finally {
      this.ydoc.clientID = clientId;
    }
    this.document = this.reader.read(this.root);
  }

  /** État reçu d'un autre éditeur (le Y.Doc contient déjà le document). */
  adoptRemoteState(): boolean {
    if (this.document) return true;
    if (this.root.size === 0) return false;
    this.document = this.reader.read(this.root);
    return true;
  }

  /** Écrit une modification locale. Renvoie false si le document est inchangé. */
  applyLocal(next: ProjectDocument, change: CollabLocalChange): boolean {
    const prev = this.document;
    if (!prev || next === prev || this.destroyed) return false;
    if (change === 'step') this.undoManager.stopCapturing();
    let changed = false;
    const origin = change === 'background' ? BACKGROUND_ORIGIN : USER_ORIGIN;
    this.ydoc.transact((transaction) => {
      writeDocument(this.root, prev, next);
      changed = transaction.changed.size > 0 || transaction.deleteSet.clients.size > 0;
    }, origin);
    this.document = next;
    if (change === 'step') this.undoManager.stopCapturing();
    return changed;
  }

  undo(): boolean {
    return this.undoManager.undo() !== null;
  }

  redo(): boolean {
    return this.undoManager.redo() !== null;
  }

  canUndo(): boolean {
    return this.undoManager.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.undoManager.redoStack.length > 0;
  }

  /** Documents venus d'ailleurs : autres éditeurs, annuler/rétablir. */
  onExternalChange(listener: ExternalListener): () => void {
    this.externalListeners.add(listener);
    return () => this.externalListeners.delete(listener);
  }

  onHistoryChange(listener: () => void): () => void {
    this.historyListeners.add(listener);
    return () => this.historyListeners.delete(listener);
  }

  /** Une entrée d'un résultat dérivé a changé (auteur à redésigner). */
  onInputChange(listener: () => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  /** Dernière modification des entrées de `kind` pour un itinéraire (depuis l'ouverture). */
  lastInputChange(kind: DerivedKind, itineraryId: string): InputChange | undefined {
    const fields = this.lastChanges.get(itineraryId);
    if (!fields) return undefined;
    let latest = fields.get(WHOLE_ITINERARY);
    for (const field of DERIVED_INPUTS[kind]) {
      const change = fields.get(field);
      if (change && (!latest || change.at >= latest.at)) latest = change;
    }
    return latest;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ydoc.off('afterTransaction', this.onAfterTransaction);
    this.undoManager.destroy();
    this.externalListeners.clear();
    this.historyListeners.clear();
    this.inputListeners.clear();
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  private readonly onAfterTransaction = (transaction: Y.Transaction): void => {
    this.reader.invalidate(transaction);
    if (!this.document || transaction.origin === SEED_ORIGIN) return;
    if (!transaction.changedParentTypes.has(this.root as unknown as YType)) return;

    const touched = this.touchedFields(transaction);
    const local = transaction.local;
    const at = this.now();
    for (const [itineraryId, fields] of touched) {
      let byField = this.lastChanges.get(itineraryId);
      if (!byField) {
        byField = new Map();
        this.lastChanges.set(itineraryId, byField);
      }
      for (const field of fields) byField.set(field, { local, at });
    }

    if (transaction.origin === USER_ORIGIN) {
      this.tagLastStackItem(touched.keys());
    } else if (transaction.origin === BACKGROUND_ORIGIN) {
      this.attachToTriggeringStep(transaction, touched.keys());
    }

    if (touched.size > 0) for (const listener of [...this.inputListeners]) listener();

    if (transaction.origin === USER_ORIGIN || transaction.origin === BACKGROUND_ORIGIN) return;
    // Autre éditeur, ou annuler / rétablir de cet utilisateur.
    const cause: CollabChangeCause = transaction.origin === this.undoManager
      ? (this.undoManager.undoing ? 'undo' : 'redo')
      : 'remote';
    this.document = this.reader.read(this.root);
    for (const listener of [...this.externalListeners]) listener(this.document, cause);
  };

  /** Itinéraires et champs (du premier niveau de l'itinéraire) touchés par une transaction. */
  private touchedFields(transaction: Y.Transaction): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const itineraries = this.root.get('itineraries');
    const items = itineraries instanceof Y.Map ? itineraries.get('$items') : null;
    if (!(items instanceof Y.Map)) return out;
    const add = (itineraryId: string, field: string) => {
      const normalized = field.replace(ROUTE_CHUNKS_FIELD, '');
      let fields = out.get(itineraryId);
      if (!fields) {
        fields = new Set();
        out.set(itineraryId, fields);
      }
      fields.add(normalized);
    };
    for (const [type, keys] of transaction.changed) {
      if ((type as object) === items) {
        for (const key of keys) if (key) add(key, WHOLE_ITINERARY);
        continue;
      }
      let child: YType = type;
      let field: string | null = null;
      let first = true;
      while (child._item) {
        const parent: YType | Y.ID | null = child._item.parent;
        if (!(parent instanceof Y.AbstractType)) break;
        if ((parent as object) === items) {
          const itineraryId = child._item.parentSub;
          if (!itineraryId) break;
          if (first) {
            for (const key of keys) if (key) add(itineraryId, key);
          } else if (field) {
            add(itineraryId, field);
          }
          break;
        }
        field = child._item.parentSub;
        first = false;
        child = parent;
      }
    }
    return out;
  }

  private tagLastStackItem(itineraryIds: Iterable<string>): void {
    const stackItem = this.undoManager.undoStack[this.undoManager.undoStack.length - 1];
    if (!stackItem) return;
    let tagged = stackItem.meta.get(STACK_ITINERARIES) as Set<string> | undefined;
    if (!tagged) {
      tagged = new Set();
      stackItem.meta.set(STACK_ITINERARIES, tagged);
    }
    for (const id of itineraryIds) tagged.add(id);
  }

  /**
   * Rattache un résultat d'arrière-plan à la dernière étape d'annulation de
   * cet utilisateur qui a touché l'un des mêmes itinéraires (celle qui l'a
   * provoqué). Sans étape (modification venue d'un autre éditeur, pile
   * vidée), il n'est pas annulable, comme hors session.
   */
  private attachToTriggeringStep(transaction: Y.Transaction, itineraryIds: Iterable<string>): void {
    const ids = new Set(itineraryIds);
    if (ids.size === 0) return;
    const stack = this.undoManager.undoStack;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const stackItem = stack[index];
      const tagged = stackItem.meta.get(STACK_ITINERARIES) as Set<string> | undefined;
      if (!tagged || ![...ids].some((id) => tagged.has(id))) continue;
      const insertions = Y.createDeleteSet();
      transaction.afterState.forEach((endClock, client) => {
        const startClock = transaction.beforeState.get(client) ?? 0;
        if (endClock > startClock) {
          insertions.clients.set(client, [{ clock: startClock, len: endClock - startClock } as DeleteItem]);
        }
      });
      stackItem.insertions = Y.mergeDeleteSets([stackItem.insertions, insertions]);
      stackItem.deletions = Y.mergeDeleteSets([stackItem.deletions, transaction.deleteSet]);
      // Gardés pour pouvoir être restaurés par l'annulation (sinon ramassés).
      Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
        if (struct instanceof Y.Item) keepItem(struct);
      });
      return;
    }
  }

  private emitHistory(): void {
    for (const listener of [...this.historyListeners]) listener();
  }
}
