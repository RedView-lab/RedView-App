import type { TileCoord } from '../types/geometry';
import type { DownloadProgress } from '../types/events';
import { resolveDownloadUrls, cacheDownloadUrl } from './ign-zones';
import { saveTile, hasTile, loadTile } from '../storage/tile-store';

const DOWNLOAD_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 4;
const RETRY_BASE_429_MS = 2_000;
const RETRY_BASE_5XX_MS = 1_000;
const INTER_REQUEST_DELAY_MS = 200;

let rateLimitUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  if (rateLimitUntil > now) {
    await sleep(rateLimitUntil - now);
  }
}

function setRateLimit(retryAfterHeader: string | null, attempt: number): void {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds)) {
      rateLimitUntil = Date.now() + seconds * 1000;
      return;
    }
  }
  rateLimitUntil = Date.now() + RETRY_BASE_429_MS * 2 ** attempt;
}

async function fetchWithRetry(
  url: string,
  coord: TileCoord,
  onProgress?: (p: DownloadProgress) => void,
): Promise<ArrayBuffer | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await waitForRateLimit();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (resp.status === 404) return null;

      if (resp.status === 429) {
        setRateLimit(resp.headers.get('retry-after'), attempt);
        continue;
      }

      if (resp.status >= 500) {
        await sleep(RETRY_BASE_5XX_MS * 2 ** attempt);
        continue;
      }

      if (!resp.ok) return null;

      const totalBytes = parseInt(resp.headers.get('content-length') ?? '0', 10);

      if (!resp.body) {
        const buf = await resp.arrayBuffer();
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: buf.byteLength,
          totalBytes: buf.byteLength,
          phase: 'downloading',
        });
        return buf;
      }

      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let downloaded = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.byteLength;
        onProgress?.({
          tileCoord: coord,
          bytesDownloaded: downloaded,
          totalBytes,
          phase: 'downloading',
        });
      }

      const result = new Uint8Array(downloaded);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result.buffer;
    } catch (err) {
      clearTimeout(timeout);
      if (attempt === MAX_RETRIES - 1) {
        console.warn(`[lidar] Download failed after ${MAX_RETRIES} attempts:`, url, err);
        return null;
      }
      await sleep(RETRY_BASE_5XX_MS * 2 ** attempt);
    }
  }
  return null;
}

export async function downloadTile(
  coord: TileCoord,
  onProgress?: (p: DownloadProgress) => void,
): Promise<ArrayBuffer> {
  if (await hasTile(coord)) {
    onProgress?.({
      tileCoord: coord,
      bytesDownloaded: 0,
      totalBytes: 0,
      phase: 'cached',
      message: 'Loading from local cache',
    });
    const cached = await loadTile(coord);
    if (cached) return cached;
  }

  const urls = await resolveDownloadUrls(coord);
  if (urls.length === 0) {
    throw new Error(`No download URLs found for tile ${coord.xKm}_${coord.yKm}`);
  }

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const buf = await fetchWithRetry(url, coord, onProgress);
    if (buf && buf.byteLength > 0) {
      cacheDownloadUrl(coord, url);
      await saveTile(coord, buf);
      return buf;
    }
    if (i < urls.length - 1) {
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  }

  throw new Error(`All download URLs failed for tile ${coord.xKm}_${coord.yKm}`);
}
