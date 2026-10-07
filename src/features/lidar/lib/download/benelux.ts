import type { TileCoord, DownloadProgress } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import type { TileBounds } from '../tileCandidates';
import type { LasMergeOptions } from '../lasMerge';
import type { LasMergeRequest, LasMergeResponse } from '../../workers/lasMergeWorker';
import { getLazWasmModule } from '../lazWasm';
import { pointcloudProxyUrl } from '../pointcloudProxy';
import { footprintBounds, saveTileQuietly } from './archiveCandidates';
import {
  DownloadCancelledError,
  isFinalDownloadError,
  NoCoverageError,
  throwIfCancelled,
} from './errors';
import { fetchWithRetry, INTER_REQUEST_DELAY_MS, sleep, waitForRateLimit } from './transport';

// ---------------------------------------------------------------------------
// Pays-Bas (AHN, sous-dalles GeoTiles) et Flandre (DHMV II, EODaS OpenLidar)
// Sources sans CORS : téléchargées par le proxy same-origin `/api/pointcloud`.
// ---------------------------------------------------------------------------

/**
 * Emprise du fichier d'une dalle : la sienne pour une dalle-fichier, sinon
 * celle du fichier sous le centre de la dalle de 1 km (voisines du navigateur
 * de dalles du viewer).
 */
function fileFootprintOf(coord: TileCoord, findAt: (x: number, y: number) => TileBounds | null): TileBounds | null {
  return footprintBounds(coord) ?? findAt(coord.xKm * 1000 + 500, coord.yKm * 1000 + 500);
}

/** Préfixe la progression d'un fichier parmi plusieurs (« Bande 2/7 · Téléchargement … »). */
function withStepLabel(
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  label: string,
): ((progress: DownloadProgress) => void) | undefined {
  return onProgress && ((progress) => onProgress({ ...progress, message: progress.message ? `${label} · ${progress.message}` : label }));
}

export async function downloadNetherlandsTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfCancelled(signal);
  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: translateAppText('Recherche nuage de points AHN (Pays-Bas)...') });

  const { describeAhnUrl, findAhnFileFootprintAt, resolveAhnDownloadUrls } = await import('../netherlands/ahnClient');
  throwIfCancelled(signal);
  const footprint = fileFootprintOf(coord, findAhnFileFootprintAt);
  const urls = footprint ? resolveAhnDownloadUrls(footprint) : [];
  if (urls.length === 0) {
    throw new NoCoverageError(translateAppText('Pas de nuage de points AHN pour la dalle ({{x}}, {{y}}) : zone hors des Pays-Bas ou sans relevé publié.', { x: coord.xKm, y: coord.yKm }));
  }

  let lastError: Error | null = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    try {
      throwIfCancelled(signal);
      await waitForRateLimit(signal);
      const buffer = await fetchWithRetry(pointcloudProxyUrl(url), coord, withStepLabel(onProgress, describeAhnUrl(url)), 0, 0, undefined, false, signal);
      if (!buffer) continue;
      onProgress?.({ tileCoord: coord, bytesDownloaded: buffer.byteLength, totalBytes: buffer.byteLength, phase: 'downloading', message: translateAppText('Sauvegarde en cache local...') });
      await saveTileQuietly(coord, buffer);
      return buffer;
    } catch (err: unknown) {
      if (isFinalDownloadError(err)) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[AHN Download] Failed for ${url}: ${lastError.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS, signal);
    }
  }

  throw new Error(
    translateAppText(
      'Impossible de télécharger le nuage de points AHN ({{x}}, {{y}}) — {{count}} fichier(s) testé(s). Dernière erreur : {{error}}',
      { x: coord.xKm, y: coord.yKm, count: urls.length, error: lastError?.message || translateAppText('inconnue') },
    )
  );
}

/** Fusionne les bandes d'une cellule DHMV II dans un worker (voir `lasMerge.ts`). */
async function mergeLasInWorker(
  coord: TileCoord,
  files: ArrayBuffer[],
  options: LasMergeOptions,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const wasmModule = (await getLazWasmModule()) ?? undefined;
  throwIfCancelled(signal);
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = new Worker(new URL('../../workers/lasMergeWorker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(new DownloadCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<LasMergeResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        const percent = Math.round(message.done * 100);
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: 0,
          totalBytes: 0,
          phase: 'downloading',
          percent,
          message: translateAppText('Fusion des bandes de vol {{percent}} %', { percent }),
        });
        return;
      }
      finish();
      if (message.type === 'done') resolve(message.buffer);
      else reject(new Error(translateAppText('Fusion des bandes LiDAR impossible : {{error}}', { error: message.message })));
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(translateAppText('Fusion des bandes LiDAR impossible : {{error}}', { error: event.message || translateAppText('inconnue') })));
    };
    worker.postMessage({ files, options, wasmModule } satisfies LasMergeRequest, files);
  });
}

export async function downloadFlandersTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfCancelled(signal);
  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: translateAppText('Recherche des bandes LiDAR DHMV II (Flandre)...') });

  const { DHMV_MAX_CELL_POINTS, findDhmvCellFootprintAt, resolveDhmvStrips } = await import('../flanders/dhmvClient');
  throwIfCancelled(signal);
  const footprint = fileFootprintOf(coord, findDhmvCellFootprintAt);
  const strips = footprint ? await resolveDhmvStrips(footprint, signal) : [];
  throwIfCancelled(signal);
  if (!footprint || strips.length === 0) {
    throw new NoCoverageError(translateAppText('Pas de nuage de points DHMV II pour la dalle ({{x}}, {{y}}) : zone hors de la Flandre ou sans relevé publié.', { x: coord.xKm, y: coord.yKm }));
  }

  // Toutes les bandes de la cellule, ou rien : une bande manquante laisserait
  // un trou durable dans la dalle mise en cache.
  const files: ArrayBuffer[] = [];
  for (let i = 0; i < strips.length; i++) {
    throwIfCancelled(signal);
    await waitForRateLimit(signal);
    const label = translateAppText('Bande {{index}}/{{count}}', { index: i + 1, count: strips.length });
    const buffer = await fetchWithRetry(pointcloudProxyUrl(strips[i]!.url), coord, withStepLabel(onProgress, label), 0, 0, undefined, false, signal);
    if (!buffer) {
      throw new Error(translateAppText('Bande LiDAR DHMV II introuvable ({{index}}/{{count}}) : la dalle ({{x}}, {{y}}) ne peut pas être reconstituée.', { index: i + 1, count: strips.length, x: coord.xKm, y: coord.yKm }));
    }
    files.push(buffer);
  }

  const merged = await mergeLasInWorker(coord, files, {
    offsetX: footprint.minE,
    offsetY: footprint.minN,
    horizontalEpsg: 31370,
    verticalEpsg: 5710,
    maxPoints: DHMV_MAX_CELL_POINTS,
    systemIdentifier: 'DHMV II (Digitaal Vlaanderen)',
  }, onProgress, signal);
  throwIfCancelled(signal);

  onProgress?.({ tileCoord: coord, bytesDownloaded: merged.byteLength, totalBytes: merged.byteLength, phase: 'downloading', message: translateAppText('Sauvegarde en cache local...') });
  await saveTileQuietly(coord, merged);
  return merged;
}
