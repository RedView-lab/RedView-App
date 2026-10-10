// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Demande d'accord aux données de santé (.fit) : aucun .fit n'est lu ni envoyé
 * sans accord ; l'accord est écrit dans les préférences du compte sans effacer
 * les autres, versionné, et retirable.
 */

const state = vi.hoisted(() => ({
  user: null as { $id: string; prefs: Record<string, unknown> } | null,
  updates: [] as Array<Record<string, unknown>>,
  failUpdate: false,
  /** Écriture des préférences retenue jusqu'à `release()` (réseau lent). */
  holdUpdate: null as null | Promise<void>,
}));

vi.mock('@/shared/services/appwrite', () => ({
  getAppwriteUser: async () => state.user,
  getSessionUserIdSync: () => state.user?.$id ?? null,
  // Même contrat que le vrai : préférences relues, null sans session, lève si l'écriture échoue.
  async updateAccountPrefs(update: (prefs: Record<string, unknown>) => Record<string, unknown> | null) {
    if (!state.user) return null;
    const next = update({ ...state.user.prefs });
    if (!next) return state.user;
    if (state.holdUpdate) await state.holdUpdate;
    if (state.failUpdate) throw new Error('hors ligne');
    state.updates.push(next);
    state.user.prefs = next;
    return state.user;
  },
}));
const notifyMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), prompt: vi.fn() }));
vi.mock('@/shared/lib/notify', () => ({ notify: notifyMock }));

const consentService = await import('./healthDataConsent');
const { HEALTH_DATA_CONSENT_VERSION } = await import('@/shared/lib/healthDataConsent');

/** Répond à la pop-in dès qu'elle s'ouvre. */
function answerNextRequest(accepted: boolean) {
  const unsubscribe = consentService.subscribeHealthDataConsentRequest(() => {
    if (!consentService.isHealthDataConsentRequested()) return;
    unsubscribe();
    queueMicrotask(() => consentService.answerHealthDataConsentRequest(accepted));
  });
}

beforeEach(() => {
  state.user = { $id: 'moi', prefs: { country: 'FR' } };
  state.updates = [];
  state.failUpdate = false;
  state.holdUpdate = null;
  notifyMock.prompt.mockClear();
  consentService.resetHealthDataConsentCache();
  localStorage.clear();
});

describe('ensureHealthDataConsent', () => {
  it('refusé : faux, rien n’est écrit', async () => {
    answerNextRequest(false);
    await expect(consentService.ensureHealthDataConsent()).resolves.toBe(false);
    expect(state.updates).toEqual([]);
    expect(consentService.isHealthDataConsentRequested()).toBe(false);
  });

  it('accepté : écrit dans les préférences sans effacer les autres, puis ne redemande plus', async () => {
    answerNextRequest(true);
    await expect(consentService.ensureHealthDataConsent()).resolves.toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ country: 'FR', healthDataConsent: { version: HEALTH_DATA_CONSENT_VERSION } });
    // Déjà accepté : pas de pop-in (une demande ouverte ferait attendre ce test).
    await expect(consentService.ensureHealthDataConsent()).resolves.toBe(true);
    expect(consentService.isHealthDataConsentRequested()).toBe(false);
  });

  it('un accord d’une autre version du texte redemande', async () => {
    state.user!.prefs = { healthDataConsent: { version: HEALTH_DATA_CONSENT_VERSION + 1, acceptedAt: '2026-01-01T00:00:00.000Z' } };
    answerNextRequest(false);
    await expect(consentService.ensureHealthDataConsent()).resolves.toBe(false);
  });

  it('deux demandes simultanées partagent la même pop-in et la même réponse', async () => {
    answerNextRequest(true);
    const [first, second] = await Promise.all([
      consentService.ensureHealthDataConsent(),
      consentService.ensureHealthDataConsent(),
    ]);
    expect([first, second]).toEqual([true, true]);
  });

  it('accord non enregistré (hors ligne) : faux, l’envoi n’a pas lieu', async () => {
    state.failUpdate = true;
    answerNextRequest(true);
    await expect(consentService.ensureHealthDataConsent()).resolves.toBe(false);
  });
});

describe('retrait', () => {
  it('efface l’accord du compte et du miroir : la demande revient', async () => {
    answerNextRequest(true);
    await consentService.ensureHealthDataConsent();
    await consentService.withdrawHealthDataConsent();
    expect(state.user!.prefs).toMatchObject({ country: 'FR', healthDataConsent: null });
    expect(localStorage.getItem('redview:health-data-consent:moi')).toBeNull();
    answerNextRequest(false);
    await expect(consentService.ensureHealthDataConsent()).resolves.toBe(false);
  });

  it('un retrait fait sur un autre appareil est vu sans recharger, une fois le cache périmé', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      answerNextRequest(true);
      await consentService.ensureHealthDataConsent();
      state.user!.prefs = { country: 'FR' };
      vi.setSystemTime(Date.now() + 6 * 60_000);
      answerNextRequest(false);
      await expect(consentService.ensureHealthDataConsent()).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un retrait fait sur un autre appareil l’emporte sur le miroir local', async () => {
    answerNextRequest(true);
    await consentService.ensureHealthDataConsent();
    state.user!.prefs = { country: 'FR' };
    consentService.resetHealthDataConsentCache();
    await expect(consentService.loadHealthDataConsent()).resolves.toBeNull();
  });
});

/** Retient l'écriture du compte jusqu'à l'appel de la fonction rendue. */
function holdAccountWrite(): () => void {
  let release!: () => void;
  state.holdUpdate = new Promise<void>((resolve) => { release = resolve; });
  return () => { state.holdUpdate = null; release(); };
}

/** Attend que la pop-in s'ouvre. */
async function waitForRequest(): Promise<void> {
  for (let i = 0; i < 50 && !consentService.isHealthDataConsentRequested(); i += 1) await Promise.resolve();
  expect(consentService.isHealthDataConsentRequested()).toBe(true);
}

/**
 * A10-2 (audit du 2026-10-10) : le sélecteur de fichiers (`input.click()`)
 * exige l'activation utilisateur, que WebKit perd au bout d'environ 1 s
 * d'attente réseau (Chromium au bout de 5 s). Il s'ouvre donc dans le clic
 * même : tout de suite quand l'accord est déjà connu, ou dans le clic sur
 * « J'accepte », avant l'écriture de l'accord dans le compte.
 */
describe('runWithHealthDataConsent — sélecteur ouvert dans le geste de l’utilisateur (A10-2)', () => {
  it('accord déjà connu sur cet appareil : l’action part tout de suite, sans attendre le réseau', async () => {
    answerNextRequest(true);
    await consentService.ensureHealthDataConsent();
    // Nouvel onglet : rien en mémoire, seul le miroir local reste.
    consentService.resetHealthDataConsentCache();
    const open = vi.fn();
    consentService.runWithHealthDataConsent(open);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('pop-in : l’action part dans le clic sur « J’accepte », avant l’écriture du compte', async () => {
    const release = holdAccountWrite();
    const open = vi.fn();
    consentService.runWithHealthDataConsent(open);
    expect(open).not.toHaveBeenCalled();
    await waitForRequest();
    consentService.answerHealthDataConsentRequest(true);
    // Synchrone : encore dans le gestionnaire du clic, l'écriture n'est pas faite.
    expect(open).toHaveBeenCalledTimes(1);
    expect(state.updates).toEqual([]);
    release();
    // Les fichiers choisis entre-temps ne sont lus qu'une fois l'accord enregistré.
    await expect(consentService.ensureHealthDataConsent()).resolves.toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('accord non enregistré : les fichiers choisis dans le sélecteur ne sont pas lus', async () => {
    const release = holdAccountWrite();
    state.failUpdate = true;
    const open = vi.fn();
    consentService.runWithHealthDataConsent(open);
    await waitForRequest();
    consentService.answerHealthDataConsentRequest(true);
    expect(open).toHaveBeenCalledTimes(1);
    const reading = consentService.ensureHealthDataConsent();
    release();
    await expect(reading).resolves.toBe(false);
  });

  it('refus : l’action ne part pas', async () => {
    const open = vi.fn();
    consentService.runWithHealthDataConsent(open);
    await waitForRequest();
    consentService.answerHealthDataConsentRequest(false);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
  });

  it('accord trouvé dans le compte après une lecture lente : un bouton redonne le geste perdu', async () => {
    state.user!.prefs = { healthDataConsent: { version: HEALTH_DATA_CONSENT_VERSION, acceptedAt: '2026-01-01T00:00:00.000Z' } };
    const activation = { isActive: false, hasBeenActive: true };
    vi.stubGlobal('navigator', { ...navigator, userActivation: activation });
    try {
      const open = vi.fn();
      consentService.runWithHealthDataConsent(open);
      for (let i = 0; i < 50 && notifyMock.prompt.mock.calls.length === 0; i += 1) await Promise.resolve();
      expect(open).not.toHaveBeenCalled();
      expect(notifyMock.prompt).toHaveBeenCalledTimes(1);
      const options = notifyMock.prompt.mock.calls[0]![2] as { onAction: () => void };
      options.onAction();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
