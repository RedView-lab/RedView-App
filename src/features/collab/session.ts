import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import type { ProjectCollabLink } from '@/features/itineraryPanel/context/ProjectStore/collab';
import type { ProjectDocument } from '@/features/itineraryPanel/lib/project/layers';

import { CollabComputeGate, type CollabComputeGateOptions } from './computeGate';
import { ProjectDocBinding } from './yjs/binding';

/**
 * Session de co-édition d'un projet : Y.Doc, présence, liaison au document,
 * désignation de qui calcule, et lien vers le ProjectStore. Indépendante de
 * React et du transport (onglets en développement, serveur temps réel ensuite).
 */

/** Ce qu'un transport fournit : l'état d'un pair reçu ou non au démarrage. */
export interface CollabTransport {
  /** true si l'état d'un autre éditeur a été reçu (sinon le document enregistré est semé). */
  synced: Promise<boolean>;
  destroy(): void;
}

export type CollabTransportFactory = (ydoc: Y.Doc, awareness: Awareness) => CollabTransport;

export interface CollabSessionOptions {
  /**
   * Document à semer si aucun éditeur n'a déjà la session, lu au moment du
   * semis (une modification faite pendant la recherche d'un pair n'est pas perdue).
   */
  getSeedDocument: () => ProjectDocument;
  transport: CollabTransportFactory;
  /** Présence publiée (identité de l'éditeur…). */
  user?: Record<string, unknown>;
  captureTimeoutMs?: number;
  gate?: CollabComputeGateOptions;
}

export interface CollabSession {
  readonly binding: ProjectDocBinding;
  readonly awareness: Awareness;
  readonly gate: CollabComputeGate;
  readonly link: ProjectCollabLink;
  /** Résolue une fois le document prêt (reçu d'un pair, ou semé). */
  readonly ready: Promise<void>;
  destroy(): void;
}

export function createCollabLink(binding: ProjectDocBinding, gate: CollabComputeGate): ProjectCollabLink {
  return {
    getDocument: () => binding.getDocument(),
    pushLocalDocument: (document, change) => {
      binding.applyLocal(document, change);
    },
    subscribe: (listener) => binding.onExternalChange(listener),
    undo: () => {
      binding.undo();
    },
    redo: () => {
      binding.redo();
    },
    canUndo: () => binding.canUndo(),
    canRedo: () => binding.canRedo(),
    subscribeHistory: (listener) => binding.onHistoryChange(listener),
    computeGate: gate,
  };
}

export function createCollabSession({
  getSeedDocument,
  transport: connect,
  user,
  captureTimeoutMs,
  gate: gateOptions,
}: CollabSessionOptions): CollabSession {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  awareness.setLocalState({ user: user ?? {}, computing: {} });
  const binding = new ProjectDocBinding({ ydoc, captureTimeoutMs });
  const gate = new CollabComputeGate(binding, awareness, gateOptions);
  const transport = connect(ydoc, awareness);
  let destroyed = false;

  const ready = transport.synced.then((received) => {
    if (destroyed) return;
    if (!(received && binding.adoptRemoteState())) binding.seed(getSeedDocument());
  });

  return {
    binding,
    awareness,
    gate,
    link: createCollabLink(binding, gate),
    ready,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      transport.destroy();
      gate.destroy();
      binding.destroy();
      awareness.destroy();
      ydoc.destroy();
    },
  };
}
