/**
 * Open-Meteo auto-hébergé sur le VPS (server/vps/open-meteo) : seule source
 * des prévisions et de l'historique météo — jamais l'API publique
 * api.open-meteo.com, réservée à l'usage non commercial.
 *
 * Données servies : modèles Météo-France AROME France 0,025° (51 h) et
 * ARPEGE Europe 0,1° (4 jours), fusionnés par `meteofrance_seamless`, sur
 * 3 jours passés ; ARPEGE garde 62 jours de température, précipitations,
 * neige et vent pour le modèle de neige (api/snow-context.ts).
 */
import { PublicError } from './errors.js';

/** Modèle demandé quand le client n'en précise pas : AROME là où il existe, ARPEGE ailleurs. */
export const OPENMETEO_DEFAULT_MODEL = 'meteofrance_seamless';

/** Modèles synchronisés sur le VPS (noms de l'API Open-Meteo). */
const SERVED_MODELS = new Set([OPENMETEO_DEFAULT_MODEL, 'meteofrance_arome_france', 'meteofrance_arpege_europe']);

/**
 * Noms qu'envoyaient les versions précédentes de l'app : `best_match` (modèle
 * par défaut de l'API publique) et AROME HD (0,01°, trop lourd pour le VPS).
 * Un onglet resté ouvert pendant un déploiement les envoie encore.
 */
const LEGACY_MODELS = new Set(['best_match', 'meteofrance_arome_france_hd']);

/** Horizon des prévisions servies (ARPEGE Europe : 4 jours). */
export const OPENMETEO_MAX_FORECAST_DAYS = 4;
/** Jours passés gardés pour toutes les variables (synchros AROME et ARPEGE). */
export const OPENMETEO_MAX_PAST_DAYS = 3;
/** Jours passés gardés pour l'historique du modèle de neige (synchro ARPEGE 62 jours). */
export const OPENMETEO_MAX_HISTORY_DAYS = 60;
/** Points par requête : un lot de la couche météo (FORECAST_BATCH_SIZE). */
export const OPENMETEO_MAX_LOCATIONS = 200;

/** URL de l'Open-Meteo du VPS (variable OPENMETEO_UPSTREAM), sans « / » final. */
export function openMeteoUpstream(): string {
  const upstream = (process.env.OPENMETEO_UPSTREAM ?? '').trim().replace(/\/+$/, '');
  if (!upstream) throw new PublicError('Weather service not configured', 503);
  return upstream;
}

/** Modèle à demander au VPS pour la valeur `models` reçue d'un client ; refus si le VPS ne le sert pas. */
export function resolveOpenMeteoModel(requested: string | null): string {
  const model = requested?.trim();
  if (!model || LEGACY_MODELS.has(model)) return OPENMETEO_DEFAULT_MODEL;
  if (SERVED_MODELS.has(model)) return model;
  throw new PublicError(`Unsupported weather model: ${model.slice(0, 64)}`, 400);
}
