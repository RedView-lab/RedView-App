/**
 * Client du radar de précipitations européen de RedView : composites EUMETNET
 * OPERA (CC BY 4.0), une image toutes les 5 minutes, listés par
 * /api/weather/radar.json et dessinés par le serveur (server/lib/opera-radar.mjs)
 * pour l'observation des précipitations en direct (instant T).
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
const RADAR_META_TTL_MS = 90 * 1000;

export async function fetchRadarMeta(signal?: AbortSignal): Promise<RadarMapsPayload> {
  const now = Date.now();
  if (cachedRadarMeta && now - cachedRadarMetaTime < RADAR_META_TTL_MS) {
    return cachedRadarMeta;
  }
  if (!inFlightRadarPromise) {
    const fetchController = new AbortController();
    const timeout = window.setTimeout(() => fetchController.abort(), 10_000);

    inFlightRadarPromise = (async () => {
      try {
        // Liste servie par l'API (api/weather.ts), gardée 1 min côté serveur.
        const res = await fetch('/api/weather/radar.json', { signal: fetchController.signal });
        window.clearTimeout(timeout);
        if (!res.ok) throw new Error(`Radar meta HTTP ${res.status}`);
        const data = (await res.json()) as RadarMapsPayload;
        cachedRadarMeta = data;
        cachedRadarMetaTime = Date.now();
        return data;
      } catch (err) {
        window.clearTimeout(timeout);
        if (cachedRadarMeta) return cachedRadarMeta;
        throw err;
      } finally {
        inFlightRadarPromise = null;
      }
    })();
  }

  if (signal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Promise<RadarMapsPayload>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      inFlightRadarPromise!.then(
        (data) => {
          signal.removeEventListener('abort', onAbort);
          resolve(data);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

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
 * Construit l'URL de tuile raster compatible Mapbox pour l'image radar donnée :
 * /radar-tiles/{z}/{x}/{y}, fabriquée par le serveur aux couleurs de la palette
 * de l'utilisateur (le Service Worker la lui relaie).
 */
export function buildRadarTileUrl(
  host: string,
  framePath: string,
  paletteSig?: string,
  paletteParam?: string,
): string {
  const cleanHost = encodeURIComponent(host.replace(/\/+$/, ''));
  const cleanPath = encodeURIComponent(framePath.startsWith('/') ? framePath : `/${framePath}`);
  const p = paletteParam ? `&p=${encodeURIComponent(paletteParam)}` : '';
  const sig = paletteSig ? `&sig=${encodeURIComponent(paletteSig)}` : '';
  return `/radar-tiles/{z}/{x}/{y}?host=${cleanHost}&path=${cleanPath}${p}${sig}`;
}

/**
 * Formate une Date locale en AAAA-MM-JJ.
 */
function formatLocalDateIso(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Vérifie si la date et l'heure de la frise correspondent à l'« instant T »
 * (temps réel). Défini comme : la date du jour + à ±75 minutes de la minute
 * locale actuelle.
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
