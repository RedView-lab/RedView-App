/**
 * Cache en mémoire des profils BRouter personnalisés.
 *
 * Le point d'accès POST `/brouter/profile` de BRouter compile chaque envoi et
 * renvoie un identifiant `custom_<id>`. On déduplique les envois par hachage du
 * contenu pour que régler et re-régler le même panneau n'inonde jamais le proxy.
 *
 * Durée de vie : le cache vit le temps de la page. Les profils personnalisés
 * sont gardés par le processus BRouter autonome environ 24 h (réglable côté
 * serveur) — bien au-delà de ce dont une session de navigation a besoin.
 */
import { uploadCustomProfile } from '../api/client';
import { hashBrf } from './brf-template';

/**
 * Limite d'une tentative d'envoi de profil. BRouter compile un profil en ~1 s,
 * mais sur une liaison lente (allers-retours de 1 s : montagne, partage de
 * connexion) l'envoi de ~20 Ko plus la compilation prenaient 7–10 s ; une
 * limite de 6 s annulait des envois que le serveur terminait ensuite, deux fois
 * de suite, et le routage échouait purement et simplement (bench:collab-prod,
 * 2026-10-07). La seconde tentative sert à un redémarrage de BRouter, qui échoue vite.
 */
export const PROFILE_UPLOAD_TIMEOUT_MS = 20_000;

interface CacheEntry {
  /** custom_<id> renvoyé par le serveur. */
  profileId: string;
  /** Promesse de l'envoi en cours (pour que les appelants simultanés la partagent). */
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
 * Envoie le profil personnalisé `brf` au serveur BRouter et renvoie son `profileId`.
 * Dédupliqué en mémoire : les requêtes simultanées/répétées pour le même
 * contenu de profil partagent un seul envoi.
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
      const result = await uploadCustomProfile(brf, uploadCtrl.signal);
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

/** Vide le cache en mémoire (surtout utile dans les tests). */
export function clearProfileCache(): void {
  cache.clear();
}

