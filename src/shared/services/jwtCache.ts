/**
 * JWT Appwrite réutilisé tant qu'il est frais. Appwrite limite sa création
 * (100 par heure et par utilisateur sur la 1.6, `POST /account/jwts`) : en
 * créer un à chaque reconnexion du temps réel (réseau qui flanche, onglet en
 * arrière-plan, redéploiement) ou à chaque appel d'API finissait par épuiser
 * le quota — plus aucune connexion possible pendant l'heure, tous onglets
 * confondus. Un JWT vit 15 min : il est repris pendant 10 min (il reste
 * valable au moins 5 min pour celui qui le vérifie).
 *
 *  - un par utilisateur de session (changement de compte : nouveau jeton) ;
 *  - demandes simultanées fusionnées (une seule création) ;
 *  - `fresh` : jeton refusé par un serveur (révoqué, horloge) → on en recrée un ;
 *  - un échec n'est pas gardé.
 */

/** Durée de réutilisation (le JWT Appwrite expire après 15 min). */
export const JWT_REUSE_MS = 10 * 60_000;

export interface JwtCache {
  get(options?: { fresh?: boolean }): Promise<string>;
  clear(): void;
}

export function createJwtCache(
  create: () => Promise<string>,
  scope: () => string | null,
  now: () => number = () => Date.now(),
): JwtCache {
  let cached: { jwt: string; scope: string | null; at: number } | null = null;
  let inFlight: { promise: Promise<string>; scope: string | null } | null = null;
  let generation = 0;

  return {
    get({ fresh = false } = {}) {
      const currentScope = scope();
      if (!fresh && cached && cached.scope === currentScope && now() - cached.at < JWT_REUSE_MS) {
        return Promise.resolve(cached.jwt);
      }
      if (!fresh && inFlight && inFlight.scope === currentScope) return inFlight.promise;
      const startedAt = now();
      const startedGeneration = generation;
      const promise = create().then(
        (jwt) => {
          // Pas gardé si la session a changé (ou a été vidée) pendant la création.
          if (startedGeneration === generation && scope() === currentScope) cached = { jwt, scope: currentScope, at: startedAt };
          return jwt;
        },
      ).finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
      inFlight = { promise, scope: currentScope };
      return promise;
    },
    clear() {
      generation += 1;
      cached = null;
      inFlight = null;
    },
  };
}
