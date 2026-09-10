/**
 * RedView European Doppler Radar Client
 * Fetches real-time composite radar frames for live precipitation observation (Instant T).
 */

export interface RadarFrame {
  time: number;
  path: string;
}

export interface RadarMapsPayload {
  version: string;
  generated: number;
  host: string;
  radar: {
    past: RadarFrame[];
    nowcast?: RadarFrame[];
  };
}

let cachedRadarMeta: RadarMapsPayload | null = null;
let cachedRadarMetaTime = 0;
let inFlightRadarPromise: Promise<RadarMapsPayload> | null = null;
const RADAR_META_TTL_MS = 90 * 1000; // 90 seconds cache

export function clearRadarMetaCache(): void {
  cachedRadarMeta = null;
  cachedRadarMetaTime = 0;
  inFlightRadarPromise = null;
}

export async function fetchRadarMeta(signal?: AbortSignal): Promise<RadarMapsPayload> {
  const now = Date.now();
  if (cachedRadarMeta && now - cachedRadarMetaTime < RADAR_META_TTL_MS) {
    return cachedRadarMeta;
  }
  if (inFlightRadarPromise) return inFlightRadarPromise;

  inFlightRadarPromise = (async () => {
    try {
      // Primary: Local/Vercel serverless proxy with CORS & caching
      let res = await fetch('/api/weather/radar.json', { signal });
      if (!res.ok) {
        // Fallback: direct public RainViewer endpoint
        res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { signal });
      }
      if (!res.ok) throw new Error(`Radar meta HTTP ${res.status}`);
      const data = (await res.json()) as RadarMapsPayload;
      cachedRadarMeta = data;
      cachedRadarMetaTime = Date.now();
      return data;
    } finally {
      inFlightRadarPromise = null;
    }
  })();

  return inFlightRadarPromise;
}

export function getLatestRadarFrame(meta: RadarMapsPayload | null): RadarFrame | null {
  if (!meta?.radar?.past?.length) return null;
  return meta.radar.past[meta.radar.past.length - 1] ?? null;
}

export interface RadarPaletteBandLike {
  color: string;
  visible?: boolean;
  minValue?: number;
  maxValue?: number;
}

export function formatRadarPaletteParam(
  bands: RadarPaletteBandLike[] | undefined,
  mode = 'gradient',
): string {
  if (!bands || bands.length === 0) return '';
  const bandStrs = bands
    .filter((b) => b.visible !== false)
    .map((b) => {
      const col = b.color.replace('#', '').trim();
      const min = Number.isFinite(b.minValue) ? b.minValue : 0;
      const max = Number.isFinite(b.maxValue) ? b.maxValue : 20;
      return `${col}_${min}_${max}`;
    });
  return `${mode}:${bandStrs.join(':')}`;
}

/**
 * Builds the Mapbox-compatible raster tile URL for the given radar frame path.
 * If the Service Worker is actively controlling the page, routes through
 * /radar-tiles/{z}/{x}/{y} to recolor Doppler radar reflectivity tiles in real time
 * according to the user's custom palette.
 * Otherwise, falls back to the direct upstream RainViewer Slippy CDN URL for zero-latency,
 * rock-solid reliability in any environment (plain HTTP, incognito, non-SW).
 */
export function buildRadarTileUrl(
  host: string,
  framePath: string,
  paletteSig?: string,
  paletteParam?: string,
): string {
  const rawHost = host.replace(/\/+$/, '');
  const rawPath = framePath.startsWith('/') ? framePath : `/${framePath}`;

  // If Service Worker is actively controlling this page, route through the SW recoloring pipeline
  const hasActiveSw = typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller);
  if (hasActiveSw) {
    const cleanHost = encodeURIComponent(rawHost);
    const cleanPath = encodeURIComponent(rawPath);
    const p = paletteParam ? `&p=${encodeURIComponent(paletteParam)}` : '';
    const sig = paletteSig ? `&sig=${encodeURIComponent(paletteSig)}` : '';
    return `/radar-tiles/{z}/{x}/{y}?host=${cleanHost}&path=${cleanPath}${p}${sig}`;
  }

  // Direct CDN fallback: Scheme 2 (Universal Blue Doppler precipitation)
  return `${rawHost}${rawPath}/512/{z}/{x}/{y}/2/1_1.png`;
}

/**
 * Formats a local Date to YYYY-MM-DD.
 */
export function formatLocalDateIso(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Checks whether the timeline date and time corresponds to "Instant T" (live real-time).
 * Defined as: today's date + within +/- 75 minutes of the current local minute.
 */
export function isInstantT(targetDate?: string, targetTime?: string): boolean {
  if (!targetDate || !targetTime) return true;
  const now = new Date();
  const todayIso = formatLocalDateIso(now);
  if (targetDate !== todayIso) return false;

  const [hoursStr, minutesStr] = targetTime.split(':');
  const targetMinutes = Number(hoursStr) * 60 + Number(minutesStr || 0);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return Math.abs(targetMinutes - nowMinutes) <= 75;
}

/**
 * Formats a Unix timestamp (seconds) to local "HH:mm".
 */
export function formatRadarObservationTime(timestampSeconds: number, locale = 'fr-FR'): string {
  if (!timestampSeconds) return '';
  const date = new Date(timestampSeconds * 1000);
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}
