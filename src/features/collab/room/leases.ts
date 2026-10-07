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
 *  - le titulaire le libère à l'écriture du résultat ;
 *  - on ne le garde pas plus de `LEASE_MAX_HOLD_MS`, renouvellements compris :
 *    au-delà, il est retiré et son titulaire attend `LEASE_PENALTY_MS` avant
 *    de pouvoir le reprendre (un éditeur qui accaparerait les baux sans
 *    jamais calculer bloquerait le routage des autres).
 */

export const LEASE_TTL_MS = 20_000;
export const AUTHOR_PRIORITY_MS = 5_000;
/** Détention maximale d'un bail (un très long routage dure ≈ 2 min). */
const LEASE_MAX_HOLD_MS = 5 * 60_000;
const LEASE_PENALTY_MS = 60_000;

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
  /** Instant d'attribution de chaque bail (borne de détention). */
  private readonly grantedAt = new Map<string, number>();
  /** Client → bail → fin d'attente après un bail gardé trop longtemps. */
  private readonly penalties = new Map<string, number>();

  request(
    kind: DerivedKind,
    itineraryId: string,
    requester: LeaseRequester,
    now: number,
    context: LeaseContext,
  ): LeaseDecision {
    const key = leaseKey(kind, itineraryId);
    this.revokeOverheld(key, now);
    const penaltyEnd = this.penalties.get(`${requester.clientId}|${key}`);
    if (penaltyEnd !== undefined) {
      if (penaltyEnd > now) return { granted: false, retryAfterMs: penaltyEnd - now };
      this.penalties.delete(`${requester.clientId}|${key}`);
    }
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
    this.grantedAt.set(key, now);
    return { granted: true, lease, changed: true };
  }

  /** Bail tenu au-delà de la détention maximale : retiré, son titulaire attend. */
  private revokeOverheld(key: string, now: number): boolean {
    const current = this.leases.get(key);
    const since = this.grantedAt.get(key);
    if (!current || since === undefined || now - since < LEASE_MAX_HOLD_MS) return false;
    this.leases.delete(key);
    this.grantedAt.delete(key);
    this.penalties.set(`${current.clientId}|${key}`, now + LEASE_PENALTY_MS);
    if (this.penalties.size > 10_000) this.penalties.delete(this.penalties.keys().next().value!);
    return true;
  }

  /** Prolonge le bail de son titulaire ; false s'il ne le tient plus. */
  renew(kind: DerivedKind, itineraryId: string, clientId: string, now: number): boolean {
    const key = leaseKey(kind, itineraryId);
    this.revokeOverheld(key, now);
    const current = this.leases.get(key);
    if (!current || current.clientId !== clientId || current.expiresAt <= now) return false;
    this.leases.set(key, { ...current, expiresAt: now + LEASE_TTL_MS });
    return true;
  }

  release(kind: DerivedKind, itineraryId: string, clientId: string): boolean {
    const key = leaseKey(kind, itineraryId);
    if (this.leases.get(key)?.clientId !== clientId) return false;
    this.leases.delete(key);
    this.grantedAt.delete(key);
    return true;
  }

  /** Baux d'un client qui se déconnecte ; true si la table a changé. */
  releaseClient(clientId: string): boolean {
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (lease.clientId === clientId) {
        this.leases.delete(key);
        this.grantedAt.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Retire les baux expirés ou tenus trop longtemps ; true si la table a changé. */
  expire(now: number): boolean {
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (this.revokeOverheld(key, now)) {
        changed = true;
      } else if (lease.expiresAt <= now) {
        this.leases.delete(key);
        this.grantedAt.delete(key);
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
        this.grantedAt.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  list(): LeaseInfo[] {
    return [...this.leases.values()];
  }
}
