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
}));

vi.mock('@/shared/services/appwrite', () => ({
  account: {
    async updatePrefs(prefs: Record<string, unknown>) {
      if (state.failUpdate) throw new Error('hors ligne');
      state.updates.push(prefs);
      if (state.user) state.user.prefs = prefs;
      return state.user;
    },
  },
  getAppwriteUser: async () => state.user,
  getSessionUserIdSync: () => state.user?.$id ?? null,
  rememberAppwriteUser: () => {},
}));
vi.mock('@/shared/lib/notify', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

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
