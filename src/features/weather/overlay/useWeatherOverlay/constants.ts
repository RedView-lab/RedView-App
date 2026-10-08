import type { WeatherOverlayMetric } from '../types';

const SOURCE_PREFIX = 'weather-overlay-source';
const LAYER_PREFIX = 'weather-overlay-layer';
export const SUPPORTED_KEYS: WeatherOverlayMetric[] = ['temperature', 'feelsLike', 'rain', 'cloudCover', 'humidity'];
export const MOVE_DEBOUNCE_MS = 220;
export const SCRUB_DEBOUNCE_MS = 60;
// Délais de rattrapage de la synchronisation du style.
//
// Contexte : `map.isStyleLoaded()` peut rester faux étonnamment longtemps sous
// un fort renouvellement des tuiles DEM / pente / altitude (chaque événement
// styledata remet le drapeau interne à faux). L'ancien garde-fou de 15 s
// faisait que l'utilisateur pouvait voir « Météo · Synchronisation du style
// 75 % » jusqu'à un quart de minute avant que le chemin de repli ne prenne le
// relais — impression de blocage.
//
// Nouvelle stratégie :
//   * `canMutateStyle()` (dans hook.ts) bascule directement sur le repli fondé
//     sur le nombre de sources chaque fois que le strict `isStyleLoaded()`
//     renvoie faux alors que le style et les sources existent bel et bien.
//     L'attente disparaît entièrement dans le cas courant.
//   * Le minuteur de garde ci-dessous n'est plus qu'un filet de sécurité bien
//     plus court pour le cas vraiment dégénéré (en plein changement de style,
//     style totalement vide).
//   * Intervalle de nouvel essai relâché de 96 ms (avalanche de statuts) à
//     250 ms — toujours quasi instantané pour l'utilisateur, avec dix fois
//     moins de minuteurs.
export const STYLE_SYNC_RETRY_MS = 250;
export const STYLE_SYNC_WATCHDOG_MS = 1_500;
export const STYLE_SYNC_POLL_MS = 600;
export const STYLE_SYNC_MAX_POLLS = 20;
export const STATUS_ID = 'weather';

export type RefreshReason = 'normal' | 'force' | 'reload';

export const RADAR_SOURCE_ID = 'weather-overlay-source-rain-radar';
export const RADAR_LAYER_ID = 'weather-overlay-layer-rain-radar';

export function sourceId(key: WeatherOverlayMetric): string {
  return `${SOURCE_PREFIX}-${key}`;
}

export function layerId(key: WeatherOverlayMetric): string {
  return `${LAYER_PREFIX}-${key}`;
}