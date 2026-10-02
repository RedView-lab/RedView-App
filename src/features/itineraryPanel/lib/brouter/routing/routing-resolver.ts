/**
 * Top-level orchestrator for the BRouter routing pipeline.
 *
 *   resolveItineraryRouting(itinerary)
 *     → builds a BRF from the itinerary's basic + expert state,
 *     → uploads it (cached by content hash),
 *     → returns the `{ profileId, warnings, brf }` to use in
 *       `fetchBrouterRoute({ profile: profileId })`.
 *
 * Every itinerary is routed with its generated profile (`custom_<id>`), even
 * with neutral sliders: a stock BRouter profile (trekking, hiking-mountain…)
 * would ignore the rider's settings and the RedView cost model. If the upload
 * fails twice, the routing fails with a clear message instead.
 */
import type { Itinerary } from '../../../types';
import { normalizeDiscipline } from '@/shared/lib/discipline';
import { buildBrfProfile, estimateBrfSearchCostScale } from '../profiles/brf-template';
import { ensureProfileUploaded } from '../profiles/profile-cache';
import { isBrouterRateLimitError } from '../api/client';
import {
  resolveRoadTypes,
  type RoadTypesResolution,
} from './road-types-resolver';

export interface ResolvedRouting {
  /** Generated profile id to pass to BRouter (`custom_<id>`). */
  profileId: string;
  /** Resolution of the road-type filters (warnings + auto-corrections). */
  roadTypes: RoadTypesResolution;
  /** The generated BRF text. */
  brf: string;
  /**
   * Coût BRouter au mètre attendu avec ce profil (coefficient A*, voir
   * api/searchCoefficient.ts).
   */
  searchCostScale: number;
}

/** Pause avant le second essai d'upload (redémarrage BRouter, réseau). */
const PROFILE_UPLOAD_RETRY_DELAY_MS = 1_000;

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function waitBeforeRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, PROFILE_UPLOAD_RETRY_DELAY_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function uploadProfileWithRetry(brf: string, signal?: AbortSignal): Promise<string> {
  try {
    return await ensureProfileUploaded(brf, signal);
  } catch (error) {
    if (isAbortError(error) || isBrouterRateLimitError(error)) throw error;
    console.warn('[BRouter] Custom profile upload failed, retrying once:', error);
  }
  try {
    await waitBeforeRetry(signal);
    return await ensureProfileUploaded(brf, signal);
  } catch (error) {
    if (isAbortError(error) || isBrouterRateLimitError(error)) throw error;
    console.warn('[BRouter] Custom profile upload failed again:', error);
    // Texte source : formatBrouterErrorMessage le traduit.
    throw new Error(
      'Impossible de calculer l’itinéraire : le profil de traçage est momentanément indisponible. Réessayez dans quelques secondes.',
      { cause: error },
    );
  }
}

export async function resolveItineraryRouting(
  it: Itinerary,
  signal?: AbortSignal,
): Promise<ResolvedRouting> {
  const roadTypes = resolveRoadTypes(it.roadTypes);
  const brfInputs = {
    priorities: it.priorities,
    roadTypes: roadTypes.effective,
    expert: it.expertProfile ?? null,
    discipline: normalizeDiscipline(it.discipline),
  };
  const brf = buildBrfProfile(brfInputs);
  const profileId = await uploadProfileWithRetry(brf, signal);
  return { profileId, roadTypes, brf, searchCostScale: estimateBrfSearchCostScale(brfInputs) };
}
