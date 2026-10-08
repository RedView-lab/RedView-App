// ============================================
// Direction du soleil dans le repère de rendu du viewer
// ============================================
//
// Les axes de la scène suivent la grille du CRS (+X est, +Y haut, +Z sud), pas
// le nord vrai : un azimut vrai est tourné du gisement du nord vrai au centre
// de la scène (`trueNorthGridBearingDeg`) avant toute géométrie.

const DEG = Math.PI / 180;

/**
 * Vecteur unitaire vers le soleil dans le repère de rendu.
 * @param azimuthDeg azimut vrai, dans le sens horaire depuis le nord
 * @param altitudeDeg hauteur au-dessus de l'horizon
 * @param trueNorthGridBearingDeg ajouté aux azimuts vrais pour obtenir les azimuts de grille
 */
export function sunDirectionFromAzAlt(
  azimuthDeg: number,
  altitudeDeg: number,
  trueNorthGridBearingDeg = 0,
): [number, number, number] {
  const az = (azimuthDeg + trueNorthGridBearingDeg) * DEG;
  const alt = altitudeDeg * DEG;
  const cosAlt = Math.cos(alt);
  return [cosAlt * Math.sin(az), Math.sin(alt), -cosAlt * Math.cos(az)];
}
