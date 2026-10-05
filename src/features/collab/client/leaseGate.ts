import type { DerivedComputeGate, DerivedKind } from '@/features/itineraryPanel/context/ProjectStore/collab';

import type { ClientMessage, LeaseInfo } from '../protocol';
import { LEASE_TTL_MS } from '../room/leases';

/**
 * Porte des calculs dérivés en session (tracé, prédiction, POI) : on calcule
 * seulement avec le bail du serveur (room/leases.ts). Sans bail connu, le
 * premier `shouldCompute` le demande et répond « non » ; la réponse du serveur
 * prévient les abonnés, qui redemandent.
 *
 * Hors ligne plus de `OFFLINE_SOLO_MS` (serveur temps réel injoignable, mais
 * BRouter peut l'être), l'appareil calcule seul : ses résultats rejoindront
 * le document à la reconnexion.
 */

const OFFLINE_SOLO_MS = 4_000;
/** Demande restée sans réponse (connexion perdue entre-temps) : on peut redemander. */
const REQUEST_TIMEOUT_MS = 10_000;
const RENEW_INTERVAL_MS = Math.floor(LEASE_TTL_MS / 3);
/** Bail obtenu mais aucun calcul lancé dans ce délai : rendu aux autres. */
const UNUSED_LEASE_GRACE_MS = 2_000;

export interface LeaseGateTransport {
  isOnline(): boolean;
  /** Envoi ordonné après les lots en attente (un `release` suit toujours le résultat écrit). */
  send(message: ClientMessage): void;
}

export interface GateClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const BROWSER_CLOCK: GateClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

const leaseKey = (kind: DerivedKind, itineraryId: string) => `${kind}|${itineraryId}`;

interface Running {
  count: number;
  renew: unknown;
}

export class LeaseGate implements DerivedComputeGate {
  private readonly clientId: string;
  private readonly transport: LeaseGateTransport;
  private readonly clock: GateClock;
  private leases = new Map<string, LeaseInfo>();
  private readonly requested = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Set<unknown>();
  private offlineSince: number | null;

  constructor(clientId: string, transport: LeaseGateTransport, clock: GateClock = BROWSER_CLOCK) {
    this.clientId = clientId;
    this.transport = transport;
    this.clock = clock;
    this.offlineSince = clock.now();
    this.notifyAfter(OFFLINE_SOLO_MS);
  }

  shouldCompute(kind: DerivedKind, itineraryId: string): boolean {
    const now = this.clock.now();
    if (!this.transport.isOnline()) {
      return this.offlineSince !== null && now - this.offlineSince >= OFFLINE_SOLO_MS;
    }
    const key = leaseKey(kind, itineraryId);
    const lease = this.leases.get(key);
    if (lease) return lease.clientId === this.clientId;
    if (now - (this.requested.get(key) ?? -Infinity) < REQUEST_TIMEOUT_MS) return false;
    if ((this.cooldownUntil.get(key) ?? 0) > now) return false;
    this.requested.set(key, now);
    this.transport.send({ type: 'lease', action: 'request', kind, itineraryId });
    return false;
  }

  beginCompute(kind: DerivedKind, itineraryId: string): () => void {
    const key = leaseKey(kind, itineraryId);
    // Calcul lancé sans `shouldCompute` (action de l'utilisateur lui-même) :
    // le bail est réclamé, pour que personne d'autre ne refasse le même calcul.
    if (!this.leases.has(key) && !this.requested.has(key) && this.transport.isOnline()) {
      this.requested.set(key, this.clock.now());
      this.transport.send({ type: 'lease', action: 'request', kind, itineraryId });
    }
    let running = this.running.get(key);
    if (!running) {
      running = {
        count: 0,
        renew: this.clock.setInterval(() => {
          if (this.holds(key) && this.transport.isOnline()) {
            this.transport.send({ type: 'lease', action: 'renew', kind, itineraryId });
          }
        }, RENEW_INTERVAL_MS),
      };
      this.running.set(key, running);
    }
    running.count += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const current = this.running.get(key);
      if (!current) return;
      current.count -= 1;
      if (current.count > 0) return;
      this.clock.clearInterval(current.renew);
      this.running.delete(key);
      if (this.holds(key) && this.transport.isOnline()) {
        this.transport.send({ type: 'lease', action: 'release', kind, itineraryId });
      }
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Bail tenu par cet appareil. */
  holds(key: string): boolean {
    return this.leases.get(key)?.clientId === this.clientId;
  }

  /** Baux en cours (affichage : « Simon recalcule le tracé… »). */
  currentLeases(): LeaseInfo[] {
    return [...this.leases.values()];
  }

  // ── Messages du serveur et état de la connexion ───────────────────────────

  setLeases(leases: readonly LeaseInfo[]): void {
    this.leases = new Map(leases.map((lease) => [leaseKey(lease.kind, lease.itineraryId), lease]));
    for (const [key, lease] of this.leases) {
      this.requested.delete(key);
      if (lease.clientId === this.clientId && !this.running.has(key)) this.releaseIfUnused(lease);
    }
    // Un bail libéré : ceux qui attendaient réévaluent (résultat écrit, ou à refaire).
    this.notify();
  }

  /** Bail tenu sans calcul (calcul déjà fini, ou plus nécessaire) : libéré après un court délai. */
  private releaseIfUnused(lease: LeaseInfo): void {
    const key = leaseKey(lease.kind, lease.itineraryId);
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.holds(key) || this.running.has(key) || !this.transport.isOnline()) return;
      this.transport.send({ type: 'lease', action: 'release', kind: lease.kind, itineraryId: lease.itineraryId });
    }, UNUSED_LEASE_GRACE_MS);
    this.timers.add(timer);
  }

  denied(kind: DerivedKind, itineraryId: string, retryAfterMs: number): void {
    const key = leaseKey(kind, itineraryId);
    this.requested.delete(key);
    this.cooldownUntil.set(key, this.clock.now() + retryAfterMs);
    this.notifyAfter(retryAfterMs + 1);
  }

  connectionChanged(online: boolean): void {
    if (online) {
      this.offlineSince = null;
    } else {
      this.offlineSince = this.clock.now();
      this.leases.clear();
      this.requested.clear();
      this.cooldownUntil.clear();
      this.notifyAfter(OFFLINE_SOLO_MS);
    }
    this.notify();
  }

  dispose(): void {
    for (const timer of this.timers) this.clock.clearTimeout(timer);
    this.timers.clear();
    for (const running of this.running.values()) this.clock.clearInterval(running.renew);
    this.running.clear();
    this.listeners.clear();
  }

  private notifyAfter(ms: number): void {
    const timer = this.clock.setTimeout(() => {
      this.timers.delete(timer);
      this.notify();
    }, ms);
    this.timers.add(timer);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
