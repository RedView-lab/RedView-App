/**
 * Constructeurs d'URL du client HTTP BRouter.
 *
 * Chaque appel passe par le proxy de même origine (`api/brouter.ts`) : il met
 * les paramètres en liste blanche, borne le coefficient A* et dérive l'id du
 * profil envoyé de son contenu. Le VPS répond 403 à tout le reste.
 */
import {
  DEFAULT_PROFILE,
  type BrouterPoint,
  type BrouterRequest,
} from '../types';
import { sanitizeOverrides } from '../profiles/param-encoding';
import { observedCostScale, resolveSearchCoefficient } from './searchCoefficient';

const BROUTER_PROXY_URL = '/api/brouter';

function formatLonlats(points: BrouterPoint[]): string {
  return points
    .map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`)
    .join('|');
}

/** Construit l'URL de routage — utile pour les tests/le journal. */
export function buildBrouterUrl(req: BrouterRequest): string {
  const points: BrouterPoint[] = [req.start, ...(req.via ?? []), req.end];
  const params = new URLSearchParams({
    lonlats: formatLonlats(points),
    profile: req.profile ?? DEFAULT_PROFILE,
    alternativeidx: String(req.alternativeIdx ?? 0),
    format: 'geojson',
  });
  if (req.polygons) params.set('polygons', req.polygons);
  if (req.nogos) params.set('nogos', req.nogos);
  if (req.overrides) {
    const safe = sanitizeOverrides(req.overrides);
    for (const [key, value] of Object.entries(safe)) {
      // Dernier garde-fou : chaque clé de surcharge doit être préfixée par « profile: ».
      // `sanitizeOverrides` a déjà encodé la valeur et écarté les clés inconnues /
      // vides : seul le préfixe reste à poser ici.
      const k = key.startsWith('profile:') ? key : `profile:${key}`;
      params.set(k, value);
    }
  }

  // Passe unique (pass2coefficient = -1) ; coefficient A* adapté à la distance
  // et à l'échelle de coût du profil (le proxy le borne).
  params.set('profile:pass2coefficient', '-1');
  params.set('profile:pass1coefficient', String(resolveSearchCoefficient(
    points,
    observedCostScale(req.profile) ?? req.searchCostScale,
    req.searchWeight,
  )));

  return `${BROUTER_PROXY_URL}?${params.toString()}`;
}

/** Point d'accès du POST d'envoi de profil (le proxy dérive l'id du profil). */
export function buildProfileUploadUrl(): string {
  return BROUTER_PROXY_URL;
}
