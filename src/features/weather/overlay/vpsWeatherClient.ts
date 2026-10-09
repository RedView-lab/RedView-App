/**
 * Client météo du VPS RedView
 * Client performant pour les tuiles météo du VPS Oracle (France + pays
 * frontaliers, 48 h). Remplace les requêtes JSON de 2 000 points par lots et
 * les boucles bilinéaires CPU de 2 M de pixels.
 */

import { setForecastHorizonEnd } from '../lib/forecastTime';

/** Au-delà de cet écart, l'heure demandée n'est pas couverte : pas de tuile. */
const MAX_FORECAST_HOUR_GAP_MS = 90 * 60 * 1000;

export interface WeatherMetaBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

interface WeatherMetaVariable {
  unit: string;
  min: number;
  max: number;
}

export interface WeatherMeta {
  updatedAt: string;
  model: string;
  bbox: WeatherMetaBbox;
  resolutionDeg: number;
  gridSize: { width: number; height: number };
  forecastHours: number;
  hours: string[];
  variables: Record<string, WeatherMetaVariable>;
  tileFormat?: string;
}

export type ImageCoords = [[number, number], [number, number], [number, number], [number, number]];

const DEFAULT_WEATHER_BBOX: WeatherMetaBbox = {
  west: -18.0,
  south: 34.0,
  east: 32.0,
  north: 62.0,
};

let cachedMeta: WeatherMeta | null = null;
let cachedMetaTime = 0;
let metaPromise: Promise<WeatherMeta> | null = null;

const META_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearWeatherMetaCache(): void {
  cachedMeta = null;
  cachedMetaTime = 0;
  metaPromise = null;
}

export function getCachedWeatherMeta(): WeatherMeta | null {
  const now = Date.now();
  if (cachedMeta && now - cachedMetaTime < META_CACHE_TTL_MS) {
    return cachedMeta;
  }
  return null;
}

/**
 * Récupération robuste des métadonnées météo.
 * Le AbortSignal transitoire d'un appelant n'interrompt PAS la requête réseau
 * sous-jacente, ce qui évite les AbortError en cascade et les blocages
 * définitifs de la progression à 20 % dans toute l'application.
 */
export async function fetchWeatherMeta(signal?: AbortSignal, force = false): Promise<WeatherMeta> {
  const now = Date.now();
  if (!force && cachedMeta && now - cachedMetaTime < META_CACHE_TTL_MS) {
    return cachedMeta;
  }

  if (!metaPromise || force) {
    const fetchController = new AbortController();
    const timeoutTimer = window.setTimeout(() => fetchController.abort(), 12_000);

    metaPromise = (async () => {
      try {
        const res = await fetch('/api/weather/meta.json', { signal: fetchController.signal });
        window.clearTimeout(timeoutTimer);
        if (!res.ok) throw new Error(`Weather meta HTTP ${res.status}`);
        const data = (await res.json()) as WeatherMeta;
        cachedMeta = data;
        cachedMetaTime = Date.now();
        // Plafonne le curseur de prévision à la dernière heure publiée.
        const lastHour = Array.isArray(data.hours) ? data.hours[data.hours.length - 1] : undefined;
        setForecastHorizonEnd(lastHour ? Date.parse(lastHour) : null);
        return data;
      } catch (err) {
        window.clearTimeout(timeoutTimer);
        if (cachedMeta) {
          // Repli en douceur sur les métadonnées en cache lors de coupures réseau transitoires
          return cachedMeta;
        }
        throw err;
      } finally {
        metaPromise = null;
      }
    })();
  }

  // Si l'appelant a fourni un signal d'annulation, on respecte son annulation sans interrompre la requête de fond
  if (signal) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return new Promise<WeatherMeta>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      metaPromise!.then(
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

  return metaPromise;
}

export function bboxToImageCoords(bbox: WeatherMetaBbox = DEFAULT_WEATHER_BBOX): ImageCoords {
  return [
    [bbox.west, bbox.north],
    [bbox.east, bbox.north],
    [bbox.east, bbox.south],
    [bbox.west, bbox.south],
  ];
}

/**
 * Heure de la méta la plus proche de l'heure locale demandée, ou `''` si
 * aucune n'est à moins de 90 min (heure hors horizon) : l'appelant masque
 * alors le calque au lieu d'afficher une autre heure sous la mauvaise étiquette.
 */
export function findClosestForecastHour(targetDate: string, targetTime: string, availableHours: string[]): string {
  if (!availableHours.length) return '';
  const dateParts = targetDate.split('-').map(Number);
  const timeParts = targetTime.split(':').map(Number);
  const year = dateParts[0] || new Date().getFullYear();
  const month = (dateParts[1] || 1) - 1;
  const day = dateParts[2] || 1;
  const hour = timeParts[0] || 0;
  const minute = timeParts[1] || 0;

  // Date d'horloge locale convertie en horodatage UTC
  const localDate = new Date(year, month, day, hour, minute, 0, 0);
  const targetMs = localDate.getTime();

  if (Number.isNaN(targetMs)) return availableHours[0]!;

  let bestHour = availableHours[0]!;
  let minDiff = Math.abs(new Date(bestHour).getTime() - targetMs);

  for (let i = 1; i < availableHours.length; i++) {
    const h = availableHours[i]!;
    const diff = Math.abs(new Date(h).getTime() - targetMs);
    if (diff < minDiff) {
      minDiff = diff;
      bestHour = h;
    }
  }

  return minDiff <= MAX_FORECAST_HOUR_GAP_MS ? bestHour : '';
}

/**
 * Tuile d'une variable à une heure de validité. Le VPS réécrit le même
 * fichier à chaque run de prévision : `runVersion` (`meta.updatedAt`) fait
 * de chaque run une URL à part, donc les caches (serveur, navigateur, tuiles
 * recolorées) ne servent jamais l'ancien run pour la même heure. Les serveurs
 * de tuiles du VPS ignorent la chaîne de requête.
 */
export function buildVpsTileUrl(variable: string, isoHour: string, tileFormat: string = 'png', runVersion: string = ''): string {
  const url = `/api/weather/tiles/${variable}_${isoHour}.${tileFormat}`;
  return runVersion ? `${url}?v=${encodeURIComponent(runVersion)}` : url;
}

const tileImageCache = new Map<string, HTMLImageElement>();
const inFlightImagePromises = new Map<string, Promise<HTMLImageElement>>();
const MAX_IMAGE_CACHE_SIZE = 128;

/**
 * Chargeur d'images de tuiles résilient.
 * Les appelants concurrents et le préchargement partagent des requêtes
 * identiques sans annulations en cascade (un appelant annulé se détache, mais
 * l'image finit de se télécharger dans tileImageCache pour être disponible tout
 * de suite aux pas de glissement suivants).
 */
export async function loadTileImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const cached = tileImageCache.get(url);
  if (cached) return cached;

  let inFlight = inFlightImagePromises.get(url);
  if (!inFlight) {
    inFlight = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const cleanup = () => {
        inFlightImagePromises.delete(url);
      };

      img.onload = async () => {
        cleanup();
        try {
          await img.decode();
        } catch {
          // onload suffit
        }
        if (tileImageCache.size >= MAX_IMAGE_CACHE_SIZE) {
          const oldestKey = tileImageCache.keys().next().value;
          if (oldestKey) tileImageCache.delete(oldestKey);
        }
        tileImageCache.set(url, img);
        resolve(img);
      };

      img.onerror = () => {
        cleanup();
        reject(new Error(`Failed to load tile image: ${url}`));
      };

      img.src = url;
    });

    inFlightImagePromises.set(url, inFlight);
  }

  if (!signal) return inFlight;

  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    inFlight!.then(
      (img) => {
        signal.removeEventListener('abort', onAbort);
        resolve(img);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

let activePrefetchTimer: number | null = null;

export function cancelPrefetch(): void {
  if (activePrefetchTimer !== null) {
    window.clearTimeout(activePrefetchTimer);
    activePrefetchTimer = null;
  }
}

/**
 * Précharge les heures de prévision voisines sans annuler les chargements de
 * tuiles au premier plan.
 */
export function prefetchAdjacentHours(
  variable: string,
  currentHour: string,
  availableHours: string[],
  tileFormat: string = 'png',
  runVersion: string = '',
  onTileLoaded?: (url: string, img: HTMLImageElement, hour: string) => void,
): void {
  cancelPrefetch();

  const currentIndex = availableHours.indexOf(currentHour);
  if (currentIndex === -1) return;

  const targetIndices = [
    currentIndex + 1,
    currentIndex + 2,
    currentIndex + 3,
    currentIndex - 1,
    currentIndex - 2,
  ];
  const itemsToPrefetch: { url: string; hour: string }[] = [];

  for (const idx of targetIndices) {
    if (idx >= 0 && idx < availableHours.length) {
      const h = availableHours[idx]!;
      const url = buildVpsTileUrl(variable, h, tileFormat, runVersion);
      if (!tileImageCache.has(url) && !inFlightImagePromises.has(url)) {
        itemsToPrefetch.push({ url, hour: h });
      }
    }
  }

  if (itemsToPrefetch.length === 0) return;

  // Anti-rebond de 100 ms sur le préchargement de fond pour qu'un glissement actif de la frise n'ait aucune concurrence réseau
  activePrefetchTimer = window.setTimeout(() => {
    activePrefetchTimer = null;
    for (const item of itemsToPrefetch) {
      loadTileImage(item.url)
        .then((img) => {
          onTileLoaded?.(item.url, img, item.hour);
        })
        .catch(() => {});
    }
  }, 100);
}
