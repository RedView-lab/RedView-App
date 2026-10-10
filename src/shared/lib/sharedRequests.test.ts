import { describe, expect, it, vi } from 'vitest';

import { createSharedRequests, isAbortError } from './sharedRequests';

/** Requête qui se termine quand le test le décide et honore son signal. */
function controllable<T>() {
  let finish: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const start = vi.fn((signal: AbortSignal) => new Promise<T>((resolve, reject) => {
    finish = resolve;
    fail = reject;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  return { start, finish: (value: T) => finish(value), fail: (error: unknown) => fail(error) };
}

describe('createSharedRequests', () => {
  it('une seule requête pour les appelants simultanés d’une même clé', async () => {
    const requests = createSharedRequests<string>();
    const request = controllable<string>();
    const a = requests.run('k', request.start);
    const b = requests.run('k', request.start);
    request.finish('ok');
    expect(await a).toBe('ok');
    expect(await b).toBe('ok');
    expect(request.start).toHaveBeenCalledTimes(1);
    expect(requests.has('k')).toBe(false);
  });

  it('l’abandon du premier appelant ne touche pas le suivant', async () => {
    const requests = createSharedRequests<string>();
    const request = controllable<string>();
    const first = new AbortController();
    const a = requests.run('k', request.start, { signal: first.signal });
    const b = requests.run('k', request.start, { signal: new AbortController().signal });
    first.abort();
    await expect(a).rejects.toSatisfy(isAbortError);
    request.finish('ok');
    expect(await b).toBe('ok');
    expect(request.start.mock.calls[0]![0].aborted).toBe(false);
  });

  it('abandonnée par tous : annulée et retirée, l’appelant suivant repart d’une requête neuve (effet React relancé)', async () => {
    const requests = createSharedRequests<string>();
    const request = controllable<string>();
    const previous = new AbortController();
    const dropped = requests.run('k', request.start, { signal: previous.signal });
    previous.abort();
    await expect(dropped).rejects.toSatisfy(isAbortError);
    expect(request.start.mock.calls[0]![0].aborted).toBe(true);
    expect(requests.has('k')).toBe(false);
    const fresh = requests.run('k', request.start, { signal: new AbortController().signal });
    request.finish('ok');
    expect(await fresh).toBe('ok');
    expect(request.start).toHaveBeenCalledTimes(2);
  });

  it('une erreur parvient à tous les appelants', async () => {
    const requests = createSharedRequests<string>();
    const request = controllable<string>();
    const a = requests.run('k', request.start);
    const b = requests.run('k', request.start);
    request.fail(new Error('HTTP 503'));
    await expect(a).rejects.toThrow('HTTP 503');
    await expect(b).rejects.toThrow('HTTP 503');
  });

  it('les événements vont à chaque appelant qui attend, dès le premier émis', async () => {
    const requests = createSharedRequests<string, number>();
    let emitLater: (event: number) => void = () => {};
    let finish: (value: string) => void = () => {};
    const start = (_signal: AbortSignal, emit: (event: number) => void) => {
      emit(0); // émis tout de suite
      emitLater = emit;
      return new Promise<string>((resolve) => { finish = resolve; });
    };
    const firstEvents: number[] = [];
    const secondEvents: number[] = [];
    const a = requests.run('k', start, { onEvent: (event) => firstEvents.push(event) });
    const b = requests.run('k', start, { onEvent: (event) => secondEvents.push(event) });
    emitLater(1);
    finish('ok');
    await Promise.all([a, b]);
    expect(firstEvents).toEqual([0, 1]);
    expect(secondEvents).toEqual([1]);
  });

  it('un appelant déjà annulé ne lance rien', async () => {
    const requests = createSharedRequests<string>();
    const request = controllable<string>();
    const aborted = new AbortController();
    aborted.abort();
    await expect(requests.run('k', request.start, { signal: aborted.signal })).rejects.toSatisfy(isAbortError);
    expect(request.start).not.toHaveBeenCalled();
  });
});
