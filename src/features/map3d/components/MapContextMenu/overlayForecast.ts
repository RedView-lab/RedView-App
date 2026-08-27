import { OPENMETEO_FORECAST_URL } from '@/features/weather/lib/openMeteoConfig';
import type {
  MapContextMenuOverlayContext,
  MapContextMenuOverlayDetail,
} from './types';

export interface ForecastPointResponse {
  hourly?: {
    temperature_2m?: Array<number | null>;
    relative_humidity_2m?: Array<number | null>;
    apparent_temperature?: Array<number | null>;
    precipitation?: Array<number | null>;
    cloud_cover?: Array<number | null>;
    wind_speed_10m?: Array<number | null>;
    wind_direction_10m?: Array<number | null>;
  };
  daily?: {
    sunrise?: string[];
    sunset?: string[];
  };
}

export function formatTemperature(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(Number(value))}°C`;
}

export function formatRain(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  if (Number(value) <= 0) return '0 mm';
  return `${Number(value).toFixed(Number(value) >= 10 ? 0 : 1)} mm`;
}

export function formatHumidity(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(Number(value))}% humidité`;
}

export function formatCloudCover(value: number | null | undefined): string | null {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(Number(value))}% nuages`;
}

export function formatWindDirection(degrees: number): string {
  const headings = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % headings.length;
  return headings[index];
}

export function formatWindLabel(speed: number | null | undefined, direction: number | null | undefined): string | null {
  if (!Number.isFinite(speed)) return null;
  const speedLabel = `${Math.round(Number(speed) * 3.6)} km/h`;
  if (!Number.isFinite(direction)) return speedLabel;
  return `${speedLabel} ${formatWindDirection(Number(direction))}`;
}

export function formatIsoTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /T(\d{2}:\d{2})/.exec(value);
  return match ? match[1] : null;
}

export function buildOverlayForecastUrl(
  lat: number,
  lng: number,
  overlayContext: MapContextMenuOverlayContext,
): string | null {
  const needsWeather = overlayContext.weather.enabled && overlayContext.weather.activeLayers.length > 0;
  const needsWind = overlayContext.wind.enabled && (overlayContext.wind.terrainOverlayEnabled || overlayContext.wind.particlesEnabled);
  const needsSunlight = overlayContext.sunlight.enabled && (overlayContext.sunlight.shadowEnabled || overlayContext.sunlight.sunlightMapEnabled);
  if (!needsWeather && !needsWind && !needsSunlight) return null;

  const date = overlayContext.weather.date || overlayContext.wind.date || overlayContext.sunlight.date;
  const time = overlayContext.weather.time || overlayContext.wind.time || overlayContext.sunlight.time;
  if (!date || !time) return null;

  const url = new URL(OPENMETEO_FORECAST_URL, window.location.origin);
  url.searchParams.set('latitude', lat.toFixed(6));
  url.searchParams.set('longitude', lng.toFixed(6));
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('precipitation_unit', 'mm');
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('cell_selection', 'nearest');
  url.searchParams.set('start_hour', `${date}T${time}`);
  url.searchParams.set('end_hour', `${date}T${time}`);

  const hourlyFields = new Set<string>();
  if (needsWeather) {
    hourlyFields.add('temperature_2m');
    hourlyFields.add('relative_humidity_2m');
    hourlyFields.add('apparent_temperature');
    hourlyFields.add('precipitation');
    hourlyFields.add('cloud_cover');
  }
  if (needsWind) {
    hourlyFields.add('wind_speed_10m');
    hourlyFields.add('wind_direction_10m');
  }
  if (hourlyFields.size > 0) {
    url.searchParams.set('hourly', [...hourlyFields].join(','));
  }
  if (needsSunlight) {
    url.searchParams.set('daily', 'sunrise,sunset');
    url.searchParams.set('forecast_days', '1');
  }

  return url.toString();
}

/**
 * Récupère les détails météo/soleil/vent pour le point cliqué selon les overlays actifs.
 */
export async function fetchOverlayDetails(
  lat: number,
  lng: number,
  overlayContext: MapContextMenuOverlayContext,
  signal: AbortSignal,
): Promise<MapContextMenuOverlayDetail[]> {
  const url = buildOverlayForecastUrl(lat, lng, overlayContext);
  if (!url) return [];

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Overlay point forecast failed with ${response.status}`);
  }

  const payload = (await response.json()) as ForecastPointResponse;
  const details: MapContextMenuOverlayDetail[] = [];

  if (overlayContext.sunlight.enabled && (overlayContext.sunlight.shadowEnabled || overlayContext.sunlight.sunlightMapEnabled)) {
    const sunrise = formatIsoTime(payload.daily?.sunrise?.[0]);
    const sunset = formatIsoTime(payload.daily?.sunset?.[0]);
    if (sunrise || sunset) {
      details.push({
        id: 'sunlight',
        kind: 'sunlight',
        icon: 'sun',
        label: [sunrise ? `Lever ${sunrise}` : null, sunset ? `Coucher ${sunset}` : null].filter(Boolean).join('  '),
      });
    }
  }

  if (overlayContext.weather.enabled && overlayContext.weather.activeLayers.length > 0) {
    const weatherLabel = overlayContext.weather.activeLayers
      .map((layer) => {
        switch (layer) {
          case 'temperature':
            return formatTemperature(payload.hourly?.temperature_2m?.[0]);
          case 'feelsLike':
            return payload.hourly?.apparent_temperature?.[0] == null
              ? null
              : `Ressenti ${formatTemperature(payload.hourly.apparent_temperature[0])}`;
          case 'rain':
            return formatRain(payload.hourly?.precipitation?.[0]);
          case 'cloudCover':
            return formatCloudCover(payload.hourly?.cloud_cover?.[0]);
          case 'humidity':
            return formatHumidity(payload.hourly?.relative_humidity_2m?.[0]);
          default:
            return null;
        }
      })
      .filter((value): value is string => Boolean(value))
      .slice(0, 2)
      .join('  ');

    if (weatherLabel) {
      details.push({
        id: 'weather',
        kind: 'weather',
        icon: 'thermometer',
        label: weatherLabel,
      });
    }
  }

  if (overlayContext.wind.enabled && (overlayContext.wind.terrainOverlayEnabled || overlayContext.wind.particlesEnabled)) {
    const windLabel = formatWindLabel(
      payload.hourly?.wind_speed_10m?.[0],
      payload.hourly?.wind_direction_10m?.[0],
    );
    if (windLabel) {
      details.push({
        id: 'wind',
        kind: 'wind',
        icon: 'wind',
        label: windLabel,
      });
    }
  }

  return details;
}
