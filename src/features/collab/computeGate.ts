import type { Awareness } from 'y-protocols/awareness';

import type { DerivedComputeGate, DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';

import type { ProjectDocBinding } from './yjs/binding';

/**
 * Qui calcule un résultat dérivé (tracé BRouter, prédiction, recherche POI)
 * quand plusieurs éditeurs ont le projet ouvert — un seul, pour ne pas lancer
 * le même calcul partout ni écrire des résultats concurrents :
 *
 *  1. l'auteur de la dernière modification des entrées de ce résultat
 *     (déplacement de point → tracé ; tracé, rythme → prédiction…) ;
 *  2. sinon personne tant qu'un autre éditeur annonce ce calcul en cours
 *     (présence Yjs), ou pendant un court délai après une modification
 *     distante (le temps que son auteur l'annonce) ;
 *  3. ensuite (auteur parti, calcul abandonné, document ouvert déjà
 *     périmé) : l'éditeur présent de plus petit id client.
 */

/** Champ de présence : calculs en cours de cet éditeur (`${kind}:${itineraryId}`). */
export const COMPUTING_FIELD = 'computing';
/** Délai laissé à l'auteur d'une modification distante pour annoncer son calcul. */
export const DEFAULT_COMPUTE_GRACE_MS = 6000;

export interface CollabComputeGateOptions {
  graceMs?: number;
  now?: () => number;
}

function computeKey(kind: DerivedKind, itineraryId: string): string {
  return `${kind}:${itineraryId}`;
}

export class CollabComputeGate implements DerivedComputeGate {
  private readonly binding: ProjectDocBinding;
  private readonly awareness: Awareness;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly running = new Map<string, number>();
  private readonly unsubscribeInputs: () => void;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private recheckAt = Number.POSITIVE_INFINITY;
  private destroyed = false;

  constructor(
    binding: ProjectDocBinding,
    awareness: Awareness,
    { graceMs = DEFAULT_COMPUTE_GRACE_MS, now = Date.now }: CollabComputeGateOptions = {},
  ) {
    this.binding = binding;
    this.awareness = awareness;
    this.graceMs = graceMs;
    this.now = now;
    this.awareness.on('change', this.notify);
    this.unsubscribeInputs = this.binding.onInputChange(this.notify);
  }

  shouldCompute(kind: DerivedKind, itineraryId: string): boolean {
    const change = this.binding.lastInputChange(kind, itineraryId);
    if (change?.local) return true;
    if (this.peerComputing(computeKey(kind, itineraryId))) return false;
    if (change) {
      const until = change.at + this.graceMs;
      if (this.now() < until) {
        this.scheduleRecheck(until);
        return false;
      }
    }
    return this.isElected();
  }

  beginCompute(kind: DerivedKind, itineraryId: string): () => void {
    const key = computeKey(kind, itineraryId);
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    this.publish();
    let released = false;
    return () => {
      if (released || this.destroyed) return;
      released = true;
      const count = (this.running.get(key) ?? 1) - 1;
      if (count > 0) this.running.set(key, count);
      else this.running.delete(key);
      this.publish();
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Éditeur désigné : le plus petit id client parmi les présents. */
  isElected(): boolean {
    let smallest = this.awareness.clientID;
    for (const clientId of this.awareness.getStates().keys()) {
      if (clientId < smallest) smallest = clientId;
    }
    return smallest === this.awareness.clientID;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.awareness.off('change', this.notify);
    this.unsubscribeInputs();
    if (this.recheckTimer != null) clearTimeout(this.recheckTimer);
    this.listeners.clear();
  }

  private peerComputing(key: string): boolean {
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.awareness.clientID) continue;
      const computing = (state as { [COMPUTING_FIELD]?: Record<string, unknown> } | null)?.[COMPUTING_FIELD];
      if (computing && computing[key]) return true;
    }
    return false;
  }

  private publish(): void {
    const computing: Record<string, true> = {};
    for (const key of this.running.keys()) computing[key] = true;
    this.awareness.setLocalStateField(COMPUTING_FIELD, computing);
  }

  private scheduleRecheck(at: number): void {
    if (at >= this.recheckAt && this.recheckTimer != null) return;
    if (this.recheckTimer != null) clearTimeout(this.recheckTimer);
    this.recheckAt = at;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      this.recheckAt = Number.POSITIVE_INFINITY;
      this.notify();
    }, Math.max(0, at - this.now()) + 20);
  }

  private readonly notify = (): void => {
    if (this.destroyed) return;
    for (const listener of [...this.listeners]) listener();
  };
}
