import type { TileCoord, DownloadProgress } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { resolveDownloadUrls, cacheDownloadUrl } from '../wfsClient';
import { saveTileQuietly } from './archiveCandidates';
import {
  isFinalDownloadError,
  NoCoverageError,
  throwIfCancelled,
  type DownloadFailure,
} from './errors';
import { fetchWithRetry, INTER_REQUEST_DELAY_MS, sleep, waitForRateLimit } from './transport';

// IGN LiDAR HD (France) : URLs candidates par zone (WFS), essayées dans l'ordre.

function describeCandidateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const downloadIndex = parts.findIndex((part) => part === 'LiDARHD-NUALID');
    if (downloadIndex >= 0 && downloadIndex + 2 < parts.length) {
      const zoneName = parts[downloadIndex + 1];
      const fileName = parts[downloadIndex + 2];
      return `${zoneName}/${fileName}`;
    }
  } catch {
    // Ignore parse failures and keep the raw URL.
  }
  return url;
}

export async function downloadIgnTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfCancelled(signal);

  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: translateAppText('Découverte des zones...') });

  const urls = await resolveDownloadUrls(coord);
  throwIfCancelled(signal);
  if (urls.length === 0) {
    throw new NoCoverageError(translateAppText("Pas de couverture LiDAR HD à cet emplacement ({{x}}, {{y}}). Le programme LiDAR HD de l'IGN ne couvre pas encore cette zone.", { x: coord.xKm, y: coord.yKm }));
  }

  let lastError: DownloadFailure | null = null;
  let preferredError: DownloadFailure | null = null;
  let allNotFound = true;
  const triedCandidates: string[] = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const candidateLabel = describeCandidateUrl(url);
    triedCandidates.push(candidateLabel);

    try {
      throwIfCancelled(signal);
      await waitForRateLimit(signal);
      const buffer = await fetchWithRetry(url, coord, onProgress, 0, 0, undefined, false, signal);
      if (!buffer) continue;

      throwIfCancelled(signal);
      cacheDownloadUrl(coord, url);
      await saveTileQuietly(coord, buffer);
      return buffer;
    } catch (err: any) {
      if (isFinalDownloadError(err)) throw err;
      if (err.status !== 404) allNotFound = false;
      lastError = err;
      if (err.status === 404) {
        if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS, signal);
        continue;
      }
      if (err.code === 'ERR_INCOMPLETE_DOWNLOAD' || err.code === 'ERR_INVALID_LAS_SIGNATURE') {
        preferredError = err;
      }
      console.warn(`[Download] Failed for ${url}: ${err.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS, signal);
      continue;
    }
  }

  const finalError = preferredError ?? lastError;
  console.error(`[Download] All ${urls.length} candidate URLs failed for tile (${coord.xKm}, ${coord.yKm}). Candidates tried: ${triedCandidates.join(', ')}`);
  if (allNotFound) {
    // Chaque zone candidate a répondu 404 : le fichier n'existe nulle part
    // chez IGN → absence de couverture confirmée (utile au fallback CH→IGN).
    throw new NoCoverageError(
      translateAppText(
        'Pas de couverture LiDAR HD à cet emplacement ({{x}}, {{y}}) — {{count}} URL(s) testée(s), toutes introuvables (404).',
        { x: coord.xKm, y: coord.yKm, count: urls.length },
      )
    );
  }
  throw new Error(
    translateAppText(
      'Impossible de télécharger la tuile LiDAR HD pour ({{x}}, {{y}}) — {{count}} URL(s) testée(s), candidats [{{candidates}}]. Dernière erreur utile : {{error}}',
      {
        x: coord.xKm,
        y: coord.yKm,
        count: urls.length,
        candidates: `${triedCandidates.slice(0, 5).join(', ')}${triedCandidates.length > 5 ? '...' : ''}`,
        error: finalError?.message || translateAppText('inconnue'),
      },
    )
  );
}
