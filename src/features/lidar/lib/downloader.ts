import type { TileCoord, DownloadProgress } from '../types';
import { resolveDownloadUrls, cacheDownloadUrl } from './wfsClient';
import { saveTile, hasTile, loadTile, hasValidLasSignature, hasValidZipSignature } from './storage';
import { resolveSwissDownloadUrls } from './swiss/stacClient';
import { extractLasFromZip } from './swiss/zipReader';
import { resolveNzDownloadUrls } from './nz/stacClient';
import { resolveJapanDownloadUrls } from './japan/stacClient';
import { isJgd2011Crs, parseJgd2011Zone } from './coordConvert';

const DOWNLOAD_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 4;
const MAX_INCOMPLETE_DOWNLOAD_RETRIES = 3;
const RETRY_BASE_DELAY_429_MS = 2000;
const RETRY_BASE_DELAY_5XX_MS = 1000;
const INTER_REQUEST_DELAY_MS = 200;

type DownloadFailure = Error & {
  status?: number;
  code?: string;
};

type ResumeState = {
  chunks: Uint8Array[];
  bytesDownloaded: number;
  totalBytes: number;
};

function formatBytesAsMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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

let rateLimitUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  if (now < rateLimitUntil) {
    const wait = rateLimitUntil - now;
    console.log(`[Download] Rate limited, waiting ${wait}ms...`);
    await sleep(wait);
  }
}

function setRateLimit(delayMs: number): void {
  const until = Date.now() + delayMs;
  if (until > rateLimitUntil) rateLimitUntil = until;
}

function parseContentRange(headerValue: string | null): { start: number; end: number; total: number } | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total)) return null;
  return { start, end, total };
}

function mergeChunks(chunks: Uint8Array[]): ArrayBuffer {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function invalidLasSignatureError(buffer: ArrayBuffer): DownloadFailure {
  const bytes = new Uint8Array(buffer.slice(0, Math.min(4, buffer.byteLength)));
  const preview = Array.from(bytes)
    .map((value) => String.fromCharCode(value >= 32 && value <= 126 ? value : 0xFFFD))
    .join('');
  const err = new Error(`Signature LAS/COPC invalide: ${preview || 'vide'}`) as DownloadFailure;
  err.code = 'ERR_INVALID_LAS_SIGNATURE';
  return err;
}

export async function downloadTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void
): Promise<ArrayBuffer> {
  if (await hasTile(coord)) {
    onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'cached', message: 'Chargement depuis le cache...' });
    const cached = await loadTile(coord);
    if (cached) return cached;
  }

  if (coord.projection === 'CH1903_LV95') {
    return downloadSwissTile(coord, onProgress);
  }

  if (coord.projection === 'NZTM2000') {
    return downloadNzTile(coord, onProgress);
  }

  if (isJgd2011Crs(coord.projection)) {
    return downloadJapanTile(coord, onProgress);
  }

  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: 'Découverte des zones...' });

  const urls = await resolveDownloadUrls(coord);
  if (urls.length === 0) {
    throw new Error(`Pas de couverture LiDAR HD à cet emplacement (${coord.xKm}, ${coord.yKm}). Le programme LiDAR HD de l'IGN ne couvre pas encore cette zone.`);
  }

  let lastError: DownloadFailure | null = null;
  let preferredError: DownloadFailure | null = null;
  const triedCandidates: string[] = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const candidateLabel = describeCandidateUrl(url);
    triedCandidates.push(candidateLabel);

    try {
      await waitForRateLimit();
      const buffer = await fetchWithRetry(url, coord, onProgress);
      if (!buffer) continue;

      cacheDownloadUrl(coord, url);
      await saveTile(coord, buffer);
      return buffer;
    } catch (err: any) {
      lastError = err;
      if (err.status === 404) {
        if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
        continue;
      }
      if (err.code === 'ERR_INCOMPLETE_DOWNLOAD' || err.code === 'ERR_INVALID_LAS_SIGNATURE') {
        preferredError = err;
      }
      console.warn(`[Download] Failed for ${url}: ${err.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
      continue;
    }
  }

  const finalError = preferredError ?? lastError;
  console.error(`[Download] All ${urls.length} candidate URLs failed for tile (${coord.xKm}, ${coord.yKm}). Candidates tried: ${triedCandidates.join(', ')}`);
  throw new Error(
    `Impossible de télécharger la tuile LiDAR HD pour (${coord.xKm}, ${coord.yKm}) — ` +
    `${urls.length} URL(s) testée(s), candidats [${triedCandidates.slice(0, 5).join(', ')}${triedCandidates.length > 5 ? '...' : ''}]. ` +
    `Dernière erreur utile: ${finalError?.message || 'inconnue'}`
  );
}

async function fetchWithRetry(
  url: string,
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  attempt = 0,
  incompleteRetryCount = 0,
  resumeState?: ResumeState,
  allowZip = false,
): Promise<ArrayBuffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const requestedResumeBytes = resumeState?.bytesDownloaded ?? 0;
    const requestHeaders = requestedResumeBytes > 0
      ? { Range: `bytes=${requestedResumeBytes}-` }
      : undefined;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: requestHeaders,
    });
    clearTimeout(timeout);

    console.log(
      `[Download] Attempt ${attempt + 1}${requestedResumeBytes > 0 ? ` (resume @ ${formatBytesAsMb(requestedResumeBytes)})` : ''} ${url} -> HTTP ${response.status}`,
    );

    if (response.status === 404) {
      console.warn(`[Download] 404 for ${url}`);
      const err = new Error('Not found') as any;
      err.status = 404;
      throw err;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      let delay: number;
      if (retryAfter) {
        const secs = parseInt(retryAfter, 10);
        delay = isNaN(secs) ? RETRY_BASE_DELAY_429_MS * Math.pow(2, attempt) : secs * 1000;
      } else {
        delay = RETRY_BASE_DELAY_429_MS * Math.pow(2, attempt);
      }
      setRateLimit(delay);
      if (attempt < MAX_RETRIES) {
        onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: `Limite de débit, attente ${(delay / 1000).toFixed(0)}s...` });
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt + 1, incompleteRetryCount, resumeState, allowZip);
      }
      const err = new Error(`HTTP 429 after ${MAX_RETRIES} retries`) as any;
      err.status = 429;
      throw err;
    }

    if (response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_5XX_MS * Math.pow(2, attempt);
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt + 1, incompleteRetryCount, resumeState, allowZip);
      }
      throw new Error(`Server error ${response.status} after ${MAX_RETRIES} retries`);
    }

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`) as any;
      err.status = response.status;
      throw err;
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const contentRange = parseContentRange(response.headers.get('content-range'));
    const effectiveContentRange = contentRange
      ?? (response.status === 206 && requestedResumeBytes > 0 && contentLength > 0
        ? {
            start: requestedResumeBytes,
            end: requestedResumeBytes + contentLength - 1,
            total: requestedResumeBytes + contentLength,
          }
        : null);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    let chunks = resumeState?.chunks ? [...resumeState.chunks] : [];
    let bytesDownloaded = resumeState?.bytesDownloaded ?? 0;
    let totalBytes = resumeState?.totalBytes ?? 0;

    if (response.status === 206 && effectiveContentRange) {
      if (requestedResumeBytes > 0 && effectiveContentRange.start !== requestedResumeBytes) {
        console.warn(
          `[Download] Resume offset mismatch for ${url} (wanted ${requestedResumeBytes}, got ${effectiveContentRange.start}); restarting full download`,
        );
        return fetchWithRetry(url, coord, onProgress, attempt, incompleteRetryCount + 1, undefined, allowZip);
      }
      totalBytes = effectiveContentRange.total;
    } else {
      totalBytes = contentLength;
      if (requestedResumeBytes > 0) {
        console.warn(`[Download] Range resume ignored for ${url}; restarting full download`);
        chunks = [];
        bytesDownloaded = 0;
      }
    }

    if (bytesDownloaded > 0) {
      onProgress?.({
        tileCoord: coord,
        bytesDownloaded,
        totalBytes,
        phase: 'downloading',
        message: totalBytes > 0
          ? `Reprise du téléchargement ${formatBytesAsMb(bytesDownloaded)} / ${formatBytesAsMb(totalBytes)}`
          : `Reprise du téléchargement ${formatBytesAsMb(bytesDownloaded)}`,
      });
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      bytesDownloaded += value.byteLength;

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded,
        totalBytes,
        phase: 'downloading',
        message: totalBytes > 0
          ? `Téléchargement ${(bytesDownloaded / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`
          : `Téléchargement ${(bytesDownloaded / 1024 / 1024).toFixed(1)} MB`,
      });
    }

    if (totalBytes > 0 && bytesDownloaded !== totalBytes) {
      const err = new Error(
        `Téléchargement incomplet: ${formatBytesAsMb(bytesDownloaded)} reçus sur ${formatBytesAsMb(totalBytes)} attendus.`
      ) as Error & { code?: string; resumeState?: ResumeState };
      err.code = 'ERR_INCOMPLETE_DOWNLOAD';
      err.resumeState = {
        chunks,
        bytesDownloaded,
        totalBytes,
      };
      throw err;
    }

    const merged = mergeChunks(chunks);
    const isValid = hasValidLasSignature(merged) || (allowZip && hasValidZipSignature(merged));
    if (!isValid) {
      if (requestedResumeBytes > 0 && incompleteRetryCount < MAX_INCOMPLETE_DOWNLOAD_RETRIES) {
        const delay = Math.max(1500, RETRY_BASE_DELAY_5XX_MS * Math.pow(2, incompleteRetryCount));
        console.warn(
          `[Download] Resumed buffer for ${url} has invalid signature; restarting full download in ${delay}ms (${incompleteRetryCount + 1}/${MAX_INCOMPLETE_DOWNLOAD_RETRIES})`,
        );
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt, incompleteRetryCount + 1, undefined, allowZip);
      }
      throw invalidLasSignatureError(merged);
    }

    return merged;
  } catch (err: any) {
    clearTimeout(timeout);

    if (err.name === 'AbortError') {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_5XX_MS * Math.pow(2, attempt);
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt + 1, incompleteRetryCount, resumeState, allowZip);
      }
      throw new Error('Download timeout after retries');
    }

    if (err?.code === 'ERR_INCOMPLETE_DOWNLOAD') {
      if (incompleteRetryCount < MAX_INCOMPLETE_DOWNLOAD_RETRIES) {
        const delay = Math.max(1500, RETRY_BASE_DELAY_5XX_MS * Math.pow(2, incompleteRetryCount));
        const nextResumeState = err.resumeState as ResumeState | undefined;
        const willResume = (nextResumeState?.bytesDownloaded ?? 0) > 0;
        console.warn(
          `[Download] Incomplete stream for ${url}; ${willResume ? `resuming from ${formatBytesAsMb(nextResumeState!.bytesDownloaded)}` : 'retrying from zero'} in ${delay}ms (${incompleteRetryCount + 1}/${MAX_INCOMPLETE_DOWNLOAD_RETRIES})`,
        );
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: nextResumeState?.bytesDownloaded ?? 0,
          totalBytes: nextResumeState?.totalBytes ?? 0,
          phase: 'downloading',
          message: willResume
            ? `Téléchargement interrompu, reprise ${incompleteRetryCount + 2}/${MAX_INCOMPLETE_DOWNLOAD_RETRIES + 1}...`
            : `Téléchargement interrompu, nouvelle tentative ${incompleteRetryCount + 2}/${MAX_INCOMPLETE_DOWNLOAD_RETRIES + 1}...`,
        });
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt, incompleteRetryCount + 1, nextResumeState, allowZip);
      }
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Swiss (swisstopo swissSURFACE3D) download path
// ---------------------------------------------------------------------------

async function downloadSwissTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void
): Promise<ArrayBuffer> {
  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: 'Recherche STAC swisstopo...' });

  const urls = await resolveSwissDownloadUrls({ eastKm: coord.xKm, northKm: coord.yKm });
  if (urls.length === 0) {
    throw new Error(`Pas de couverture swissSURFACE3D à cet emplacement (E${coord.xKm}, N${coord.yKm}).`);
  }

  let lastError: Error | null = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await waitForRateLimit();
      const downloadedBuffer = await fetchWithRetry(url, coord, onProgress, 0, 0, undefined, true);
      if (!downloadedBuffer) continue;

      let lasBuffer: ArrayBuffer;
      if (hasValidZipSignature(downloadedBuffer)) {
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: downloadedBuffer.byteLength,
          totalBytes: downloadedBuffer.byteLength,
          phase: 'downloading',
          message: 'Décompression .las.zip...',
        });
        lasBuffer = await extractLasFromZip(downloadedBuffer);
      } else {
        lasBuffer = downloadedBuffer;
      }

      if (!hasValidLasSignature(lasBuffer)) {
        throw new Error('Fichier nuage de points suisse corrompu (signature LAS invalide).');
      }

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded: lasBuffer.byteLength,
        totalBytes: lasBuffer.byteLength,
        phase: 'downloading',
        message: 'Sauvegarde en cache local...',
      });
      await saveTile(coord, lasBuffer);
      return lasBuffer;
    } catch (err: any) {
      lastError = err;
      if (err.status === 404) {
        if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
        continue;
      }
      console.warn(`[Swiss Download] Failed for ${url}: ${err.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
      continue;
    }
  }

  throw new Error(
    `Impossible de télécharger la tuile swissSURFACE3D (E${coord.xKm}, N${coord.yKm}) — ${urls.length} URL(s) testée(s). Dernière erreur: ${lastError?.message || 'inconnue'}`
  );
}

// ---------------------------------------------------------------------------
// New Zealand (OpenTopography / LINZ Raw LiDAR Point Clouds) download path
// ---------------------------------------------------------------------------

async function downloadNzTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void
): Promise<ArrayBuffer> {
  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: 'Recherche nuage de points LiDAR Nouvelle-Zélande...' });

  const urls = await resolveNzDownloadUrls({ eastKm: coord.xKm, northKm: coord.yKm });
  if (urls.length === 0) {
    throw new Error(`Pas de nuage de points LiDAR classifié disponible pour la dalle (${coord.xKm}, ${coord.yKm}). Cette zone n'a pas encore fait l'objet d'un survol LiDAR.`);
  }

  let lastError: Error | null = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await waitForRateLimit();
      const downloadedBuffer = await fetchWithRetry(url, coord, onProgress, 0, 0, undefined, true);
      if (!downloadedBuffer) continue;

      let lasBuffer: ArrayBuffer;
      if (hasValidZipSignature(downloadedBuffer)) {
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: downloadedBuffer.byteLength,
          totalBytes: downloadedBuffer.byteLength,
          phase: 'downloading',
          message: 'Décompression archive point cloud .laz...',
        });
        lasBuffer = await extractLasFromZip(downloadedBuffer);
      } else {
        lasBuffer = downloadedBuffer;
      }

      if (!hasValidLasSignature(lasBuffer)) {
        throw new Error('Fichier nuage de points néo-zélandais corrompu (signature LAS invalide).');
      }

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded: lasBuffer.byteLength,
        totalBytes: lasBuffer.byteLength,
        phase: 'downloading',
        message: 'Sauvegarde en cache local...',
      });
      await saveTile(coord, lasBuffer);
      return lasBuffer;
    } catch (err: any) {
      lastError = err;
      if (err.status === 404) {
        if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
        continue;
      }
      console.warn(`[NZ Download] Failed for ${url}: ${err.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
      continue;
    }
  }

  throw new Error(
    `Impossible de télécharger le nuage de points LiDAR Nouvelle-Zélande (${coord.xKm}, ${coord.yKm}) — ${urls.length} URL(s) testée(s). Dernière erreur: ${lastError?.message || 'inconnue'}`
  );
}

// ---------------------------------------------------------------------------
// Japan (JGD2011 / S3 Open Data / VIRTUAL SHIZUOKA / Tokyo 3D Point Clouds)
// ---------------------------------------------------------------------------

async function downloadJapanTile(
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void
): Promise<ArrayBuffer> {
  const zone = parseJgd2011Zone(coord.projection);
  onProgress?.({
    tileCoord: coord,
    bytesDownloaded: 0,
    totalBytes: 0,
    phase: 'downloading',
    message: `Recherche nuage de points LiDAR Japon (Zone ${zone})...`,
  });

  const urls = await resolveJapanDownloadUrls({
    eastKm: coord.xKm,
    northKm: coord.yKm,
    zone,
  });

  if (urls.length === 0) {
    throw new Error(
      `Pas de nuage de points LiDAR classifié disponible pour la dalle (${coord.xKm}, ${coord.yKm}) en zone JGD2011 ${zone}. Cette zone n'a pas encore fait l'objet d'un relevé ouvert.`
    );
  }

  let lastError: Error | null = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await waitForRateLimit();
      const downloadedBuffer = await fetchWithRetry(url, coord, onProgress, 0, 0, undefined, true);
      if (!downloadedBuffer) continue;

      let lasBuffer: ArrayBuffer;
      if (hasValidZipSignature(downloadedBuffer)) {
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: downloadedBuffer.byteLength,
          totalBytes: downloadedBuffer.byteLength,
          phase: 'downloading',
          message: 'Décompression archive point cloud LAS Japon...',
        });
        lasBuffer = await extractLasFromZip(downloadedBuffer);
      } else {
        lasBuffer = downloadedBuffer;
      }

      if (!hasValidLasSignature(lasBuffer)) {
        throw new Error('Fichier nuage de points japonais corrompu (signature LAS invalide).');
      }

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded: lasBuffer.byteLength,
        totalBytes: lasBuffer.byteLength,
        phase: 'downloading',
        message: 'Sauvegarde en cache local...',
      });
      await saveTile(coord, lasBuffer);
      return lasBuffer;
    } catch (err: any) {
      lastError = err;
      if (err.status === 404) {
        if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
        continue;
      }
      console.warn(`[Japan Download] Failed for ${url}: ${err.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
      continue;
    }
  }

  throw new Error(
    `Impossible de télécharger le nuage de points LiDAR Japon (${coord.xKm}, ${coord.yKm}, zone ${zone}) — ${urls.length} URL(s) testée(s). Dernière erreur: ${lastError?.message || 'inconnue'}`
  );
}

