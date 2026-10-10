// ---------------------------------------------------------------------------
// Seaux de limitation de débit des routes /api (par IP, fenêtre d'une minute),
// choisis d'après la route RÉSOLUE (`resolveApiRoute`) : un chemin détourné ne
// peut pas atteindre `auth/*` en passant par le quota général. Utilisé par
// server.mjs (le plugin de dev ne limite pas).
// ---------------------------------------------------------------------------

export const API_RATE_LIMITS = Object.freeze({
  auth: 15,
  general: 120,
  // Tuiles/méta météo du VPS (/api/weather/*) : un balayage de 24 h × 5 couches
  // avec préchargement fait ~145 requêtes ; seau dédié pour ne pas épuiser
  // celui du reste.
  weather: 600,
  // Proxy LiDAR (/api/pointcloud) : un fichier par dalle (Pays-Bas) ou par
  // morceau de bande (Flandre, ≤ 10 par cellule), plus les reprises Range.
  pointcloud: 120,
  // Actions de facturation (POST /api/billing/*) : chaque souscription crée des
  // objets chez Stripe ; un parcours complet en fait moins de 10. Les lectures
  // (GET overview) restent sur le quota général.
  billing: 30,
  // Webhook Stripe : Stripe livre en rafales depuis quelques IP (horloges de
  // test, relivraisons) ; un 429 retarderait les e-mails d'abonnement.
  'stripe-webhook': 600,
  // Neige (/api/snow-context, /api/meteofrance) : un passage du mode neige fait
  // un appel de chaque. Chaque lieu nouveau coûte des lectures de fichiers
  // départementaux (CPU) et un appel sur la clé Météo-France partagée (A11-1, A5-1).
  snow: 20,
  // Routage (/api/brouter, /api/poi) : un recalcul de 1 200 km fait jusqu'à
  // ~30 requêtes BRouter (tronçons fins tous les 160 km, secours, repli à
  // ancres serrées), plus les corridors POI ; des glisser-déposer enchaînés ou
  // un club derrière une même IP (NAT) atteignaient le quota général partagé
  // avec tout le reste (A4-1). BRouter garde sa file bornée (503) comme
  // protection de capacité.
  routing: 300,
});

/**
 * Seau et plafond d'une requête /api.
 * @param {{ route: string, isAuth: boolean } | null} apiRoute
 * @param {string | undefined} method
 * @returns {[keyof typeof API_RATE_LIMITS, number]}
 */
export function apiRateBucket(apiRoute, method) {
  const route = apiRoute?.route ?? '';
  /** @type {keyof typeof API_RATE_LIMITS} */
  let bucket = 'general';
  if (apiRoute?.isAuth) bucket = 'auth';
  else if (route === 'weather') bucket = 'weather';
  else if (route === 'pointcloud') bucket = 'pointcloud';
  else if (method !== 'GET' && route.startsWith('billing/')) bucket = 'billing';
  else if (route === 'stripe/webhook') bucket = 'stripe-webhook';
  else if (route === 'snow-context' || route === 'meteofrance') bucket = 'snow';
  else if (route === 'brouter' || route === 'poi') bucket = 'routing';
  return [bucket, API_RATE_LIMITS[bucket]];
}
