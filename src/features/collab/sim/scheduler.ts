import type { GateClock } from '../client/leaseGate';

/**
 * Horloge virtuelle et file d'événements du simulateur : tout (réseau,
 * minuteries des clients, serveur) avance au même temps simulé, dans un ordre
 * entièrement déterminé par la graine.
 */

interface ScheduledEvent {
  at: number;
  order: number;
  run: () => void;
  cancelled: boolean;
}

export class Scheduler implements GateClock {
  private time = 0;
  private order = 0;
  private readonly queue: ScheduledEvent[] = [];

  now(): number {
    return this.time;
  }

  at(time: number, run: () => void): ScheduledEvent {
    const event: ScheduledEvent = { at: Math.max(time, this.time), order: this.order++, run, cancelled: false };
    // Tas binaire (at, order).
    this.queue.push(event);
    let index = this.queue.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(this.queue[index], this.queue[parent])) break;
      [this.queue[index], this.queue[parent]] = [this.queue[parent], this.queue[index]];
      index = parent;
    }
    return event;
  }

  after(ms: number, run: () => void): ScheduledEvent {
    return this.at(this.time + ms, run);
  }

  setTimeout(callback: () => void, ms: number): unknown {
    return this.after(ms, callback);
  }

  clearTimeout(handle: unknown): void {
    if (handle) (handle as ScheduledEvent).cancelled = true;
  }

  setInterval(callback: () => void, ms: number): unknown {
    const handle = { cancelled: false };
    const tick = () => {
      if (handle.cancelled) return;
      callback();
      this.after(ms, tick);
    };
    this.after(ms, tick);
    return handle;
  }

  clearInterval(handle: unknown): void {
    if (handle) (handle as { cancelled: boolean }).cancelled = true;
  }

  /** Exécute les événements jusqu'au temps `time` (compris). */
  runUntil(time: number): void {
    while (this.queue.length > 0 && this.queue[0].at <= time) {
      const event = this.pop();
      this.time = event.at;
      if (!event.cancelled) event.run();
    }
    this.time = Math.max(this.time, time);
  }

  private pop(): ScheduledEvent {
    const top = this.queue[0];
    const last = this.queue.pop()!;
    if (this.queue.length > 0) {
      this.queue[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.queue.length && before(this.queue[left], this.queue[smallest])) smallest = left;
        if (right < this.queue.length && before(this.queue[right], this.queue[smallest])) smallest = right;
        if (smallest === index) break;
        [this.queue[index], this.queue[smallest]] = [this.queue[smallest], this.queue[index]];
        index = smallest;
      }
    }
    return top;
  }
}

function before(a: ScheduledEvent, b: ScheduledEvent): boolean {
  return a.at < b.at || (a.at === b.at && a.order < b.order);
}

/** Générateur pseudo-aléatoire à graine (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
