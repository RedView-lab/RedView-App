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

  it('écritures des préférences simultanées : l’une après l’autre, aucune n’efface la clé de l’autre', async () => {
    __mock.user = { ...__mock.user, prefs: { country: 'FR' } };
    // Une lecture déjà en cours avant les écritures ne doit pas servir de base à la seconde.
    const staleRead = appwrite.getAppwriteUser();
    const [consent, profiles] = await Promise.all([
      appwrite.updateAccountPrefs((prefs) => ({ ...prefs, healthDataConsent: null })),
      appwrite.updateAccountPrefs((prefs) => ({ ...prefs, routingProfiles: [] })),
    ]);
    await staleRead;
    expect(__mock.user.prefs).toEqual({ country: 'FR', healthDataConsent: null, routingProfiles: [] });
    expect(consent?.prefs).toEqual({ country: 'FR', healthDataConsent: null });
    expect(profiles?.prefs).toEqual(__mock.user.prefs);
    // Le compte écrit est retenu : une lecture d'affichage le voit sans GET.
    const gets = accountGets();
    expect((await appwrite.getAppwriteUser({ reuseRecent: true }))?.prefs).toEqual(__mock.user.prefs);
    expect(accountGets()).toBe(gets);
  });

  it('écriture des préférences : rien à écrire → aucun envoi ; un échec n’empêche pas la suivante', async () => {
    expect(await appwrite.updateAccountPrefs(() => null)).toMatchObject({ $id: 'user-A' });
    expect(__mock.prefsUpdates).toBe(0);
    __mock.dbNetworkDown = true;
    await expect(appwrite.updateAccountPrefs((prefs) => ({ ...prefs, a: 1 }))).rejects.toThrow();
    __mock.dbNetworkDown = false;
    await appwrite.updateAccountPrefs((prefs) => ({ ...prefs, b: 2 }));
    expect(__mock.user.prefs).toEqual({ b: 2 });
  });

  it('401 : la lecture rend null et efface la session ; la vérification brute rejette', async () => {
    __mock.accountGetMode = 'unauthorized';
    await expect(appwrite.fetchAppwriteUser()).rejects.toMatchObject({ code: 401 });
    expect(await appwrite.getAppwriteUser()).toBeNull();
    expect(appwrite.getSessionUserIdSync()).toBeNull();
  });
});
