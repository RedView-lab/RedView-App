/**
 * Messages affichés sous la neige quand le champ ne peut pas être calculé :
 * sans l'analyse AROME il n'y a pas de champ de neige, et le mode revenait
 * sur « off » sans un mot. Textes sources traduits par l'observateur du DOM
 * du visualiseur (paires dans translations/lidar.ts). Module sans dépendance :
 * le moteur terrain l'importe sans tirer le pipeline neige.
 */
export const SNOW_UNAVAILABLE_MESSAGE =
  'Hauteur de neige indisponible ici pour le moment : l’analyse Météo-France n’a pas pu être chargée, ou ce secteur est hors de sa couverture.';

/** /api/meteofrance en 503 : la source n'est pas encore active sur ce serveur (clé absente). */
export const SNOW_SOURCE_INACTIVE_MESSAGE =
  'Hauteur de neige pas encore disponible : la source Météo-France n’est pas active pour le moment.';

/** Message pour une erreur du pipeline neige (`AromeFetchError` reconnue sans l'importer). */
export function snowUnavailableMessage(error: unknown): string {
  const failure = error as { name?: unknown; status?: unknown } | null;
  return failure?.name === 'AromeFetchError' && failure.status === 503
    ? SNOW_SOURCE_INACTIVE_MESSAGE
    : SNOW_UNAVAILABLE_MESSAGE;
}
