import type { TileCoord, DownloadProgress } from '../types';
import { resolveDownloadUrls, cacheDownloadUrl } from './wfsClient';
import { saveTile, hasTile, loadTile } from './storage';
import { resolveSwissDownloadUrls } from './swiss/stacClient';
import { extractLasFromZip } from './swiss/zipReader';

const DOWNLOAD_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 4;
const MAX_INCOMPLETE_DOWNLOAD_RETRIES = 1;
const RETRY_BASE_DELAY_429_MS = 2000;
const RETRY_BASE_DELAY_5XX_MS = 1000;
const INTER_REQUEST_DELAY_MS = 200;

type DownloadFailure = Error & {
  status?: number;
  code?: string;
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

  onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: 'Découverte des zones...' });

  const urls = await resolveDownloadUrls(coord);
  if (urls.length === 0) {
    throw new Error(`Pas de couverture LiDAR HD à cet emplacement (${coord.xKm}, ${coord.yKm}). Le programme LiDAR HD de l'IGN ne couvre pas encore cette zone.`);
  }

  let lastError: DownloadFailure | null = null;
  let preferredError: DownloadFailure | null = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      await waitForRateLimit();
      const buffer = await fetchWithRetry(url, coord, onProgress);
      if (buffer) {
        cacheDownloadUrl(coord, url);
        onProgress?.({ tileCoord: coord, bytesDownloaded: buffer.byteLength, totalBytes: buffer.byteLength, phase: 'downloading', message: 'Sauvegarde en cache local...' });
        await saveTile(coord, buffer);
        return buffer;
      }
    } catch (err: any) {
      const failure = err as DownloadFailure;
      lastError = failure;
      if (failure.status !== 404 || preferredError == null) {
        preferredError = failure;
      }
      if (failure.status === 404) {
        if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
        continue;
      }
      console.warn(`[Download] Failed for ${url}: ${failure.message}`);
      if (i < urls.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
      continue;
    }
  }

  const triedCandidates = urls
    .map((url) => describeCandidateUrl(url))
    .filter((value, index, all) => all.indexOf(value) === index);
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
  attempt = 0
): Promise<ArrayBuffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    console.log(`[Download] Attempt ${attempt + 1} ${url} -> HTTP ${response.status}`);

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
        onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: `Limite de débit IGN, attente ${(delay / 1000).toFixed(0)}s...` });
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt + 1);
      }
      const err = new Error(`HTTP 429 after ${MAX_RETRIES} retries`) as any;
      err.status = 429;
      throw err;
    }

    if (response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_5XX_MS * Math.pow(2, attempt);
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt + 1);
      }
      throw new Error(`Server error ${response.status} after ${MAX_RETRIES} retries`);
    }

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`) as any;
      err.status = response.status;
      throw err;
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const chunks: Uint8Array[] = [];
    let bytesDownloaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      bytesDownloaded += value.byteLength;

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded,
        totalBytes: contentLength,
        phase: 'downloading',
        message: contentLength > 0
          ? `Téléchargement ${(bytesDownloaded / 1024 / 1024).toFixed(1)} / ${(contentLength / 1024 / 1024).toFixed(1)} MB`
          : `Téléchargement ${(bytesDownloaded / 1024 / 1024).toFixed(1)} MB`,
      });
    }

    if (contentLength > 0 && bytesDownloaded !== contentLength) {
      const err = new Error(
        `Téléchargement incomplet: ${formatBytesAsMb(bytesDownloaded)} reçus sur ${formatBytesAsMb(contentLength)} attendus.`
      ) as Error & { code?: string };
      err.code = 'ERR_INCOMPLETE_DOWNLOAD';
      throw err;
    }

    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return result.buffer;
  } catch (err: any) {
    clearTimeout(timeout);

    if (err.name === 'AbortError') {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_5XX_MS * Math.pow(2, attempt);
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt + 1);
      }
      throw new Error('Download timeout after retries');
    }

    if (err?.code === 'ERR_INCOMPLETE_DOWNLOAD') {
      if (attempt < MAX_INCOMPLETE_DOWNLOAD_RETRIES) {
        const delay = RETRY_BASE_DELAY_5XX_MS * Math.pow(2, attempt);
        console.warn(`[Download] Incomplete stream for ${url}; retrying in ${delay}ms (${attempt + 1}/${MAX_INCOMPLETE_DOWNLOAD_RETRIES})`);
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: 0,
          totalBytes: 0,
          phase: 'downloading',
          message: `Téléchargement interrompu, nouvelle tentative ${attempt + 2}/${MAX_INCOMPLETE_DOWNLOAD_RETRIES + 1}...`,
        });
        await sleep(delay);
        return fetchWithRetry(url, coord, onProgress, attempt + 1);
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
      const zipBuffer = await fetchWithRetry(url, coord, onProgress);
      if (!zipBuffer) continue;

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded: zipBuffer.byteLength,
        totalBytes: zipBuffer.byteLength,
        phase: 'downloading',
        message: 'Décompression .las.zip...',
      });

      const lasBuffer = await extractLasFromZip(zipBuffer);

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
        // try next year
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

