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

/**
 * Builds the Mapbox-compatible Slippy tile URL template for the given radar frame path.
 * Uses color scheme 2 (Universal Blue/Multi-intensity) and smoothing 1_1 for sharp Doppler precipitation.
 */
export function buildRadarTileUrl(host: string, framePath: string): string {
  const cleanHost = host.replace(/\/+$/, '');
  const cleanPath = framePath.startsWith('/') ? framePath : `/${framePath}`;
  return `${cleanHost}${cleanPath}/512/{z}/{x}/{y}/2/1_1.png`;
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
