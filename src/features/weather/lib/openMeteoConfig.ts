// Centralised Open-Meteo endpoints.
//
// By default the app calls the Vercel serverless proxy at
// `/api/openmeteo/v1/...`, which forwards to the self-hosted droplet
// (`OPENMETEO_UPSTREAM` env var on Vercel — an http://<ip>:8080 URL).
//
// You can override the URLs with Vite env vars if you want to point to
// another self-hosted endpoint, but public Open-Meteo hosts are refused
// so the app never bypasses the VPS/proxy path.

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

function isForbiddenPublicEndpoint(url: string): boolean {
  return /(^|\.)api\.open-meteo\.com(?=[:/]|$)/i.test(url)
    || /(^|\.)climate-api\.open-meteo\.com(?=[:/]|$)/i.test(url);
}

function resolveWeatherEndpoint(override: string | undefined, fallback: string): string {
  const trimmed = override?.trim();
  if (!trimmed) return fallback;
  if (isForbiddenPublicEndpoint(trimmed)) {
    if (typeof window !== 'undefined') {
      console.warn(`[weather] refused public Open-Meteo override: ${trimmed}. Falling back to ${fallback}.`);
    }
    return fallback;
  }
  return trimmed;
}

export const OPENMETEO_FORECAST_URL: string =
  resolveWeatherEndpoint(env.VITE_OPENMETEO_FORECAST_URL, '/api/openmeteo/v1/forecast');

export const OPENMETEO_CLIMATE_URL: string =
  resolveWeatherEndpoint(env.VITE_OPENMETEO_CLIMATE_URL, '/api/openmeteo/v1/climate');

// Log once at module load so we can confirm in DevTools that we're
// hitting the self-hosted VPS (via the Vercel proxy) and not a
// forbidden public Open-Meteo endpoint.
if (typeof window !== 'undefined') {
  const isProxy = OPENMETEO_FORECAST_URL.startsWith('/api/openmeteo');
  const tag = isProxy
    ? '\u2705 self-hosted VPS (via /api/openmeteo proxy)'
    : '\uD83D\uDD17 custom override';
  console.log(
    `[weather] forecast endpoint: ${OPENMETEO_FORECAST_URL} — ${tag}`,
  );
  console.log(`[weather] climate  endpoint: ${OPENMETEO_CLIMATE_URL}`);
}
