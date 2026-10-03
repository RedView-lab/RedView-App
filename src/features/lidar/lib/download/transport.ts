import type { TileCoord, DownloadProgress } from '../../types';
import { translateAppText } from '@/shared/i18n/config';
import { hasValidLasSignature, hasValidZipSignature } from '../storage';
import {
  DownloadCancelledError,
  invalidLasSignatureError,
  throwIfCancelled,
} from './errors';

// Transport HTTP des dalles : délais, limitation de débit partagée (429),
// reprise par `Range` d'un flux interrompu et nouvelles tentatives.

const DOWNLOAD_TIMEOUT_MS = 600_000;
/** Délai max sans recevoir un octet du corps avant d'abandonner et de reprendre (Range). */
const READ_IDLE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
const MAX_INCOMPLETE_DOWNLOAD_RETRIES = 3;
const RETRY_BASE_DELAY_429_MS = 2000;
const RETRY_BASE_DELAY_5XX_MS = 1000;
export const INTER_REQUEST_DELAY_MS = 200;

type ResumeState = {
  chunks: Uint8Array[];
  bytesDownloaded: number;
  totalBytes: number;
};

function formatBytesAsMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let rateLimitUntil = 0;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  throwIfCancelled(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForRateLimit(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  if (now < rateLimitUntil) {
    const wait = rateLimitUntil - now;
    console.log(`[Download] Rate limited, waiting ${wait}ms...`);
    await sleep(wait, signal);
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

export async function fetchWithRetry(
  url: string,
  coord: TileCoord,
  onProgress?: (progress: DownloadProgress) => void,
  attempt = 0,
  incompleteRetryCount = 0,
  resumeState?: ResumeState,
  allowZip = false,
  signal?: AbortSignal,
): Promise<ArrayBuffer | null> {
  throwIfCancelled(signal);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  // Relie le signal d'annulation utilisateur au controller du fetch :
  // un abort externe interrompt la requête ET la lecture du flux.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Une fois les en-têtes reçus, le timeout global est levé : un corps qui
  // cesse d'arriver (connexion figée) est détecté par ce minuteur
  // d'inactivité, réarmé à chaque chunk, qui coupe la requête pour la
  // relancer en reprise (Range).
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, READ_IDLE_TIMEOUT_MS);
  };
  const cleanup = () => {
    clearTimeout(timeout);
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onExternalAbort);
  };

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
        onProgress?.({ tileCoord: coord, bytesDownloaded: 0, totalBytes: 0, phase: 'downloading', message: translateAppText('Limite de débit, attente {{seconds}} s...', { seconds: (delay / 1000).toFixed(0) }) });
        cleanup();
        await sleep(delay, signal);
        return fetchWithRetry(url, coord, onProgress, attempt + 1, incompleteRetryCount, resumeState, allowZip, signal);
      }
      const err = new Error(`HTTP 429 after ${MAX_RETRIES} retries`) as any;
      err.status = 429;
      throw err;
    }

    if (response.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_5XX_MS * Math.pow(2, attempt);
        cleanup();
        await sleep(delay, signal);
        return fetchWithRetry(url, coord, onProgress, attempt + 1, incompleteRetryCount, resumeState, allowZip, signal);
      }
      throw new Error(translateAppText('Erreur serveur {{status}} après {{max}} tentatives', { status: response.status, max: MAX_RETRIES }));
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
        cleanup();
        return fetchWithRetry(url, coord, onProgress, attempt, incompleteRetryCount + 1, undefined, allowZip, signal);
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
          ? translateAppText('Reprise du téléchargement {{done}} / {{total}}', { done: formatBytesAsMb(bytesDownloaded), total: formatBytesAsMb(totalBytes) })
          : translateAppText('Reprise du téléchargement {{done}}', { done: formatBytesAsMb(bytesDownloaded) }),
      });
    }

    armIdleTimer();
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (readErr) {
        if (!stalled || signal?.aborted) throw readErr;
        // Flux figé : on garde ce qui a été reçu et on relance en reprise.
        console.warn(`[Download] No data for ${READ_IDLE_TIMEOUT_MS / 1000}s on ${url}; aborting stalled stream`);
        const err = new Error(
          translateAppText('Téléchargement bloqué : aucune donnée reçue depuis {{seconds}} s.', { seconds: READ_IDLE_TIMEOUT_MS / 1000 })
        ) as Error & { code?: string; resumeState?: ResumeState };
        err.code = 'ERR_INCOMPLETE_DOWNLOAD';
        err.resumeState = { chunks, bytesDownloaded, totalBytes };
        throw err;
      }
      const { done, value } = readResult;
      if (done) break;
      armIdleTimer();

      chunks.push(value);
      bytesDownloaded += value.byteLength;

      onProgress?.({
        tileCoord: coord,
        bytesDownloaded,
        totalBytes,
        phase: 'downloading',
        message: totalBytes > 0
          ? translateAppText('Téléchargement {{done}} / {{total}} MB', { done: (bytesDownloaded / 1024 / 1024).toFixed(1), total: (totalBytes / 1024 / 1024).toFixed(1) })
          : translateAppText('Téléchargement {{done}} MB', { done: (bytesDownloaded / 1024 / 1024).toFixed(1) }),
      });
    }

    if (totalBytes > 0 && bytesDownloaded !== totalBytes) {
      cleanup();
      const err = new Error(
        translateAppText('Téléchargement incomplet : {{done}} reçus sur {{total}} attendus.', { done: formatBytesAsMb(bytesDownloaded), total: formatBytesAsMb(totalBytes) })
      ) as Error & { code?: string; resumeState?: ResumeState };
      err.code = 'ERR_INCOMPLETE_DOWNLOAD';
      err.resumeState = {
        chunks,
        bytesDownloaded,
        totalBytes,
      };
      throw err;
    }

    cleanup();
    const merged = mergeChunks(chunks);
    const isValid = hasValidLasSignature(merged) || (allowZip && hasValidZipSignature(merged));
    if (!isValid) {
      if (requestedResumeBytes > 0 && incompleteRetryCount < MAX_INCOMPLETE_DOWNLOAD_RETRIES) {
        const delay = Math.max(1500, RETRY_BASE_DELAY_5XX_MS * Math.pow(2, incompleteRetryCount));
        console.warn(
          `[Download] Resumed buffer for ${url} has invalid signature; restarting full download in ${delay}ms (${incompleteRetryCount + 1}/${MAX_INCOMPLETE_DOWNLOAD_RETRIES})`,
        );
        await sleep(delay, signal);
        return fetchWithRetry(url, coord, onProgress, attempt, incompleteRetryCount + 1, undefined, allowZip, signal);
      }
      throw invalidLasSignatureError(merged);
    }

    return merged;
  } catch (err: any) {
    cleanup();

    if (signal?.aborted) {
      throw new DownloadCancelledError();
    }

    if (err.name === 'AbortError') {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_5XX_MS * Math.pow(2, attempt);
        await sleep(delay, signal);
        return fetchWithRetry(url, coord, onProgress, attempt + 1, incompleteRetryCount, resumeState, allowZip, signal);
      }
      throw new Error(translateAppText('Download timeout after retries'));
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
            ? translateAppText('Téléchargement interrompu, reprise {{attempt}}/{{max}}...', { attempt: incompleteRetryCount + 2, max: MAX_INCOMPLETE_DOWNLOAD_RETRIES + 1 })
            : translateAppText('Téléchargement interrompu, nouvelle tentative {{attempt}}/{{max}}...', { attempt: incompleteRetryCount + 2, max: MAX_INCOMPLETE_DOWNLOAD_RETRIES + 1 }),
        });
        await sleep(delay, signal);
        return fetchWithRetry(url, coord, onProgress, attempt, incompleteRetryCount + 1, nextResumeState, allowZip, signal);
      }
    }

    throw err;
  }
}
