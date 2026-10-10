// ---------------------------------------------------------------------------
// Journal des requêtes du serveur de prod (pino-http) : une ligne JSON par
// requête sur stdout (logs du conteneur Coolify), avec méthode, route
// normalisée, statut, durée, X-Request-ID et identifiant de build.
//
// Jamais l'URL brute, la query ni les en-têtes : les paramètres portent des
// secrets (lien de réinitialisation `?userId&secret`, jetons) et des positions.
// La route est normalisée (cardinalité bornée, aucune valeur fournie par le
// client). Health checks réussis : silencieux ; assets statiques : debug.
// Niveau : LOG_LEVEL (défaut info).
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';

import { resolveBuildId } from './build-id.mjs';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const HEALTH_PATHS = new Set(['/health', '/healthz', '/api/health']);
const API_PREFIX_ALIASES = new Set(['openmeteo', 'weather', 'brouter']);
const TILE_ROUTE_RE = /^\/(radar|slope|altitude|dem|vhr|contour)-tiles\//;

/** X-Request-ID entrant s'il est sûr à journaliser et renvoyer, sinon un UUID. */
export function resolveRequestId(header) {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/**
 * Route normalisée d'une requête.
 * @param {string | null} pathname  pathname décodé (`decodeSafePathname`), null s'il est invalide
 * @param {string | null} [apiRoute]  route API résolue (`resolveApiRoute(...).route`)
 */
export function normalizeRoutePath(pathname, apiRoute = null) {
  if (pathname == null) return '/:invalid';
  if (HEALTH_PATHS.has(pathname)) return pathname;
  if (pathname.startsWith('/api/')) {
    if (!apiRoute) return '/api/:unmatched';
    return API_PREFIX_ALIASES.has(apiRoute) ? `/api/${apiRoute}/*` : `/api/${apiRoute}`;
  }
  const tile = TILE_ROUTE_RE.exec(pathname);
  if (tile) return `/${tile[1]}-tiles/:z/:x/:y`;
  if (pathname.startsWith('/assets/')) return '/assets/*';
  if (pathname.startsWith('/sw-dem/') || pathname === '/sw-dem.js') return '/sw-dem/*';
  if (pathname.startsWith('/project/')) return '/project/:id';
  if (pathname === '/' || pathname === '/viewer' || pathname === '/viewer.html') return pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return /\.[a-z0-9]+$/i.test(lastSegment) ? '/:file' : '/:page';
}

function routeOf(req) {
  return req.redviewRoute ?? '/:unrouted';
}

/**
 * Mesures que le proxy BRouter pose en en-têtes de réponse (api/brouter.ts),
 * recopiées dans la ligne de la requête : attente dans la file, temps de
 * calcul, distance d'effort, cache, délai dépassé. Seulement ces en-têtes,
 * seulement des nombres ou des mots connus.
 */
const UPSTREAM_NUMBER_HEADERS = [
  ['x-upstream-wait-ms', 'waitMs'],
  ['x-upstream-compute-ms', 'computeMs'],
  ['x-search-km', 'km'],
];
const UPSTREAM_WORD_HEADERS = [
  ['x-route-cache', 'cache', /^HIT$/],
  ['x-brouter-timeout', 'timeout', /^(compute|total)$/],
];

function upstreamOf(res) {
  if (typeof res.getHeader !== 'function') return undefined;
  const upstream = {};
  for (const [header, key] of UPSTREAM_NUMBER_HEADERS) {
    const raw = res.getHeader(header);
    const value = Number(raw);
    if (raw !== undefined && Number.isFinite(value)) upstream[key] = value;
  }
  for (const [header, key, pattern] of UPSTREAM_WORD_HEADERS) {
    const value = res.getHeader(header);
    if (typeof value === 'string' && pattern.test(value)) upstream[key] = value;
  }
  return Object.keys(upstream).length > 0 ? upstream : undefined;
}

function withUpstream(object, res) {
  const upstream = upstreamOf(res);
  return upstream ? { ...object, upstream } : object;
}

const LOAD_SHED = Symbol('redview.loadShed');

/**
 * Marque un 503 comme délestage voulu quand la réponse ne porte pas de
 * Retry-After (le secours BRouter refusé n'invite pas à réessayer) : journalisé
 * en avertissement. Propriété interne, jamais envoyée au client.
 *
 * @param {import('node:http').ServerResponse} res
 */
export function markLoadShed(res) {
  /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (res))[LOAD_SHED] = true;
}

function logLevelFor(req, res, error) {
  const route = routeOf(req);
  if (error) return 'error';
  // 503 de délestage voulu (file BRouter saturée, géocodeur au plafond de
  // Nominatim : Retry-After ; secours BRouter sans place : markLoadShed) — un
  // avertissement, pas une panne : ces refus arrivent par rafales sous charge
  // et noyaient les vraies erreurs.
  if (res.statusCode === 503 && (res.getHeader('retry-after') != null || res[LOAD_SHED] === true)) return 'warn';
  if (res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  if (HEALTH_PATHS.has(route)) return 'silent';
  if (route === '/assets/*' || route === '/sw-dem/*' || route === '/:file') return 'debug';
  return 'info';
}

/**
 * Middleware pino-http : pose `req.id` (X-Request-ID, renvoyé en en-tête) et
 * `req.log`, puis journalise la requête à la fin de la réponse. Le serveur
 * renseigne `req.redviewRoute` (normalizeRoutePath) pendant le traitement.
 *
 * @param {{ level?: string, destination?: import('pino').DestinationStream }} [options]
 *   `destination` : flux de sortie (tests), stdout par défaut.
 */
export function createRequestLogger({ level = process.env.LOG_LEVEL || 'info', destination } = {}) {
  const logger = pino(
    {
      level,
      base: { service: 'redview-app', buildId: resolveBuildId() },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Filet de sécurité : les sérialiseurs ci-dessous n'émettent déjà aucun en-tête.
      redact: { paths: ['req.headers', 'res.headers'], remove: true },
    },
    destination,
  );
  return pinoHttp({
    logger,
    quietReqLogger: true,
    wrapSerializers: false,
    genReqId(req, res) {
      const id = resolveRequestId(req.headers['x-request-id']);
      res.setHeader('X-Request-ID', id);
      return id;
    },
    customLogLevel: logLevelFor,
    // `req` est sérialisé dès l'arrivée de la requête (bindings du logger
    // enfant) : seule la méthode y figure. La route, connue une fois la
    // requête routée, est ajoutée à la fin de la réponse.
    serializers: {
      req: (req) => ({ method: req.method }),
      res: (res) => ({ statusCode: res.statusCode }),
      err: pino.stdSerializers.err,
    },
    customSuccessObject: (req, res, value) => withUpstream({ ...value, route: routeOf(req) }, res),
    customErrorObject: (req, res, error, value) => {
      // Un 5xx sans exception : pino-http fabrique une erreur dont la pile ne
      // montre que ses propres internes. Les vraies erreurs sont journalisées
      // (et envoyées à GlitchTip) par le serveur, avec leur pile.
      const synthetic = !res.err && error?.message === `failed with status code ${res.statusCode}`;
      const { err, ...rest } = value;
      return withUpstream(synthetic ? { ...rest, route: routeOf(req) } : { ...rest, err, route: routeOf(req) }, res);
    },
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
  });
}
