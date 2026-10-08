import { afterEach, describe, expect, it, vi } from 'vitest';

import { createUpstreamGate, UpstreamBusyError } from '../upstreamGate';

afterEach(() => {
  vi.useRealTimers();
});

describe('createUpstreamGate', () => {
  it('passe tout de suite tant qu’il reste des places', async () => {
    const gate = createUpstreamGate({ slots: 2, maxQueue: 10, maxWaitMs: 1_000 });
    const a = await gate.acquire();
    const b = await gate.acquire();
    expect(gate.active).toBe(2);
    expect(a.waitedMs).toBeLessThan(50);
    a.release();
    b.release();
    expect(gate.active).toBe(0);
  });

  it('sert la file dans l’ordre d’arrivée, une place rendue à la fois', async () => {
    const gate = createUpstreamGate({ slots: 1, maxQueue: 10, maxWaitMs: 10_000 });
    const first = await gate.acquire();
    const order: string[] = [];
    const second = gate.acquire().then((slot) => {
      order.push('second');
      return slot;
    });
    const third = gate.acquire().then((slot) => {
      order.push('third');
      return slot;
    });
    expect(gate.queued).toBe(2);
    first.release();
    (await second).release();
    (await third).release();
    expect(order).toEqual(['second', 'third']);
    expect(gate.active).toBe(0);
    expect(gate.queued).toBe(0);
  });

  it('une requête annulée pendant l’attente quitte la file sans prendre de place', async () => {
    const gate = createUpstreamGate({ slots: 1, maxQueue: 10, maxWaitMs: 10_000 });
    const first = await gate.acquire();
    const controller = new AbortController();
    const abandoned = gate.acquire(controller.signal);
    const next = gate.acquire();
    controller.abort(new Error('client parti'));
    await expect(abandoned).rejects.toThrow('client parti');
    expect(gate.queued).toBe(1);
    first.release();
    const slot = await next;
    expect(gate.active).toBe(1);
    slot.release();
    expect(gate.active).toBe(0);
  });

  it('refuse une requête déjà annulée', async () => {
    const gate = createUpstreamGate({ slots: 1, maxQueue: 10, maxWaitMs: 1_000 });
    const controller = new AbortController();
    controller.abort(new Error('déjà annulée'));
    await expect(gate.acquire(controller.signal)).rejects.toThrow('déjà annulée');
    expect(gate.active).toBe(0);
  });

  it('refuse quand la file est pleine', async () => {
    const gate = createUpstreamGate({ slots: 1, maxQueue: 1, maxWaitMs: 10_000 });
    const first = await gate.acquire();
    const queued = gate.acquire();
    await expect(gate.acquire()).rejects.toBeInstanceOf(UpstreamBusyError);
    first.release();
    (await queued).release();
  });

  it('abandonne une attente trop longue, la place libérée va au suivant', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const gate = createUpstreamGate({ slots: 1, maxQueue: 10, maxWaitMs: 5_000, now: () => clock });
    const first = await gate.acquire();
    const waiting = gate.acquire();
    const rejection = expect(waiting).rejects.toMatchObject({ reason: 'attente' });
    clock = 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(gate.queued).toBe(0);
    const late = gate.acquire();
    clock = 6_000;
    first.release();
    const slot = await late;
    expect(slot.waitedMs).toBe(1_000);
    slot.release();
  });

  it('rendre deux fois la même place ne libère qu’une place', async () => {
    const gate = createUpstreamGate({ slots: 1, maxQueue: 10, maxWaitMs: 1_000 });
    const slot = await gate.acquire();
    slot.release();
    slot.release();
    expect(gate.active).toBe(0);
    const again = await gate.acquire();
    expect(gate.active).toBe(1);
    again.release();
  });
});
