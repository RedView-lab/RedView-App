/**
 * In-memory cache for custom BRouter profiles.
 *
 * BRouter's `/brouter/profile` POST endpoint compiles each upload and
 * returns a `custom_<id>` handle. We dedup uploads by content-hash so
 * tweaking-and-re-tweaking the same panel never spams the proxy.
 *
 * Lifetime: the cache lives for the duration of the page. Custom
 * profiles are kept by the BRouter standalone process for ~24 h
 * (configurable server-side) — well beyond what any single browsing
 * session would need.
 */
import { uploadCustomProfile } from '../api/client';
import { hashBrf } from './brf-template';

const PROFILE_UPLOAD_TIMEOUT_MS = 25000;

interface CacheEntry {
  /** custom_<id> returned by the server. */
  profileId: string;
  /** In-flight promise for the upload (so concurrent callers share). */
  pending?: Promise<string>;
}

const cache = new Map<string, CacheEntry>();

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('aborted', 'AbortError');
  }
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((_, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForProfileUpload(pending: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return pending;
  return Promise.race([pending, waitForAbort(signal)]);
}

import { logger } from '@/shared/lib/logger';

/**
 * Upload `brf` custom profile to the BRouter server, returning its `profileId`.
 * Deduplicated in-memory: concurrent/repeated requests for the same profile
 * content share a single upload.
 */
export async function ensureProfileUploaded(
  brf: string,
  signal?: AbortSignal,
): Promise<string> {
  const key = hashBrf(brf);
  const cached = cache.get(key);
  if (cached) {
    if (cached.profileId) {
      logger.brouter.debug('profile cache HIT', key, '→', cached.profileId);
      return cached.profileId;
    }
    if (cached.pending) {
      logger.brouter.debug('profile upload in-flight, sharing', key);
      return waitForProfileUpload(cached.pending, signal);
    }
  }

  logger.brouter.debug('profile cache MISS', key, '→ uploading', brf.length, 'B');
  const uploadCtrl = new AbortController();
  const timeoutId = setTimeout(() => {
    uploadCtrl.abort(new Error(`BRouter profile upload timed out after ${PROFILE_UPLOAD_TIMEOUT_MS}ms`));
  }, PROFILE_UPLOAD_TIMEOUT_MS);
  const pending = (async () => {
    try {
      const result = await uploadCustomProfile(brf, undefined, uploadCtrl.signal);
      if (result.error) {
        logger.brouter.error('profile compile error', key, result.error);
        throw new Error(`BRouter a refusé le profil : ${result.error}`);
      }
      cache.set(key, { profileId: result.profileId });
      logger.brouter.debug('profile uploaded', key, '→', result.profileId);
      return result.profileId;
    } catch (error) {
      cache.delete(key);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  cache.set(key, { profileId: '', pending });
  return waitForProfileUpload(pending, signal);
}

/** Clear the in-memory cache (mostly useful in tests). */
export function clearProfileCache(): void {
  cache.clear();
}

/** Number of cached profiles (mostly useful in tests / debug). */
export function profileCacheSize(): number {
  return cache.size;
}
