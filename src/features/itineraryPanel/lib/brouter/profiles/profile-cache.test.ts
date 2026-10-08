import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadCustomProfile = vi.fn();
vi.mock('../api/client', () => ({ uploadCustomProfile: (...args: unknown[]) => uploadCustomProfile(...args) }));

const { clearProfileCache, ensureProfileUploaded, PROFILE_UPLOAD_TIMEOUT_MS } = await import('./profile-cache');

/** Un envoi qui répond après `ms` (jamais si null), ou échoue si son signal est annulé avant. */
function answerAfter(ms: number | null, profileId = 'custom_1') {
  return (_brf: string, signal: AbortSignal) => new Promise((resolve, reject) => {
    const timer = ms === null ? undefined : setTimeout(() => resolve({ profileId }), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

describe('ensureProfileUploaded', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearProfileCache();
    uploadCustomProfile.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('waits for an upload slowed by a bad link (8 s) instead of aborting it', async () => {
    uploadCustomProfile.mockImplementation(answerAfter(8_000));
    const upload = ensureProfileUploaded('assign x = 1');
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(upload).resolves.toBe('custom_1');
  });

  it('gives up on an upload that never answers', async () => {
    uploadCustomProfile.mockImplementation(answerAfter(null));
    const upload = expect(ensureProfileUploaded('assign y = 2')).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(PROFILE_UPLOAD_TIMEOUT_MS);
    await upload;
  });

  it('shares one upload between concurrent callers and caches its id', async () => {
    uploadCustomProfile.mockImplementation(answerAfter(1_000, 'custom_2'));
    const a = ensureProfileUploaded('assign z = 3');
    const b = ensureProfileUploaded('assign z = 3');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(Promise.all([a, b])).resolves.toEqual(['custom_2', 'custom_2']);
    await expect(ensureProfileUploaded('assign z = 3')).resolves.toBe('custom_2');
    expect(uploadCustomProfile).toHaveBeenCalledTimes(1);
  });
});
