// Prévisions Open-Meteo de l'app : toujours le proxy same-origin
// `/api/openmeteo/v1/forecast` (api/openmeteo.ts) vers l'Open-Meteo
// auto-hébergé sur le VPS — jamais l'API publique (usage non commercial).
//
// Le VPS sert les modèles Météo-France (AROME France 0,025° puis ARPEGE
// Europe 0,1°, fusionnés par `meteofrance_seamless`) : France et pays
// limitrophes, jusqu'à J+4.

export const OPENMETEO_FORECAST_URL = '/api/openmeteo/v1/forecast';

/** Modèle demandé partout : AROME là où il existe (51 h), ARPEGE au-delà. */
export const OPENMETEO_MODEL = 'meteofrance_seamless';

/** Horizon servi par le VPS (ARPEGE Europe) : aujourd'hui + 3 jours. */
export const OPENMETEO_FORECAST_DAYS = 4;
