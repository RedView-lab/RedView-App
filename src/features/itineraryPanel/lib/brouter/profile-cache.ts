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
import { uploadCustomProfile } from './client';
import { hashBrf } from './brf-template';

interface CacheEntry {
  /** custom_<id> returned by the server. */
  profileId: string;
  /** In-flight promise for the upload (so concurrent callers share). */
  pending?: Promise<string>;
}

const cache = new Map<string, CacheEntry>();

/**
 * Ensure `brf` is uploaded to BRouter and return the custom profile id
 * to use in subsequent routing requests. Concurrent calls for the same
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
      console.log('[BRouter] profile cache HIT', key, '→', cached.profileId);
      return cached.profileId;
    }
    if (cached.pending) {
      console.log('[BRouter] profile upload in-flight, sharing', key);
      return cached.pending;
    }
  }

  console.log('[BRouter] profile cache MISS', key, '→ uploading', brf.length, 'B');
  const pending = (async () => {
    const result = await uploadCustomProfile(brf, undefined, signal);
    if (result.error) {
      // Compile-error: drop the cache entry and surface the message.
      cache.delete(key);
      console.error('[BRouter] profile compile error', key, result.error);
      throw new Error(`BRouter a refusé le profil : ${result.error}`);
    }
    cache.set(key, { profileId: result.profileId });
    console.log('[BRouter] profile uploaded', key, '→', result.profileId);
    return result.profileId;
  })();

  cache.set(key, { profileId: '', pending });
  return pending;
}

/** Clear the in-memory cache (mostly useful in tests). */
export function clearProfileCache(): void {
  cache.clear();
}

/** Number of cached profiles (mostly useful in tests / debug). */
export function profileCacheSize(): number {
  return cache.size;
}
