import { translateAppText } from '@/shared/i18n';

/**
 * Normalise et traduit les erreurs BRouter / réseau en messages clairs et
 * conviviaux pour l'utilisateur.
 */
export function formatBrouterErrorMessage(error: unknown): string {
  if (!error) {
    return translateAppText('Impossible de calculer l’itinéraire.');
  }

  const rawMessage =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { detail?: unknown })?.detail === 'string'
          ? String((error as { detail?: string }).detail)
          : String(error);

  const lower = rawMessage.toLowerCase();

  // 1. Zones interdites / Restricted areas
  if (
    lower.includes('last wpt in restricted area') ||
    lower.includes('to-position in restricted area') ||
    lower.includes('last point in restricted area')
  ) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : le point d’arrivée se trouve dans une zone interdite.',
    );
  }

  if (
    lower.includes('first wpt in restricted area') ||
    lower.includes('from-position in restricted area') ||
    lower.includes('first point in restricted area')
  ) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : le point de départ se trouve dans une zone interdite.',
    );
  }

  const viaMatch = lower.match(/(?:wpt|via)\s*(\d+)\s*in\s*restricted\s*area/);
  if (viaMatch || lower.includes('via-position in restricted area')) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : un point de passage se trouve dans une zone interdite.',
    );
  }

  if (lower.includes('restricted area') || lower.includes('zone interdite')) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : un point se trouve dans une zone interdite.',
    );
  }

  // 2. Points hors carte / non mappés dans les données BRouter
  if (lower.includes('from-position not mapped')) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : le point de départ est hors de la zone couverte ou inaccessible.',
    );
  }

  if (lower.includes('to-position not mapped')) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : le point d’arrivée est hors de la zone couverte ou inaccessible.',
    );
  }

  if (
    lower.includes('position not mapped') ||
    lower.includes('not mapped in existing datafile')
  ) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : un point est hors de la zone couverte ou inaccessible.',
    );
  }

  // 3. Aucun tracé trouvé
  if (
    lower.includes('no track found') ||
    lower.includes('no route found') ||
    lower.includes('cannot find route') ||
    lower.includes('target not reachable') ||
    lower.includes('no path found') ||
    lower.includes('aucune trace renvoyée')
  ) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : aucun tracé praticable trouvé entre ces points.',
    );
  }

  // 4. Timeout / Watchdog
  if (
    lower.includes('thread-priority-watchdog') ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return translateAppText(
      'Le calcul de l’itinéraire a pris trop de temps. Déplacez vos points ou simplifiez le tracé.',
    );
  }

  // 5. Zone géographique / France bounds
  if (
    lower.includes('france métropolitaine') ||
    lower.includes('hors zone autorisée')
  ) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : les points doivent être situés en France métropolitaine ou en Corse.',
    );
  }

  // 6. Serveur / Réseau
  if (
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('upstream unreachable') ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed')
  ) {
    return translateAppText(
      'Le serveur de calcul d’itinéraire est temporairement inaccessible. Veuillez réessayer.',
    );
  }

  // 7. Profil personnalisé / compilation
  if (
    lower.includes('upload') &&
    (lower.includes('profile') || lower.includes('profileid'))
  ) {
    return translateAppText(
      'Erreur dans le profil de traçage personnalisé. Vérifiez vos paramètres.',
    );
  }

  // 8. BRouter HTTP 422 générique
  if (lower.includes('422') || lower.includes('unprocessable entity')) {
    return translateAppText(
      'Impossible de calculer l’itinéraire : vérifiez l’emplacement de vos points et des zones interdites.',
    );
  }

  // 9. Si le message commence déjà par un texte utilisateur propre, on le garde
  if (
    rawMessage.startsWith('Impossible de') ||
    rawMessage.startsWith('Le calcul')
  ) {
    return translateAppText(rawMessage);
  }

  // 10. Fallback propre sans mentionner BRouter HTTP 422 / stack trace
  return translateAppText(
    'Impossible de calculer l’itinéraire pour ces points.',
  );
}
