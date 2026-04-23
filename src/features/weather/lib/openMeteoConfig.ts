// Centralised Open-Meteo endpoints.
//
// By default the app calls the Vercel serverless proxy at
// `/api/openmeteo/v1/...`, which forwards to the self-hosted droplet
// (`OPENMETEO_UPSTREAM` env var on Vercel — an http://<ip>:8080 URL).
//
// You can override the URLs with Vite env vars if you want to bypass
// the proxy (e.g. point straight to a public endpoint in local dev):
//   VITE_OPENMETEO_FORECAST_URL=https://api.open-meteo.com/v1/forecast
//   VITE_OPENMETEO_CLIMATE_URL=https://climate-api.open-meteo.com/v1/climate

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const OPENMETEO_FORECAST_URL: string =
  env.VITE_OPENMETEO_FORECAST_URL?.trim() || '/api/openmeteo/v1/forecast';

export const OPENMETEO_CLIMATE_URL: string =
  env.VITE_OPENMETEO_CLIMATE_URL?.trim() || '/api/openmeteo/v1/climate';
