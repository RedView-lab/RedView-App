// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /account : les appels simultanés partagent une requête, et les lectures
 * d'affichage (`reuseRecent`) reprennent un compte lu il y a moins de 15 s —
 * jamais celui d'une autre session, ni un compte modifié depuis.
 */

vi.mock('appwrite', () => import('@/shared/test/mockAppwriteSdk'));

const { __mock } = (await import('appwrite')) as unknown as typeof import('@/shared/test/mockAppwriteSdk');
const appwrite = await import('./appwrite');

const accountGets = () => __mock.calls.filter((call) => call === 'account.get').length;

beforeEach(() => {
  __mock.reset();
  appwrite.clearStoredAppwriteSession();
  appwrite.saveStoredAppwriteSession({ id: 'user-A' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /account partagé', () => {
  it('vérification de session et lecture simultanées : une seule requête', async () => {
    const [probed, read] = await Promise.all([appwrite.fetchAppwriteUser(), appwrite.getAppwriteUser()]);
    expect(probed.$id).toBe('user-A');
    expect(read?.$id).toBe('user-A');
    expect(accountGets()).toBe(1);
  });

  it('une lecture d’affichage reprend le compte lu juste avant ; une lecture normale le relit', async () => {
    await appwrite.fetchAppwriteUser();
    expect((await appwrite.getAppwriteUser({ reuseRecent: true }))?.$id).toBe('user-A');
    expect(accountGets()).toBe(1);
    await appwrite.getAppwriteUser();
    expect(accountGets()).toBe(2);
  });

  it('au-delà de 15 s, le compte est relu', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-10T10:00:00Z'));
    await appwrite.getAppwriteUser();
    vi.setSystemTime(Date.parse('2026-10-10T10:00:14Z'));
    await appwrite.getAppwriteUser({ reuseRecent: true });
    expect(accountGets()).toBe(1);
    vi.setSystemTime(Date.parse('2026-10-10T10:00:16Z'));
    await appwrite.getAppwriteUser({ reuseRecent: true });
    expect(accountGets()).toBe(2);
  });

  it('jamais le compte d’une autre session', async () => {
    await appwrite.getAppwriteUser();
    appwrite.clearStoredAppwriteSession();
    __mock.user = { $id: 'user-B', email: 'b@example.test', name: 'B', prefs: {} };
    appwrite.saveStoredAppwriteSession({ id: 'user-B' });
    expect((await appwrite.getAppwriteUser({ reuseRecent: true }))?.$id).toBe('user-B');
    expect(accountGets()).toBe(2);
  });

  it('un compte modifié remplace le compte retenu ; un changement inconnu l’oublie', async () => {
    await appwrite.getAppwriteUser();
    appwrite.rememberAppwriteUser(await appwrite.account.updatePrefs({ country: 'FR' }));
    expect((await appwrite.getAppwriteUser({ reuseRecent: true }))?.prefs).toEqual({ country: 'FR' });
    expect(accountGets()).toBe(1);

    appwrite.forgetRecentAppwriteUser();
    await appwrite.getAppwriteUser({ reuseRecent: true });
    expect(accountGets()).toBe(2);
  });

  it('401 : la lecture rend null et efface la session ; la vérification brute rejette', async () => {
    __mock.accountGetMode = 'unauthorized';
    await expect(appwrite.fetchAppwriteUser()).rejects.toMatchObject({ code: 401 });
    expect(await appwrite.getAppwriteUser()).toBeNull();
    expect(appwrite.getSessionUserIdSync()).toBeNull();
  });
});
