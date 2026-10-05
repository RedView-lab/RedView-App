import type { GpxQualityPreset, Itinerary, RouteDisplayQuality } from '../../types';
import { applyGpxQuality, computeGpxQualityTargetPointCount } from '../routes/simplify-route';
import type { RouteLayerPoint } from './routeStyle';

/** État de la carte qui décide de la finesse en mode `auto`. */
export interface RouteDisplayContext {
  /** Carte inclinée (bouton 3D), pas vue de dessus. */
  threeD: boolean;
  /** Relief HD (1 m sol nu, 0,40 m surface) plutôt que 30 m. */
  hdTerrain: boolean;
}

const PRESETS: ReadonlySet<string> = new Set<GpxQualityPreset>(['default', 'balanced', 'max']);

/**
 * Préréglage effectif. `auto` (et toute valeur inconnue, un fichier
 * `.redview` venant d'un tiers) : maximum seulement en 3D sur le relief HD,
 * où une trace simplifiée coupe visiblement les lacets ; rapide sinon.
 */
export function resolveRouteDisplayPreset(
  quality: RouteDisplayQuality | string | null | undefined,
  context: RouteDisplayContext,
): GpxQualityPreset {
  if (typeof quality === 'string' && PRESETS.has(quality)) return quality as GpxQualityPreset;
  return context.threeD && context.hdTerrain ? 'max' : 'default';
}

/**
 * Points dessinés pour une trace. Jamais moins fins que le tracé de travail
 * (`points`, celui des calculs et des marqueurs) : seule une trace dont le
 * tracé d'origine est plus détaillé (GPX importé, simplifié à l'import) est
 * redessinée depuis `originalPoints` quand le préréglage en demande plus. Un
 * tracé calculé (BRouter) est déjà en pleine résolution : dessiné tel quel.
 */
export function resolveRouteDisplayPoints(
  route: NonNullable<Itinerary['gpxRoute']>,
  preset: GpxQualityPreset,
): RouteLayerPoint[] {
  const { points, originalPoints } = route;
  if (!originalPoints || originalPoints.length <= points.length) return points;
  if (computeGpxQualityTargetPointCount(originalPoints, preset) <= points.length) return points;
  return applyGpxQuality(originalPoints, preset).points;
}
