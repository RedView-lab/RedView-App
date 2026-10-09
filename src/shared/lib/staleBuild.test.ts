// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prompt = vi.fn();
vi.mock('./notify', () => ({ notify: { prompt } }));

type StaleBuildModule = typeof import('./staleBuild');

/** Module neuf à chaque test : l'installation et le toast sont uniques par page. */
async function freshModule(): Promise<StaleBuildModule> {
  vi.resetModules();
  return import('./staleBuild');
}

/** Ce que fait `__vitePreload` de Vite : l'événement, puis le rejet de l'import. */
function failingImport(): Promise<never> {
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  return Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/x.js'));
}

describe('isChunkLoadError', () => {
  it('reconnaît le chunk introuvable de chaque moteur', async () => {
    const { isChunkLoadError } = await freshModule();
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://redview.tech/assets/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://redview.tech/assets/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of \"text/html\". Strict MIME type checking is enforced for module scripts per HTML spec. 'text/html' is not a valid JavaScript MIME type."))).toBe(true);
  });

  it('laisse passer les autres erreurs', async () => {
    const { isChunkLoadError } = await freshModule();
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError({ message: 'Importing a module script failed.' })).toBe(false);
  });
});

describe('claimStaleBuildReload', () => {
  function memoryStorage() {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  }

  it('un rechargement par minute au plus', async () => {
    const { claimStaleBuildReload } = await freshModule();
    const storage = memoryStorage();
    expect(claimStaleBuildReload(storage, 100_000, { lastReloadAt: 0 })).toBe(true);
    // page rechargée : mémoire neuve, le stockage de session se souvient
    expect(claimStaleBuildReload(storage, 130_000, { lastReloadAt: 0 })).toBe(false);
    expect(claimStaleBuildReload(storage, 161_000, { lastReloadAt: 0 })).toBe(true);
  });

  it('stockage indisponible ou plein : la mémoire fait le garde', async () => {
    const { claimStaleBuildReload } = await freshModule();
    const memory = { lastReloadAt: 0 };
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(claimStaleBuildReload(full, 100_000, memory)).toBe(true);
    expect(claimStaleBuildReload(full, 110_000, memory)).toBe(false);
    expect(claimStaleBuildReload(null, 120_000, memory)).toBe(false);
    expect(claimStaleBuildReload(null, 161_000, memory)).toBe(true);
  });
});

describe('installStaleBuildRecovery', () => {
  const reload = vi.fn();
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    prompt.mockReset();
    reload.mockReset();
    window.sessionStorage.clear();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    vi.useFakeTimers();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("un import de navigation recharge la page et rend l'erreur à l'appelant", async () => {
    const { installStaleBuildRecovery, trackNavigationImport } = await freshModule();
    uninstall = installStaleBuildRecovery();
    await expect(trackNavigationImport(Promise.resolve().then(failingImport))).rejects.toThrow('dynamically imported module');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('page gardée par un beforeunload : le toast propose de recharger', async () => {
    const { installStaleBuildRecovery, trackNavigationImport } = await freshModule();
    uninstall = installStaleBuildRecovery();
    await trackNavigationImport(Promise.resolve().then(failingImport)).catch(() => undefined);
    vi.advanceTimersByTime(3_000);
    expect(prompt).toHaveBeenCalledTimes(1);
    prompt.mock.calls[0][2].onAction();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('un import de fond ne recharge jamais sous l’utilisateur', async () => {
    const { installStaleBuildRecovery } = await freshModule();
    uninstall = installStaleBuildRecovery();
    await Promise.resolve().then(failingImport).catch(() => undefined);
    await Promise.resolve().then(failingImport).catch(() => undefined);
    expect(reload).not.toHaveBeenCalled();
    // un seul toast par page
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][2].durationMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('un rechargement qui ne règle rien ne boucle pas', async () => {
    const { installStaleBuildRecovery, trackNavigationImport } = await freshModule();
    window.sessionStorage.setItem('redview:preload-error-reload-at', String(Date.now() - 5_000));
    uninstall = installStaleBuildRecovery();
    await trackNavigationImport(Promise.resolve().then(failingImport)).catch(() => undefined);
    expect(reload).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("l'événement n'est jamais annulé (sinon Vite résout l'import en undefined)", async () => {
    const { installStaleBuildRecovery, trackNavigationImport } = await freshModule();
    uninstall = installStaleBuildRecovery();
    const event = new Event('vite:preloadError', { cancelable: true });
    await trackNavigationImport(Promise.resolve().then(() => window.dispatchEvent(event)));
    expect(event.defaultPrevented).toBe(false);
  });
});
