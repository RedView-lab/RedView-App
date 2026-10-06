/**
 * Horodatage de l'image en cours, commun à tout ce qui échantillonne ou
 * rejoue la présence en direct dans une même image.
 *
 * Pendant une image, `document.timeline.currentTime` vaut l'horodatage passé
 * aux rappels `requestAnimationFrame` (et à `_render` de Mapbox) : la caméra
 * dessinée, l'événement `render` et la boucle des curseurs lisent alors le
 * même instant. `performance.now()`, lui, avance pendant le rendu (3 à 10 ms) :
 * deux lecteurs de la même horloge de lecture dans la même image la
 * décaleraient, et un échantillon horodaté à l'envoi (minuterie, après le
 * rendu) porterait une vitesse fausse — à-coups chez celui qui suit.
 *
 * Hors image (minuterie, message réseau, page au repos : la timeline n'avance
 * plus), `performance.now()`.
 */

/** Au-delà, la dernière image est trop ancienne pour dater l'instant présent (≈ 2 images à 60 Hz). */
const STALE_FRAME_MS = 34;

export function frameTimestamp(): number {
  const now = performance.now();
  const current = typeof document !== 'undefined' ? document.timeline?.currentTime : null;
  if (typeof current !== 'number' || !Number.isFinite(current)) return now;
  return current <= now && now - current < STALE_FRAME_MS ? current : now;
}
