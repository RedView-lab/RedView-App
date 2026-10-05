import type { DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';

import type { LeaseInfo } from '../protocol';
import type { FieldAuthor } from './roomState';

/**
 * Baux de calcul des résultats dérivés (tracé, prédiction, POI) : un seul
 * éditeur calcule un résultat périmé, les autres attendent son écriture.
 *
 *  - l'auteur de la dernière modification des entrées du résultat est
 *    prioritaire tant qu'il est connecté, pendant `AUTHOR_PRIORITY_MS` après
 *    sa modification (c'est lui qui a le contexte : il vient de déplacer le
 *    point) ; ensuite, ou s'il est parti, le premier demandeur l'obtient ;
 *  - un bail expire après `LEASE_TTL_MS` sans renouvellement (onglet gelé,
 *    réseau coupé sans fermeture propre) et tombe à la déconnexion ;
 *  - le titulaire le libère à l'écriture du résultat.
 */

export const LEASE_TTL_MS = 20_000;
export const AUTHOR_PRIORITY_MS = 5_000;

export interface LeaseRequester {
  clientId: string;
  userId: string;
}

export interface LeaseContext {
  /** Dernier auteur des entrées du résultat (RoomState.lastInputAuthor). */
  author: FieldAuthor | undefined;
  isConnected(clientId: string): boolean;
}

export type LeaseDecision =
  | { granted: true; lease: LeaseInfo; changed: boolean }
  | { granted: false; retryAfterMs: number };

const leaseKey = (kind: DerivedKind, itineraryId: string) => `${kind}|${itineraryId}`;

export class LeaseTable {
  private readonly leases = new Map<string, LeaseInfo>();

  request(
    kind: DerivedKind,
    itineraryId: string,
    requester: LeaseRequester,
    now: number,
    context: LeaseContext,
  ): LeaseDecision {
    const key = leaseKey(kind, itineraryId);
    const current = this.leases.get(key);
    if (current && current.expiresAt > now && context.isConnected(current.clientId)) {
      if (current.clientId === requester.clientId) {
        const lease = { ...current, expiresAt: now + LEASE_TTL_MS };
        this.leases.set(key, lease);
        return { granted: true, lease, changed: false };
      }
      return { granted: false, retryAfterMs: current.expiresAt - now };
    }
    const author = context.author;
    if (
      author
      && author.clientId !== requester.clientId
      && context.isConnected(author.clientId)
      && now - author.at < AUTHOR_PRIORITY_MS
    ) {
      return { granted: false, retryAfterMs: AUTHOR_PRIORITY_MS - (now - author.at) };
    }
    const lease: LeaseInfo = {
      kind,
      itineraryId,
      clientId: requester.clientId,
      userId: requester.userId,
      expiresAt: now + LEASE_TTL_MS,
    };
    this.leases.set(key, lease);
    return { granted: true, lease, changed: true };
  }

  /** Prolonge le bail de son titulaire ; false s'il ne le tient plus. */
  renew(kind: DerivedKind, itineraryId: string, clientId: string, now: number): boolean {
    const key = leaseKey(kind, itineraryId);
    const current = this.leases.get(key);
    if (!current || current.clientId !== clientId || current.expiresAt <= now) return false;
    this.leases.set(key, { ...current, expiresAt: now + LEASE_TTL_MS });
    return true;
  }

  release(kind: DerivedKind, itineraryId: string, clientId: string): boolean {
    const key = leaseKey(kind, itineraryId);
    if (this.leases.get(key)?.clientId !== clientId) return false;
    this.leases.delete(key);
    return true;
  }

  /** Baux d'un client qui se déconnecte ; true si la table a changé. */
  releaseClient(clientId: string): boolean {
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (lease.clientId === clientId) {
        this.leases.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Retire les baux expirés ; true si la table a changé. */
  expire(now: number): boolean {
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Retire les baux d'un itinéraire supprimé. */
  dropItinerary(itineraryId: string): boolean {
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (lease.itineraryId === itineraryId) {
        this.leases.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  list(): LeaseInfo[] {
    return [...this.leases.values()];
  }
}
