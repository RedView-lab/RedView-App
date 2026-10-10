import { beforeEach, describe, expect, it, vi } from 'vitest';

const appwrite = vi.hoisted(() => ({
  updatePassword: vi.fn<(password: string, oldPassword?: string) => Promise<unknown>>(),
  updateName: vi.fn<(name: string) => Promise<unknown>>(),
  updatePrefs: vi.fn<(prefs: Record<string, unknown>) => Promise<unknown>>(),
  deleteSession: vi.fn<(id: string) => Promise<unknown>>(),
  clearedSession: vi.fn(),
  clearedStore: vi.fn(),
  user: { $id: 'u1', name: 'Ada Lovelace', email: 'ada@example.test', prefs: {} } as Record<string, unknown>,
}));

vi.mock('@/shared/services/appwrite', () => ({
  account: {
    updatePassword: appwrite.updatePassword,
    updateName: appwrite.updateName,
    updatePrefs: appwrite.updatePrefs,
    deleteSession: appwrite.deleteSession,
  },
  clearStoredAppwriteSession: () => appwrite.clearedSession(),
  readStoredAppwriteSession: () => ({ user: { id: 'u1' } }),
  getAppwriteUser: async () => appwrite.user,
  rememberAppwriteUser: () => {},
  updateAccountPrefs: async (update: (prefs: Record<string, unknown>, user: Record<string, unknown>) => unknown) => {
    const next = await update({ ...(appwrite.user.prefs as Record<string, unknown>) }, appwrite.user);
    return next ? appwrite.updatePrefs(next as Record<string, unknown>) : appwrite.user;
  },
}));

vi.mock('@/shared/services/storage/idbProjectStore', () => ({ clearProjectStoreForUser: async (userId: string | null) => appwrite.clearedStore(userId) }));
vi.mock('@/shared/services/projects', () => ({ syncDirtyProjects: async () => ({ remaining: [] }) }));

const { accountUpdateFailureMessage, saveAccountIdentity, saveAccountPractice, signOutAccount, SignOutFailedError, updateAccountPassword } = await import('./profile');

/** Forme d'une AppwriteException : `code` HTTP + `type` stable. */
const appwriteError = (code: number, type: string) => Object.assign(new Error('english developer message'), { code, type });

beforeEach(() => {
  appwrite.updatePassword.mockReset().mockResolvedValue({});
  appwrite.updateName.mockReset().mockResolvedValue({});
  appwrite.updatePrefs.mockReset().mockResolvedValue(appwrite.user);
  appwrite.deleteSession.mockReset().mockResolvedValue({});
  appwrite.clearedSession.mockReset();
  appwrite.clearedStore.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('updateAccountPassword', () => {
  it('envoie l’ancien mot de passe quand il est connu (exigé par Appwrite), rien sinon', async () => {
    await updateAccountPassword('nouveau-123', 'ancien-123');
    expect(appwrite.updatePassword).toHaveBeenLastCalledWith('nouveau-123', 'ancien-123');
    await updateAccountPassword('nouveau-123');
    expect(appwrite.updatePassword).toHaveBeenLastCalledWith('nouveau-123', undefined);
  });

  it('un refus Appwrite devient un message pour l’utilisateur, jamais le message anglais', async () => {
    appwrite.updatePassword.mockRejectedValue(appwriteError(401, 'user_invalid_credentials'));
    await expect(updateAccountPassword('nouveau-123', 'faux')).rejects.toThrow('Mot de passe actuel incorrect.');
  });
});

describe('accountUpdateFailureMessage', () => {
  it('associe chaque type Appwrite connu à un message', () => {
    const fallback = 'repli';
    expect(accountUpdateFailureMessage(appwriteError(400, 'password_recently_used'), fallback)).toMatch(/^Ce mot de passe a déjà été utilisé/);
    expect(accountUpdateFailureMessage(appwriteError(400, 'password_personal_data'), fallback)).toMatch(/^Le mot de passe ne doit pas reprendre/);
    expect(accountUpdateFailureMessage(appwriteError(400, 'general_argument_invalid'), fallback)).toMatch(/^Mot de passe refusé/);
    expect(accountUpdateFailureMessage(appwriteError(429, 'general_rate_limit_exceeded'), fallback)).toMatch(/^Trop de tentatives/);
    expect(accountUpdateFailureMessage(appwriteError(403, 'user_blocked'), fallback)).toMatch(/^Session expirée/);
    expect(accountUpdateFailureMessage(new TypeError('Failed to fetch'), fallback)).toMatch(/^Impossible de joindre le serveur RedView/);
    expect(accountUpdateFailureMessage(appwriteError(500, 'general_unknown'), fallback)).toBe(fallback);
    expect(accountUpdateFailureMessage('nope', fallback)).toBe(fallback);
  });
});

describe('saveAccountIdentity', () => {
  it('enregistre nom et préférences, jamais l’adresse e-mail', async () => {
    await saveAccountIdentity({ firstName: 'Grace', lastName: 'Hopper', email: 'autre@example.test' });
    expect(appwrite.updateName).toHaveBeenCalledWith('Grace Hopper');
    expect(appwrite.updatePrefs).toHaveBeenCalledWith(expect.objectContaining({ first_name: 'Grace', last_name: 'Hopper' }));
  });

  it('un échec est remonté (plus de « Coordonnées enregistrées » quand rien n’est parti)', async () => {
    appwrite.updatePrefs.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(saveAccountIdentity({ firstName: 'Grace', lastName: 'Hopper', email: '' })).rejects.toThrow(/^Impossible de joindre/);
  });
});

describe('saveAccountPractice', () => {
  it('enregistre pays et sports en gardant les autres préférences', async () => {
    appwrite.user.prefs = { healthDataConsent: { version: 1 } };
    await saveAccountPractice({ country: 'FR', sports: [] });
    expect(appwrite.updatePrefs).toHaveBeenCalledWith({ healthDataConsent: { version: 1 }, country: 'FR', sports: [] });
    appwrite.user.prefs = {};
  });

  it('un échec est remonté (l’écran les marquait enregistrés quand rien n’était parti)', async () => {
    appwrite.updatePrefs.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(saveAccountPractice({ country: 'FR', sports: [] })).rejects.toThrow(/^Impossible de joindre/);
  });
});

describe('signOutAccount (A14-2)', () => {
  it('révoque la session serveur puis purge l’état local', async () => {
    await signOutAccount({ force: true });
    expect(appwrite.deleteSession).toHaveBeenCalledWith('current');
    expect(appwrite.clearedSession).toHaveBeenCalled();
    // Seules les données du compte qui part (B3-3 : jamais les copies non envoyées d'un autre compte).
    expect(appwrite.clearedStore).toHaveBeenCalledWith('u1');
  });

  it('révocation impossible (hors ligne) : erreur claire, rien n’est purgé — la session ne se rouvre pas au rechargement suivant par surprise', async () => {
    appwrite.deleteSession.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(signOutAccount({ force: true })).rejects.toBeInstanceOf(SignOutFailedError);
    expect(appwrite.clearedSession).not.toHaveBeenCalled();
    expect(appwrite.clearedStore).not.toHaveBeenCalled();
  });

  it('révocation lente : attendue au-delà de 1,5 s (l’ancien délai la coupait)', async () => {
    vi.useFakeTimers();
    try {
      let resolve: (value: unknown) => void = () => {};
      appwrite.deleteSession.mockImplementation(() => new Promise((r) => { resolve = r; }));
      const pending = signOutAccount({ force: true });
      await vi.advanceTimersByTimeAsync(3000);
      expect(appwrite.clearedSession).not.toHaveBeenCalled();
      resolve({});
      await pending;
      expect(appwrite.clearedSession).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('session déjà refusée par Appwrite (401) : rien à révoquer, la purge continue', async () => {
    appwrite.deleteSession.mockRejectedValue(appwriteError(401, 'general_unauthorized_scope'));
    await signOutAccount({ force: true });
    expect(appwrite.clearedSession).toHaveBeenCalled();
  });
});
