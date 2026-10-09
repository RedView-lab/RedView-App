/**
 * Refus de la mesure d'audience (Réglages → Mesure d'audience), recommandé par
 * la CNIL même pour une mesure exemptée de consentement. Une seule clé, celle
 * que le tracker Umami relit avant chaque envoi : posée, plus rien ne part —
 * ni le script (loader.ts), ni les événements en attente (core.ts), ni ceux
 * d'un tracker déjà chargé. Gardée à la déconnexion (ce n'est pas une clé
 * `redview:` propre au compte) : c'est un choix de l'appareil.
 */

const ANALYTICS_OPT_OUT_KEY = 'umami.disabled';

export function isAnalyticsOptedOut(): boolean {
  try {
    return localStorage.getItem(ANALYTICS_OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Enregistre le choix ; un refus est immédiat, une réactivation vaut à partir du prochain chargement de page. */
export function setAnalyticsOptOut(optOut: boolean): void {
  try {
    if (optOut) localStorage.setItem(ANALYTICS_OPT_OUT_KEY, '1');
    else localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
  } catch {
    // Stockage indisponible : le choix ne survit pas au rechargement.
  }
}
