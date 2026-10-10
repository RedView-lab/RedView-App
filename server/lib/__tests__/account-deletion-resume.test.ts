import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountDeletionResumeEnabled, startAccountDeletionResume } from '../account-deletion-resume.mjs';

// Reprise des suppressions de compte coupées par un redéploiement (A14-1) :
// seulement dans l'image de production, jamais dans un dist-server lancé par
// un banc avec la vraie clé.

const PROD = { NODE_ENV: 'production', REDVIEW_RESUME_ACCOUNT_DELETIONS: 'on', APPWRITE_API_KEY: 'key' };

describe('accountDeletionResumeEnabled', () => {
  it('coupée par défaut', () => {
    expect(accountDeletionResumeEnabled({})).toBe(false);
    expect(accountDeletionResumeEnabled({ NODE_ENV: 'production', APPWRITE_API_KEY: 'key' })).toBe(false);
  });

  it('il faut la production, la variable de l’image et la clé d’API', () => {
    expect(accountDeletionResumeEnabled(PROD)).toBe(true);
    expect(accountDeletionResumeEnabled({ ...PROD, NODE_ENV: 'development' })).toBe(false);
    expect(accountDeletionResumeEnabled({ ...PROD, APPWRITE_API_KEY: '' })).toBe(false);
    expect(accountDeletionResumeEnabled({ ...PROD, REDVIEW_RESUME_ACCOUNT_DELETIONS: '1' })).toBe(false);
  });
});

describe('startAccountDeletionResume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sans la variable : la route n’est jamais chargée', async () => {
    const loadResume = vi.fn();
    startAccountDeletionResume({ env: { NODE_ENV: 'production', APPWRITE_API_KEY: 'key' }, loadResume, report: vi.fn() });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(loadResume).not.toHaveBeenCalled();
  });

  it('dans l’image : un passage peu après le démarrage, puis à intervalle régulier', async () => {
    const resume = vi.fn(async () => []);
    const stop = startAccountDeletionResume({
      env: PROD,
      loadResume: async () => resume,
      report: vi.fn(),
      firstDelayMs: 60_000,
      intervalMs: 15 * 60_000,
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(resume).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('une erreur est signalée et le passage suivant a lieu ; jamais deux passages à la fois', async () => {
    const report = vi.fn();
    let finish!: () => void;
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error('appwrite 503'))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue([]);
    startAccountDeletionResume({ env: PROD, loadResume: async () => resume, report, firstDelayMs: 1_000, intervalMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // passage lent
    await vi.advanceTimersByTimeAsync(10_000); // sauté : le précédent n'est pas fini
    expect(resume).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('route sans la fonction : signalé', async () => {
    const report = vi.fn();
    startAccountDeletionResume({ env: PROD, loadResume: async () => undefined, report, firstDelayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('introuvable') }));
  });
});
