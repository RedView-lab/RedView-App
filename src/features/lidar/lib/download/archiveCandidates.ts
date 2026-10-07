import type { TileCoord, DownloadProgress } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import type { TileBounds } from '../tileCandidates';
import { saveTile, hasValidLasSignature, hasValidZipSignature, StorageFullError } from '../storage';
import { extractLasFromZip } from '../swiss/zipReader';
import { isFinalDownloadError, throwIfCancelled } from './errors';
import { fetchWithRetry, INTER_REQUEST_DELAY_MS, sleep, waitForRateLimit } from './transport';

/** Emprise du fichier visé par une dalle-fichier (Japon, NZ), au format des index. */
export function footprintBounds(coord: TileCoord): TileBounds | undefined {
  const fp = coord.footprint;
  return fp ? { minE: fp.minX, minN: fp.minY, maxE: fp.maxX, maxN: fp.maxY } : undefined;
}

/**
 * Met la dalle en cache local ; un échec d'écriture ne fait pas échouer le
 * téléchargement, sauf un stockage plein : le viewer n'ouvrirait pas la dalle.
 */
export async function saveTileQuietly(coord: TileCoord, buffer: ArrayBuffer): Promise<void> {
  try {
    await saveTile(coord, buffer);
  } catch (saveErr) {
    if (saveErr instanceof StorageFullError) throw saveErr;
    console.warn(`[LiDAR storage] Failed to cache tile locally:`, saveErr);
  }
}

interface ArchiveCandidatesOptions {
  coord: TileCoord;
  urls: string[];
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** Message de progression pendant la décompression d'une archive .zip. */
  unzipMessage: string;
  /** Erreur levée quand le fichier extrait n'est pas un LAS valide. */
  corruptMessage: string;
  /** Préfixe des avertissements console (« Swiss », « NZ »…). */
  logTag: string;
}

/**
 * Essaie les URLs candidates d'une dalle dans l'ordre : téléchargement (LAS ou
 * archive .zip à extraire), contrôle de signature, mise en cache. Renvoie le
 * LAS de la première qui aboutit, sinon la dernière erreur et si toutes ont
 * répondu 404 (absence de couverture confirmée).
 */
export async function downloadFirstArchiveCandidate({
  coord,
  urls,
  onProgress,
  signal,
  unzipMessage,
  corruptMessage,
  logTag,
}: ArchiveCandidatesOptions): Promise<
  { buffer: ArrayBuffer } | { buffer: null; lastError: Error | null; allNotFound: boolean }
> {
  let lastError: Error | null = null;
  let allNotFound = true;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      throwIfCancelled(signal);
      await waitForRateLimit(signal);
      const downloadedBuffer = await fetchWithRetry(url, coord, onProgress, 0, 0, undefined, true, signal);
      if (!downloadedBuffer) continue;

      throwIfCancelled(signal);
      let lasBuffer: ArrayBuffer;
      if (hasValidZipSignature(downloadedBuffer)) {
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: downloadedBuffer.byteLength,
          totalBytes: downloadedBuffer.byteLength,
          phase: 'downloading',
          message: unzipMessage,
        });
        lasBuffer = await extractLasFromZip(downloadedBuffer);
      } else {
        lasBuffer = downloadedBuffer;
      }

      throwIfCancelled(signal);
      if (!hasValidLasSignature(lasBuffer)) {
        throw new Error(corruptMessage);
      }

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded: lasBuffer.byteLength,
        totalBytes: lasBuffer.byteLength,
        phase: 'downloading',
        message: translateAppText('Sauvegarde en cache local...'),
      });
      await saveTileQuietly(coord, lasBuffer);
      return { buffer: lasBuffer };
    } catch (err: any) {
      if (isFinalDownloadError(err)) throw err;
      if (err.status !== 404) allNotFound = false;
      lastError = err;
      if (err.status === 404) {
        if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS, signal);
        continue;
      }
      console.warn(`[${logTag} Download] Failed for ${url}: ${err.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS, signal);
      continue;
    }
  }
  return { buffer: null, lastError, allNotFound };
}
