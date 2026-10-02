// Encodages compacts partagés par les index Japon / NZ.

/** Masque binaire → hex, 4 cellules par caractère (bit 0 = première cellule). */
export function maskToHex(mask) {
  let out = '';
  for (let i = 0; i < mask.length; i += 4) {
    out += ((mask[i] ?? 0) | ((mask[i + 1] ?? 0) << 1) | ((mask[i + 2] ?? 0) << 2) | ((mask[i + 3] ?? 0) << 3)).toString(16);
  }
  return out;
}

/** Arrondi à 1e-5° (~1 m) pour les polygones de couverture. */
export function roundLonLat([lon, lat]) {
  return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
}
