/**
 * File d'attente devant un service amont à capacité fixe (BRouter autonome).
 *
 * BRouter calcule au plus `maxthreads` requêtes à la fois (4 en production,
 * server/vps/brouter.service) ; au-delà, il attend au plus 2 s puis TUE le
 * calcul le plus ancien (« operation killed by thread-priority-watchdog ») —
 * envois de profil compris. Un tracé en cours échoue alors, le client le
 * réessaie, le double et se rabat sur les ancres : la charge s'amplifie
 * précisément quand le serveur est saturé. Ici, au plus `slots` requêtes
 * partent vers l'amont ; les suivantes attendent leur tour dans l'ordre
 * d'arrivée, et une requête dont le client est parti avant son tour (nouvelle
 * modification, doublage gagné par l'autre, onglet fermé) ne coûte rien.
 */

/** File pleine, ou attente plus longue que `maxWaitMs` : à refuser en 503 avec Retry-After. */
export class UpstreamBusyError extends Error {
  readonly reason: 'file-pleine' | 'attente';

  constructor(reason: 'file-pleine' | 'attente') {
    super(reason === 'file-pleine' ? 'upstream queue full' : 'upstream queue wait exceeded');
    this.name = 'UpstreamBusyError';
    this.reason = reason;
  }
}

export interface UpstreamSlot {
  /** Temps passé dans la file (ms). */
  readonly waitedMs: number;
  /** Rend la place (idempotent). */
  release(): void;
}

export interface UpstreamGate {
  /**
   * Attend une place. Rejette avec la raison de `signal` s'il s'annule avant
   * (la place n'est jamais prise), ou `UpstreamBusyError`.
   */
  acquire(signal?: AbortSignal): Promise<UpstreamSlot>;
  readonly active: number;
  readonly queued: number;
}

interface Waiter {
  enqueuedAt: number;
  grant(): void;
}

export function createUpstreamGate({
  slots,
  maxQueue,
  maxWaitMs,
  now = () => performance.now(),
}: {
  slots: number;
  maxQueue: number;
  maxWaitMs: number;
  now?: () => number;
}): UpstreamGate {
  let active = 0;
  const queue: Waiter[] = [];

  const slotFor = (enqueuedAt: number): UpstreamSlot => {
    let released = false;
    return {
      waitedMs: now() - enqueuedAt,
      release() {
        if (released) return;
        released = true;
        active -= 1;
        const next = queue.shift();
        if (next) next.grant();
      },
    };
  };

  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    acquire(signal) {
      const enqueuedAt = now();
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (active < slots && queue.length === 0) {
        active += 1;
        return Promise.resolve(slotFor(enqueuedAt));
      }
      if (queue.length >= maxQueue) return Promise.reject(new UpstreamBusyError('file-pleine'));
      return new Promise<UpstreamSlot>((resolve, reject) => {
        const leave = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          leave();
          reject(signal!.reason ?? new DOMException('aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          leave();
          reject(new UpstreamBusyError('attente'));
        }, maxWaitMs);
        const waiter: Waiter = {
          enqueuedAt,
          grant() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            active += 1;
            resolve(slotFor(enqueuedAt));
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.push(waiter);
      });
    },
  };
}
