type IdleSchedulerWindow = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

let cacheWriteQueue = Promise.resolve();

/** Exécute les écritures de cache l'une après l'autre, chacune quand la page est inactive ; un échec est journalisé, jamais levé. */
export function enqueueBackgroundCacheWrite(label: string, task: () => Promise<void>): void {
  cacheWriteQueue = cacheWriteQueue
    .then(async () => {
      await new Promise<void>((resolve) => {
        const idleWindow = window as IdleSchedulerWindow;
        if (typeof idleWindow.requestIdleCallback === 'function') {
          idleWindow.requestIdleCallback(() => resolve(), { timeout: 1500 });
          return;
        }
        window.setTimeout(resolve, 250);
      });
      await task();
    })
    .catch((error) => {
      console.warn(`[Viewer] Background cache write failed (${label})`, error);
    });
}
