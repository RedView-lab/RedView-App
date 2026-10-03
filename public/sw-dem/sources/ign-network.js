// ---------------------------------------------------------------------------
// IGN network layer — AbortController registry (per purpose), fetch init,
// WMS rate limiting (40 req/s quota) and retry of the flaky geopf backends.
// ---------------------------------------------------------------------------

// In-flight AbortController registry. Every IGN sub-tile fetch (MNS,
// HIGHRES, terrain WMS) registers its controller here for the duration
// of the network request. `cancelInFlightIGN()` aborts them all with
// USER_CANCEL_REASON; the per-fetch catch handlers then check the
// signal reason and skip negative-cache writes (otherwise tiles we
// just killed would be blacklisted for IGN_NULL_TTL_TRANSIENT and the
// re-request issued ~50 ms later for the new viewport would return
// null without ever hitting the network).
const ignActiveControllers = new Set();
// Per-purpose controller registry — populated alongside ignActiveControllers
// when ignFetchInit is called with { purpose }. Only used by
// cancelInFlightIGNByPurpose, which aborts a narrow tag without touching the
// global set (basemap fetches keep running).
const ignActiveControllersByPurpose = new Map();

function ignFetchInit(extra) {
  const purpose = extra && typeof extra === 'object' ? extra.purpose || null : null;
  const mapTile = extra && typeof extra === 'object' ? extra.mapTile || null : null;
  const priority = isIGNBackgroundPurpose(purpose) ? 'low' : 'high';
  // Strip the SW-internal `purpose` / `mapTile` fields before forwarding to
  // fetch init — they aren't valid RequestInit options and would be ignored,
  // but keeping them out of the spread avoids future linter/typing surprises.
  const fetchExtra = (extra && typeof extra === 'object')
    ? Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'purpose' && k !== 'mapTile'))
    : (extra || {});
  const controller = new AbortController();
  controller._purpose = purpose;
  controller._mapTile = mapTile;
  const timeout = setTimeout(() => {
    try { controller.abort('rv-ign-timeout'); } catch { /* ignore */ }
  }, IGN_FETCH_TIMEOUT_MS);
  ignActiveControllers.add(controller);
  let purposeBucket = null;
  if (purpose) {
    purposeBucket = ignActiveControllersByPurpose.get(purpose);
    if (!purposeBucket) {
      purposeBucket = new Set();
      ignActiveControllersByPurpose.set(purpose, purposeBucket);
    }
    purposeBucket.add(controller);
  }
  const cleanup = () => {
    clearTimeout(timeout);
    ignActiveControllers.delete(controller);
    if (purposeBucket) purposeBucket.delete(controller);
  };
  return {
    controller,
    cleanup,
    init: { signal: controller.signal, priority, ...fetchExtra },
  };
}

// ── Flaky Géoplateforme backends ──────────────────────────────────────
// Measured against data.geopf.fr (2026-10-01):
//   - 13-35 % of LiDAR HD GetMap requests fail with HTTP 400 ServiceException
//     "LayerNotDefined": some nodes behind the load balancer do not know the
//     layer. The very same URL succeeds on the next attempt (40/40 tiles
//     recovered within 3 attempts).
//   - WMS-Raster is rate-limited to 40 requests/s per IP; above it geopf
//     answers 429 and blocks the WMS (only) for 5 s. WMTS has no limit
//     (https://geoservices.ign.fr/documentation/services/limite-d-usage).
// Both used to be cached as a transient miss, so the tile fell back to the
// correlation MNS / AWS 30 m (blank, smooth or flat-looking slope tiles in
// the middle of LiDAR ones). They are retried here instead; any other error
// is returned as-is to the caller's existing handling.
const IGN_RETRY_MAX_ATTEMPTS = 3;
const IGN_RETRY_BACKOFF_MS = 600;
const IGN_WMS_RATE_LIMIT_BLOCK_MS = 5000;
// Stay under the 40 req/s WMS quota (retries included) instead of finding
// it with a 5 s block.
const IGN_WMS_MAX_PER_SECOND = 32;
const ignWmsRecentStarts = [];
// Shared cool-down after a 429 so the other queued WMS requests do not keep
// hammering the quota while it resets.
let ignWmsRateLimitedUntil = 0;

function isIgnWmsUrl(url) {
  return url.startsWith(IGN_WMS_BASE);
}

async function acquireIgnWmsRateSlot(signal) {
  for (;;) {
    const now = Date.now();
    if (ignWmsRateLimitedUntil > now) {
      await ignAbortableDelay(ignWmsRateLimitedUntil - now, signal);
      continue;
    }
    while (ignWmsRecentStarts.length && now - ignWmsRecentStarts[0] >= 1000) ignWmsRecentStarts.shift();
    if (ignWmsRecentStarts.length < IGN_WMS_MAX_PER_SECOND) {
      ignWmsRecentStarts.push(now);
      return;
    }
    await ignAbortableDelay(ignWmsRecentStarts[0] + 1000 - now + 5, signal);
  }
}

function ignAbortableDelay(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 10_000);
  return null;
}

async function fetchIgnWithRetry(url, init) {
  const isWms = isIgnWmsUrl(url);
  let res = null;
  for (let attempt = 0; attempt < IGN_RETRY_MAX_ATTEMPTS; attempt++) {
    if (isWms) await acquireIgnWmsRateSlot(init?.signal);
    res = await fetch(url, init);
    if (res.ok) return res;
    const lastAttempt = attempt + 1 >= IGN_RETRY_MAX_ATTEMPTS;
    if (res.status === 400) {
      // Small XML body: tells a flaky backend from a genuinely bad request.
      let body = '';
      try { body = await res.clone().text(); } catch { /* keep res */ }
      if (!body.includes('LayerNotDefined')) return res;
      continue;
    }
    if (res.status === 429) {
      const block = parseRetryAfterMs(res.headers.get('Retry-After')) ?? IGN_WMS_RATE_LIMIT_BLOCK_MS;
      if (isWms) {
        // The WMS slot acquisition of every request (this retry included)
        // waits the block out.
        ignWmsRateLimitedUntil = Math.max(ignWmsRateLimitedUntil, Date.now() + block + Math.random() * 300);
      } else if (!lastAttempt) {
        await ignAbortableDelay(block, init?.signal);
      }
      continue;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      const backoff = parseRetryAfterMs(res.headers.get('Retry-After'))
        ?? IGN_RETRY_BACKOFF_MS * (attempt + 1) + Math.random() * 400;
      if (!lastAttempt) await ignAbortableDelay(backoff, init?.signal);
      continue;
    }
    return res;
  }
  return res;
}

function isIGNUserCancel(controller) {
  return controller.signal.aborted && controller.signal.reason === USER_CANCEL_REASON;
}
